import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskManagement, updateTask, setTaskCompleted, scheduleTask, TASK_UPDATE, TASK_DATE, validateTaskInterval, type TaskApi } from "../src/task-management.ts";

test("invalid dates and intervals are rejected, including impossible dates", () => {
	assert.equal(TASK_DATE.safeParse("2026-02-30").success, false);
	assert.equal(TASK_DATE.safeParse("2028-02-29").success, true);
	assert.throws(() => validateTaskInterval("2026-09-14T09:00:00", "2026-09-14T10:00:00"));
	assert.throws(() => validateTaskInterval("2026-09-14T10:00:00+02:00", "2026-09-14T09:00:00+02:00"), /after/);
});

test("task update preserves empty descriptions, null links and zero duration; verifies readback", async () => {
	let task: any = { id: "task-1", description: "before", due_on: "2026-09-13", assignee: { type: "user", id: "user-1" }, ticket: { id: "ticket-1" } };
	let sent: any;
	const call: TaskApi = async (endpoint, body) => {
		if (endpoint === "tasks.info") return { data: task };
		assert.equal(endpoint, "tasks.update");
		sent = body;
		task = { ...task, ...body, ticket: null };
		return null;
	};
	const response = await updateTask(call, () => {}, { id: "task-1", description: "", due_on: "2026-09-14", assignee: null, ticket_id: null, estimated_duration_minutes: 0, confirmed: true });
	assert.equal(response.ok, true);
	assert.deepEqual(sent, { id: "task-1", description: "", due_on: "2026-09-14", assignee: null, ticket_id: null, estimated_duration: { unit: "min", value: 0 } });
});

test("silent upstream update failure is reported rather than declared successful", async () => {
	const call: TaskApi = async () => ({ data: { id: "task-1", title: "old" } });
	const response = await updateTask(call, () => {}, { id: "task-1", title: "new", confirmed: true });
	assert.equal(response.ok, false);
	assert.deepEqual(response.mismatches, ["title"]);
});

test("write denial occurs before any API request", async () => {
	let calls = 0;
	const call: TaskApi = async () => { calls++; return {}; };
	const deny = () => { throw new Error("write denied"); };
	await assert.rejects(updateTask(call, deny, { id: "task-1", title: "new", confirmed: true }), /write denied/);
	await assert.rejects(setTaskCompleted(call, deny, "task-1", true), /write denied/);
	await assert.rejects(scheduleTask(call, deny, "task-1", "2026-09-14T09:00:00+02:00", "2026-09-14T10:00:00+02:00"), /write denied/);
	assert.equal(calls, 0);
});

test("completion and reopening are verified and repeat requests are idempotent", async () => {
	const task = { id: "task-1", completed: false };
	const writes: string[] = [];
	const call: TaskApi = async endpoint => {
		if (endpoint === "tasks.info") return { data: { ...task } };
		writes.push(endpoint);
		task.completed = endpoint === "tasks.complete";
		return null;
	};
	assert.equal((await setTaskCompleted(call, () => {}, "task-1", true)).ok, true);
	assert.equal((await setTaskCompleted(call, () => {}, "task-1", true)).changed, false);
	assert.equal((await setTaskCompleted(call, () => {}, "task-1", false)).ok, true);
	assert.deepEqual(writes, ["tasks.complete", "tasks.reopen"]);
});

test("scheduling reads the event back and does not claim a reminder was created", async () => {
	const starts_at = "2026-09-14T09:00:00+02:00", ends_at = "2026-09-14T10:00:00+02:00";
	let scheduled = false, writes = 0;
	const event = { id: "event-1", task: { id: "task-1" }, starts_at: "2026-09-14T07:00:00Z", ends_at: "2026-09-14T08:00:00Z" };
	const call: TaskApi = async endpoint => {
		if (endpoint === "tasks.info") return { data: { id: "task-1", completed: false, assignee: { id: "user-1" } } };
		if (endpoint === "events.list") return { data: scheduled ? [event] : [] };
		if (endpoint === "tasks.schedule") { writes++; scheduled = true; return { data: { id: "event-1" } }; }
		assert.equal(endpoint, "events.info"); return { data: event };
	};
	const response = await scheduleTask(call, () => {}, "task-1", starts_at, ends_at);
	assert.equal(response.ok, true);
	assert.equal(response.notification_programmed, false);
	assert.equal((await scheduleTask(call, () => {}, "task-1", starts_at, ends_at)).changed, false);
	assert.equal(writes, 1);
});

test("MCP discovery exposes task tools and rejects missing confirmation and unrelated events", async () => {
	const server = new McpServer({ name: "test", version: "1" });
	const writes: string[] = [];
	const call: TaskApi = async endpoint => {
		if (endpoint === "tasks.info") return { data: { id: "task-1", completed: false } };
		if (endpoint === "events.info") return { data: { id: "event-1", task: { id: "other-task" } } };
		writes.push(endpoint); return { data: [] };
	};
	registerTaskManagement(server, call, () => {});
	const client = new Client({ name: "test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		const names = (await client.listTools()).tools.map(t => t.name);
		assert.ok(names.includes("update_task") && names.includes("schedule_task") && names.includes("list_task_attachments"));
		const rejected = await client.callTool({ name: "complete_task", arguments: { id: "task-1" } });
		assert.equal(rejected.isError, true);
		const unrelated = await client.callTool({ name: "cancel_task_event", arguments: { id: "task-1", event_id: "event-1", confirmed: true } });
		assert.equal(unrelated.isError, true);
		assert.deepEqual(writes, []);
		const attachments: any = await client.callTool({ name: "list_task_attachments", arguments: { id: "task-1" } });
		assert.equal(JSON.parse(attachments.content[0].text).supported, false);
	} finally { await client.close(); await server.close(); }
});
