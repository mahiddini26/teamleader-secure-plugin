import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ID = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const TASK_DATE = z.iso.date();
const DATETIME = z.iso.datetime({ offset: true });
const PAGE = z.object({ number: z.number().int().min(1).max(1000).default(1), size: z.number().int().min(1).max(20).default(20) }).default({ number: 1, size: 20 });
const CONFIRMED = z.literal(true).describe("The user has authorized this exact task operation and its values.");
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
type RecordValue = Record<string, any>;
export type TaskApi = (endpoint: string, body?: Record<string, unknown>) => Promise<unknown>;
const data = (response: unknown): RecordValue => (response as { data?: RecordValue })?.data ?? {};
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export const TASK_UPDATE = z.object({
	id: ID,
	title: z.string().trim().min(1).max(255).optional(),
	description: z.string().max(50_000).optional(),
	due_on: TASK_DATE.optional(),
	work_type_id: ID.optional(),
	estimated_duration_minutes: z.number().int().min(0).max(1440).optional(),
	assignee: z.object({ type: z.enum(["user", "team"]), id: ID }).nullable().optional(),
	customer: z.object({ type: z.enum(["contact", "company"]), id: ID }).optional(),
	deal_id: ID.nullable().optional(),
	ticket_id: ID.nullable().optional(),
	project_id: ID.nullable().optional(),
	confirmed: CONFIRMED,
});

async function getTask(call: TaskApi, id: string) {
	const task = data(await call("tasks.info", { id }));
	if (task.id !== id) throw new Error("Teamleader did not return the requested task");
	return task;
}

export async function updateTask(call: TaskApi, requireWrite: () => void, input: z.infer<typeof TASK_UPDATE>) {
	input = TASK_UPDATE.parse(input);
	requireWrite();
	const { confirmed: _confirmed, estimated_duration_minutes, ...fields } = input;
	if (Object.keys(fields).length === 1 && estimated_duration_minutes === undefined) throw new Error("No task changes supplied");
	await getTask(call, input.id);
	if (input.work_type_id) {
		const refs = data(await call("workTypes.list", { filter: { ids: [input.work_type_id] }, page: { number: 1, size: 1 } }));
		if (!Array.isArray(refs) || !refs.some(r => r.id === input.work_type_id)) throw new Error("Work type not found");
	}
	if (input.assignee?.type === "user") await call("users.info", { id: input.assignee.id });
	if (input.assignee?.type === "team") {
		const refs = data(await call("teams.list", { filter: { ids: [input.assignee.id] } }));
		if (!Array.isArray(refs) || !refs.some(r => r.id === input.assignee!.id)) throw new Error("Team not found");
	}
	if (input.customer) await call(input.customer.type === "company" ? "companies.info" : "contacts.info", { id: input.customer.id });
	for (const [field, endpoint] of [["deal_id", "deals.info"], ["ticket_id", "tickets.info"], ["project_id", "projects-v2/projects.info"]] as const) {
		if (input[field]) await call(endpoint, { id: input[field] });
	}
	const payload: RecordValue = { ...fields, ...(estimated_duration_minutes !== undefined ? { estimated_duration: { unit: "min", value: estimated_duration_minutes } } : {}) };
	await call("tasks.update", payload);
	const verified = await getTask(call, input.id);
	const mismatches: string[] = [];
	for (const [key, expected] of Object.entries(payload)) {
		if (key === "id") continue;
		const actual = verified[key.endsWith("_id") ? key.slice(0, -3) : key];
		const matches = key.endsWith("_id") ? (actual?.id ?? null) === expected
			: expected && typeof expected === "object" ? Object.entries(expected).every(([k, v]) => actual?.[k] === v)
			: actual === expected;
		if (!matches) mismatches.push(key);
	}
	return { ok: mismatches.length === 0, id: input.id, mismatches, verified };
}

export async function setTaskCompleted(call: TaskApi, requireWrite: () => void, id: string, completed: boolean) {
	requireWrite();
	const before = await getTask(call, id);
	if (before.completed === completed) return { ok: true, changed: false, verified: before };
	await call(completed ? "tasks.complete" : "tasks.reopen", { id });
	const verified = await getTask(call, id);
	return { ok: verified.completed === completed, changed: true, verified };
}

export function validateTaskInterval(starts_at: string, ends_at: string) {
	DATETIME.parse(starts_at);
	DATETIME.parse(ends_at);
	if (Date.parse(ends_at) <= Date.parse(starts_at)) throw new Error("ends_at must be after starts_at");
}

export async function scheduleTask(call: TaskApi, requireWrite: () => void, id: string, starts_at: string, ends_at: string) {
	requireWrite();
	validateTaskInterval(starts_at, ends_at);
	const task = await getTask(call, id);
	if (task.completed) throw new Error("Reopen this completed task before scheduling it");
	if (!task.assignee) throw new Error("Assign the task before scheduling it");
	// Check existing task slots first so a repeated request cannot create the same slot twice.
	const existing = data(await call("events.list", { filter: { task_id: id, ends_after: starts_at, starts_before: ends_at }, page: { number: 1, size: 20 } }));
	const duplicate = Array.isArray(existing) && existing.find(e => e.task?.id === id && Date.parse(e.starts_at) === Date.parse(starts_at) && Date.parse(e.ends_at) === Date.parse(ends_at));
	if (duplicate) return { ok: true, changed: false, event: duplicate, notification_programmed: false };
	const created = data(await call("tasks.schedule", { id, starts_at, ends_at }));
	if (!created.id) throw new Error("Task scheduling returned no event ID; inspect task events before retrying");
	const event = data(await call("events.info", { id: created.id }));
	return { ok: event.task?.id === id && Date.parse(event.starts_at) === Date.parse(starts_at) && Date.parse(event.ends_at) === Date.parse(ends_at), changed: true, event, notification_programmed: false };
}

export function registerTaskManagement(server: McpServer, call: TaskApi, requireWrite: () => void) {
	server.tool("get_task_capabilities", "Report the task functions and API limitations of this connector. This is feature metadata, not proof of OAuth access or successful live tests.", {}, READ, async () => result({
		version: "0.8.5", tasks: ["list", "get", "create", "update", "complete", "reopen", "delete", "schedule"],
		calendar: ["list_task_events", "reschedule_task_event", "cancel_task_event"],
		attachments: "Use list_task_attachments to resolve the linked ticket, then upload_ticket_attachment. The PDF is stored on the ticket, not the task. No direct task upload in the documented API.",
		reminders: "Calendar scheduling is supported. Configurable notification reminders and recurrence are not exposed by the documented tasks API. A separate Codex reminder must be requested and created explicitly.",
		required_teamleader_scopes: ["tasks", "events"],
	}));
	server.tool("list_teams", "List available teams for task assignment.", {}, READ, async () => result(await call("teams.list")));
	server.tool("update_task", "Update an exact task, including its due date, duration, assignee or links. Use the user's explicit instruction as authorization when the exact task and values are clear; ask only for missing or ambiguous values. Re-read and compare the result.", TASK_UPDATE.shape, WRITE, async input => result(await updateTask(call, requireWrite, input)));
	for (const [name, complete] of [["complete_task", true], ["reopen_task", false]] as const) {
		server.tool(name, `${complete ? "Complete" : "Reopen"} the exact task requested by the user. Read it first; set confirmed only for an explicitly authorized operation.`, { id: ID, confirmed: CONFIRMED }, WRITE, async ({ id }) => result(await setTaskCompleted(call, requireWrite, id, complete)));
	}
	server.tool("delete_task", "Permanently delete one exact task. Retrieve it and obtain explicit confirmation of this exact deletion immediately before calling. Does not delete the linked customer, ticket or deal.", { id: ID, confirmed: CONFIRMED }, { ...WRITE, destructiveHint: true }, async ({ id }) => {
		requireWrite();
		await getTask(call, id);
		await call("tasks.delete", { id });
		const remaining = data(await call("tasks.list", { filter: { ids: [id] }, page: { number: 1, size: 1 } }));
		return result({ ok: Array.isArray(remaining) && remaining.length === 0, id, deleted: Array.isArray(remaining) && remaining.length === 0 });
	});
	server.tool("schedule_task", "Schedule the exact task in the Teamleader calendar using ISO datetimes with explicit timezone offsets. Requires tasks and events scopes. This does NOT configure a reminder notification. Use the user's explicit task and time instruction as authorization.", { id: ID, starts_at: DATETIME, ends_at: DATETIME, confirmed: CONFIRMED }, WRITE, async ({ id, starts_at, ends_at }) => result(await scheduleTask(call, requireWrite, id, starts_at, ends_at)));
	server.tool("list_task_events", "List calendar slots for one exact task. Requires events scope.", { id: ID, page: PAGE }, READ, async ({ id, page }) => {
		await getTask(call, id);
		return result(await call("events.list", { filter: { task_id: id }, page }));
	});
	server.tool("reschedule_task_event", "Move one exact calendar slot belonging to the requested task. Use list_task_events to select event_id. Does not alter the task due date or configure notifications.", { id: ID, event_id: ID, starts_at: DATETIME, ends_at: DATETIME, confirmed: CONFIRMED }, WRITE, async ({ id, event_id, starts_at, ends_at }) => {
		requireWrite();
		validateTaskInterval(starts_at, ends_at);
		await getTask(call, id);
		const before = data(await call("events.info", { id: event_id }));
		if (before.task?.id !== id) throw new Error("Calendar event does not belong to the selected task");
		await call("events.update", { id: event_id, starts_at, ends_at });
		const event = data(await call("events.info", { id: event_id }));
		return result({ ok: event.task?.id === id && Date.parse(event.starts_at) === Date.parse(starts_at) && Date.parse(event.ends_at) === Date.parse(ends_at), event, notification_programmed: false });
	});
	server.tool("cancel_task_event", "Cancel only the exact calendar slot of the selected task, without deleting or completing the task. Obtain explicit authorization for the exact slot.", { id: ID, event_id: ID, confirmed: CONFIRMED }, WRITE, async ({ id, event_id }) => {
		requireWrite();
		await getTask(call, id);
		const event = data(await call("events.info", { id: event_id }));
		if (event.task?.id !== id) throw new Error("Calendar event does not belong to the selected task");
		await call("events.cancel", { id: event_id });
		const remaining = data(await call("events.list", { filter: { ids: [event_id], task_id: id }, page: { number: 1, size: 1 } }));
		return result({ ok: Array.isArray(remaining) && remaining.length === 0, id, event_id });
	});
	server.tool("list_task_attachments", "Resolve one task's linked ticket and list that ticket's files. These are shared ticket files, not files attached directly to the task. Use the returned ticket_id with upload_ticket_attachment only after the user approves that destination.", { id: ID, page: PAGE }, READ, async ({ id, page }) => {
		const task = await getTask(call, id);
		const ticket_id = task.ticket?.id;
		if (!ticket_id) return result({ task_id: id, supported: false, reason: "No linked ticket. Link an existing ticket with update_task before using ticket attachment tools." });
		await call("tickets.info", { id: ticket_id });
		return result({ task_id: id, ticket_id, storage: "linked_ticket", files: await call("files.list", { filter: { subject: { type: "ticket", id: ticket_id } }, page }) });
	});
}
