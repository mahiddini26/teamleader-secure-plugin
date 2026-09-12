import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { buildDraftInvoicePayload } from "./invoice";
import { buildTaskCreatePayload, checkTaskDuplicate } from "./task";
import { registerTaskManagement, TASK_DATE } from "./task-management";
import { TeamleaderHandler } from "./teamleader-handler";
import { assertSafeInternalMessageHtml, assertWriteScope, readResponseWithLimit } from "./safety";
import { deleteToken, teamleaderCall, uploadTeamleaderFile, type Props } from "./utils";

const PAGE = z.object({
	number: z.number().int().min(1).max(1000).default(1),
	size: z.number().int().min(1).max(20).default(20),
}).default({ number: 1, size: 20 });

const CONTACT_SEARCH = {
	term: z.string().trim().min(2).max(100).optional().describe(
		"Name, company, email address, or telephone number to search for. Use the full known name when possible.",
	),
	page: PAGE,
};

const TEAMLEADER_ID = z.string().trim().min(1).max(100).regex(
	/^[a-zA-Z0-9_-]+$/,
	"Invalid Teamleader identifier",
).describe("Exact Teamleader identifier; both current UUIDs and historical IDs are accepted.");

const FILE_NAME = z.string().trim().min(1).max(255).regex(
	/^[^/\\\u0000-\u001f]+\.[a-zA-Z0-9]{1,12}$/,
	"The file name must be a plain name with an extension",
);

const EXTRACTABLE_MIME_TYPES = new Set([
	"application/pdf",
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/svg+xml",
	"image/gif",
	"image/bmp",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-excel",
	"text/csv",
]);

const MAX_EXTRACTION_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTION_BATCH_BYTES = 40 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BASE64_CHARACTERS = 28_000_000;
const DEFAULT_EXTRACTED_TEXT_LIMIT = 100_000;

type TeamleaderFile = {
	id: string;
	name: string;
	mimeType: string;
	size?: number;
	location: string;
};

function isTrustedTeamleaderFileHost(hostname: string) {
	return hostname === "teamleader.s3.eu-west-1.amazonaws.com" ||
		hostname === "teamleader.eu" || hostname.endsWith(".teamleader.eu");
}

function decodeBase64(value: string) {
	const normalized = value.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
		throw new Error("Invalid base64 file content");
	}
	const binary = atob(normalized);
	if (binary.length === 0) throw new Error("The file is empty");
	if (binary.length > MAX_UPLOAD_FILE_BYTES) throw new Error("The file exceeds the 20 MB safety limit");
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[character]!));
}

export class TeamleaderMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "APA Teamleader Secure", version: "0.8.5" });

	async init() {
		registerTaskManagement(this.server, (endpoint, body) => teamleaderCall(this.env, this.props!.userId, endpoint, body), () => this.requireWriteScope());
		this.server.tool(
			"disconnect_teamleader",
			"Disconnect Teamleader and immediately delete the stored Teamleader access and refresh tokens. This stops all subsequent Teamleader access until the user reconnects. Call only after the user explicitly asks to disconnect and confirms the deletion.",
			{
				confirm: z.literal(true).describe("Must be true after explicit user confirmation."),
			},
			{ readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			async () => {
				const userId = this.props!.userId;
				await deleteToken(this.env, userId);
				const grantList = await this.env.OAUTH_KV.list({ prefix: `grant:${userId}:` });
				let revokedChatGptGrants = 0;
				for (const key of grantList.keys) {
					const grant = await this.env.OAUTH_KV.get<{ clientId?: string; id?: string }>(
						key.name,
						"json",
					);
					if (!grant?.clientId?.startsWith("https://chatgpt.com/oauth/")) continue;
					const grantId = grant.id ?? key.name.slice(`grant:${userId}:`.length);
					let cursor: string | undefined;
					do {
						const tokens = await this.env.OAUTH_KV.list({
							prefix: `token:${userId}:${grantId}:`,
							cursor,
						});
						await Promise.all(tokens.keys.map((tokenKey) => this.env.OAUTH_KV.delete(tokenKey.name)));
						cursor = tokens.list_complete ? undefined : tokens.cursor;
					} while (cursor);
					await this.env.OAUTH_KV.delete(key.name);
					revokedChatGptGrants++;
				}
				return this.result({
					disconnected: true,
					revoked_chatgpt_grants: revokedChatGptGrants,
					message: "Stored Teamleader tokens and ChatGPT OAuth grants were deleted.",
				});
			},
		);

		this.server.tool(
			"get_current_user",
			"Return the authenticated Teamleader Focus user.",
			{},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async () => this.result(await teamleaderCall(this.env, this.props!.userId, "users.me")),
		);

		this.server.tool(
			"list_users",
			"Search Teamleader users by name, email address or function. Users are managed by Teamleader administrators, so this connector exposes them read-only.",
			{
				term: z.string().trim().min(2).max(100).optional(),
				status: z.array(z.enum(["active", "deactivated"])).min(1).max(2).optional(),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, status, page }) => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"users.list",
				{ ...(term || status ? { filter: { ...(term ? { term } : {}), ...(status ? { status } : {}) } } : {}), page },
			)),
		);

		this.server.tool(
			"get_user",
			"Get one Teamleader user by exact ID. Read-only.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "users.info", { id })),
		);

		this.server.tool(
			"list_work_types",
			"List Teamleader work types so an exact work_type_id can be selected before creating a task.",
			{ page: PAGE },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ page }) => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"workTypes.list",
				{ page },
			)),
		);

		this.server.tool(
			"list_tasks",
			"List Teamleader tasks using targeted filters. Use this before creating a task to check for likely duplicates for the same customer, assignee and due date.",
			{
				term: z.string().trim().min(2).max(255).optional(),
				user_id: TEAMLEADER_ID.nullable().optional(),
				customer_type: z.enum(["contact", "company"]).optional(),
				customer_id: TEAMLEADER_ID.optional(),
				completed: z.boolean().optional(),
				scheduled: z.boolean().optional(),
				due_from: TASK_DATE.optional(),
				due_by: TASK_DATE.optional(),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, user_id, customer_type, customer_id, completed, scheduled, due_from, due_by, page }) => {
				if (due_from && due_by && due_from > due_by) throw new Error("due_from must not be after due_by");
				if (Boolean(customer_type) !== Boolean(customer_id)) throw new Error("customer_type and customer_id must be provided together");
				const filter = {
					...(term ? { term } : {}),
					...(user_id !== undefined ? { user_id } : {}),
					...(customer_type && customer_id ? { customer: { type: customer_type, id: customer_id } } : {}),
					...(completed !== undefined ? { completed } : {}),
					...(scheduled !== undefined ? { scheduled } : {}),
					...(due_from ? { due_from } : {}),
					...(due_by ? { due_by } : {}),
				};
				return this.result(await teamleaderCall(this.env, this.props!.userId, "tasks.list", {
					...(Object.keys(filter).length ? { filter } : {}),
					page,
					sort: [{ field: "due_on", order: "asc" }],
				}));
			},
		);

		this.server.tool(
			"get_task",
			"Get one Teamleader task by its exact ID. Read-only.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "tasks.info", { id })),
		);

		this.server.tool(
			"create_task",
			"Create one Teamleader task after validating referenced records and checking for a likely duplicate. Use the user's explicit request as authorization when the title, due date, work type, assignee and links are clear. Ask only for missing or ambiguous values. Set confirmed=true only for an authorized creation. Re-read the created task.",
			{
				title: z.string().trim().min(1).max(255),
				description: z.string().max(50_000).optional(),
				due_on: TASK_DATE,
				work_type_id: TEAMLEADER_ID,
				estimated_duration_minutes: z.number().int().min(1).max(1440).optional(),
				assignee_type: z.enum(["user", "team"]).optional(),
				assignee_id: TEAMLEADER_ID.optional(),
				customer_type: z.enum(["contact", "company"]).optional(),
				customer_id: TEAMLEADER_ID.optional(),
				deal_id: TEAMLEADER_ID.optional(),
				ticket_id: TEAMLEADER_ID.optional(),
				project_id: TEAMLEADER_ID.optional(),
				confirmed: z.literal(true).describe("True only when the user explicitly authorized this exact task creation."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ title, description, due_on, work_type_id, estimated_duration_minutes, assignee_type, assignee_id, customer_type, customer_id, deal_id, ticket_id, project_id, confirmed: _confirmed }) => {
				this.requireWriteScope();
				if (Boolean(assignee_type) !== Boolean(assignee_id)) throw new Error("assignee_type and assignee_id must be provided together");
				if (Boolean(customer_type) !== Boolean(customer_id)) throw new Error("customer_type and customer_id must be provided together");
				const validateListedReference = async (endpoint: "workTypes.list" | "teams.list", id: string, label: string) => {
					const response = await teamleaderCall(this.env, this.props!.userId, endpoint, {
						filter: { ids: [id] },
						...(endpoint === "workTypes.list" ? { page: { number: 1, size: 1 } } : {}),
					}) as { data?: Array<{ id?: string }> };
					if (!response.data?.some((item) => item.id === id)) throw new Error(`${label} not found: ${id}`);
				};
				const validations: Array<Promise<unknown>> = [
					validateListedReference("workTypes.list", work_type_id, "Work type"),
				];
				if (assignee_type === "user" && assignee_id) validations.push(teamleaderCall(this.env, this.props!.userId, "users.info", { id: assignee_id }));
				if (assignee_type === "team" && assignee_id) validations.push(validateListedReference("teams.list", assignee_id, "Team"));
				if (customer_type && customer_id) validations.push(teamleaderCall(this.env, this.props!.userId, customer_type === "company" ? "companies.info" : "contacts.info", { id: customer_id }));
				if (deal_id) validations.push(teamleaderCall(this.env, this.props!.userId, "deals.info", { id: deal_id }));
				if (ticket_id) validations.push(teamleaderCall(this.env, this.props!.userId, "tickets.info", { id: ticket_id }));
				if (project_id) validations.push(teamleaderCall(this.env, this.props!.userId, "projects-v2/projects.info", { id: project_id }));
				const duplicateFilter = {
					due_from: due_on,
					due_by: due_on,
					...(assignee_type === "user" && assignee_id ? { user_id: assignee_id } : {}),
					...(customer_type && customer_id ? { customer: { type: customer_type, id: customer_id } } : {}),
				};
				const [, duplicate] = await Promise.all([
					Promise.all(validations),
					checkTaskDuplicate((endpoint, body) => teamleaderCall(this.env, this.props!.userId, endpoint, body), duplicateFilter, title, due_on, (value) => this.normalize(value)),
				]);
				if (duplicate?.id) throw new Error(`A task with the same title and due date already exists: ${duplicate.id}`);
				const created = await teamleaderCall(this.env, this.props!.userId, "tasks.create", buildTaskCreatePayload({
					title, description, due_on, work_type_id, estimated_duration_minutes,
					assignee_type, assignee_id, customer_type, customer_id, deal_id, ticket_id, project_id,
				})) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the created task ID");
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "tasks.info", { id }) });
			},
		);

		this.server.tool(
			"list_contacts",
			"Search authorized Teamleader contacts by name, company, email address, or telephone number. Always use this targeted search for a named contact; do not scan successive pages.",
			CONTACT_SEARCH,
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, page }) => this.result(term
				? await this.searchContacts(term, page)
				: await teamleaderCall(this.env, this.props!.userId, "contacts.list", { page })),
		);

		// Compatibility alias for clients that cached the earlier tool catalogue.
		this.server.tool(
			"search_contacts",
			"Search Teamleader contacts by name, company, email address, or telephone number.",
			{
				term: z.string().trim().min(2).max(100),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, page }) => this.result(await this.searchContacts(term, page)),
		);

		this.server.tool(
			"get_contact",
			"Get one Teamleader contact by its exact ID.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id })),
		);

		this.server.tool(
			"create_contact",
			"Create one Teamleader contact after a duplicate search. Ask the user to confirm the complete contact data immediately before setting confirmed=true.",
			{
				first_name: z.string().trim().min(1).max(255),
				last_name: z.string().trim().min(1).max(255),
				salutation: z.string().trim().max(100).optional(),
				email: z.string().email().optional(),
				telephone: z.string().trim().min(1).max(100).optional(),
				website: z.string().url().max(2048).optional(),
				language: z.enum(["fr", "en", "nl", "de", "es", "it", "pt"]).default("fr"),
				remarks: z.string().max(50_000).optional(),
				confirmed: z.literal(true).describe("True only after the user explicitly confirms this exact contact creation."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ confirmed: _confirmed, email, telephone, ...contact }) => {
				this.requireWriteScope();
				const term = [contact.first_name, contact.last_name].join(" ");
				const existing = await teamleaderCall(this.env, this.props!.userId, "contacts.list", {
					filter: { term }, page: { number: 1, size: 20 },
				}) as { data?: Array<{ id?: string; first_name?: string; last_name?: string; emails?: Array<{ email?: string }> }> };
				const duplicate = (existing.data || []).find((candidate) =>
					this.normalize(`${candidate.first_name || ""} ${candidate.last_name || ""}`) === this.normalize(term) ||
					Boolean(email && candidate.emails?.some((entry) => entry.email?.toLowerCase() === email.toLowerCase())),
				);
				if (duplicate?.id) throw new Error(`Contact already exists: ${duplicate.id}`);
				const created = await teamleaderCall(this.env, this.props!.userId, "contacts.add", {
					...contact,
					...(email ? { emails: [{ type: "primary", email }] } : {}),
					...(telephone ? { telephones: [{ type: "mobile", number: telephone }] } : {}),
				}) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the created contact ID");
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id }) });
			},
		);

		this.server.tool(
			"list_companies",
			"Search authorized Teamleader companies by name, VAT number, email address, or telephone number. Always use a targeted term; never scan successive company pages.",
			{
				term: z.string().trim().min(2).max(100).optional().describe(
					"Company name, VAT number, email address, or telephone number to search for.",
				),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, page }) => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"companies.list",
				term ? { filter: { term }, page } : { page },
			)),
		);

		// Compatibility alias for clients that cached the earlier tool catalogue.
		this.server.tool(
			"search_companies",
			"Search Teamleader companies by name, VAT number, email address, or telephone number.",
			{
				term: z.string().trim().min(2).max(100),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, page }) => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"companies.list",
				{ filter: { term }, page },
			)),
		);

		this.server.tool(
			"get_company",
			"Get one Teamleader company by its exact ID.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "companies.info", { id })),
		);

		// Preserve the misspelled historical name exposed by an older client schema.
		this.server.tool(
			"get_companie",
			"Get one Teamleader company by its exact ID.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "companies.info", { id })),
		);

		this.server.tool(
			"create_company",
			"Create one Teamleader company after checking for a duplicate name or national identification number. Ask the user to confirm the complete company data immediately before setting confirmed=true.",
			{
				name: z.string().trim().min(1).max(255),
				national_identification_number: z.string().trim().min(1).max(100).optional(),
				vat_number: z.string().trim().min(1).max(100).optional(),
				email: z.string().email().optional(),
				telephone: z.string().trim().min(1).max(100).optional(),
				website: z.string().url().max(2048).optional(),
				language: z.enum(["fr", "en", "nl", "de", "es", "it", "pt"]).default("fr"),
				remarks: z.string().max(50_000).optional(),
				confirmed: z.literal(true).describe("True only after the user explicitly confirms this exact company creation."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ confirmed: _confirmed, email, telephone, ...company }) => {
				this.requireWriteScope();
				const searches = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "companies.list", { filter: { term: company.name }, page: { number: 1, size: 20 } }),
					...(company.national_identification_number ? [teamleaderCall(this.env, this.props!.userId, "companies.list", { filter: { term: company.national_identification_number }, page: { number: 1, size: 20 } })] : []),
				]) as Array<{ data?: Array<{ id?: string; name?: string; national_identification_number?: string | null }> }>;
				const duplicate = searches.flatMap((search) => search.data || []).find((candidate) =>
					this.normalize(candidate.name || "") === this.normalize(company.name) ||
					Boolean(company.national_identification_number && this.normalize(candidate.national_identification_number || "") === this.normalize(company.national_identification_number)),
				);
				if (duplicate?.id) throw new Error(`Company already exists: ${duplicate.id}`);
				const created = await teamleaderCall(this.env, this.props!.userId, "companies.add", {
					...company,
					...(email ? { emails: [{ type: "primary", email }] } : {}),
					...(telephone ? { telephones: [{ type: "phone", number: telephone }] } : {}),
				}) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the created company ID");
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "companies.info", { id }) });
			},
		);

		this.server.tool(
			"update_contact_text",
			"Update approved text fields on one exact Teamleader contact. Retrieve the contact and ask the user to confirm the exact changes immediately before setting confirmed=true.",
			{
				id: TEAMLEADER_ID,
				first_name: z.string().max(255).nullable().optional(), last_name: z.string().min(1).max(255).optional(),
				salutation: z.string().max(100).nullable().optional(), website: z.string().max(2048).nullable().optional(),
				remarks: z.string().max(50_000).nullable().optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, confirmed: _confirmed, ...fields }) => {
				this.requireWriteScope();
				return this.updateText("contact", id, fields);
			},
		);

		this.server.tool(
			"update_contact_details",
			"Replace approved structured details on one exact Teamleader contact. Retrieve the contact first because emails, telephones and addresses are replaced entirely, then ask the user to confirm every replacement value immediately before setting confirmed=true.",
			{
				id: TEAMLEADER_ID,
				emails: z.array(z.object({
					type: z.literal("primary"),
					email: z.string().email().nullable(),
				})).max(10).optional(),
				telephones: z.array(z.object({
					type: z.enum(["phone", "mobile", "fax"]),
					number: z.string().trim().min(1).max(100),
				})).max(10).nullable().optional(),
				addresses: z.array(z.object({
					type: z.enum(["primary", "invoicing", "delivery", "visiting"]),
					address: z.object({
						line_1: z.string().max(255).nullable(),
						postal_code: z.string().max(50).nullable(),
						city: z.string().max(255).nullable(),
						country: z.string().length(2).regex(/^[A-Z]{2}$/),
						addressee: z.string().max(255).optional(),
					}),
				})).max(10).optional(),
				language: z.enum(["fr", "en", "nl", "de", "es", "it", "pt"]).optional(),
				gender: z.enum(["female", "male", "non_binary", "prefers_not_to_say", "unknown"]).nullable().optional(),
				birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
				iban: z.string().trim().max(64).nullable().optional(),
				bic: z.string().trim().max(32).nullable().optional(),
				national_identification_number: z.string().trim().max(100).nullable().optional(),
				marketing_mails_consent: z.boolean().optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, confirmed: _confirmed, ...fields }) => {
				this.requireWriteScope();
				const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
				if (Object.keys(changes).length === 0) throw new Error("At least one structured contact field must be provided");
				await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "contacts.update", { id, ...changes });
				const verified = await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id });
				return this.result({ ok: true, resource: "contact", id, updated_fields: Object.keys(changes), verified });
			},
		);

		this.server.tool(
			"update_company_text",
			"Update approved text fields on one exact Teamleader company. Retrieve the company and ask the user to confirm the exact changes immediately before setting confirmed=true.",
			{
				id: TEAMLEADER_ID, name: z.string().min(1).max(255).optional(), website: z.string().max(2048).nullable().optional(),
				remarks: z.string().max(50_000).nullable().optional(), confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, confirmed: _confirmed, ...fields }) => {
				this.requireWriteScope();
				return this.updateText("company", id, fields);
			},
		);

		this.server.tool(
			"update_company_details",
			"Replace approved structured company details on one exact Teamleader company. Retrieve the company first because emails, telephones and addresses are replaced entirely, then ask the user to confirm every replacement value immediately before setting confirmed=true.",
			{
				id: TEAMLEADER_ID,
				national_identification_number: z.string().trim().min(1).max(100).nullable().optional(),
				vat_number: z.string().trim().min(1).max(100).nullable().optional(),
				emails: z.array(z.object({
					type: z.enum(["primary", "invoicing"]),
					email: z.string().email(),
				})).max(10).optional(),
				telephones: z.array(z.object({
					type: z.enum(["phone", "fax"]),
					number: z.string().trim().min(1).max(100),
				})).max(10).optional(),
				addresses: z.array(z.object({
					type: z.enum(["primary", "invoicing", "delivery", "visiting"]),
					address: z.object({
						line_1: z.string().max(255).nullable(),
						postal_code: z.string().max(50).nullable(),
						city: z.string().max(255).nullable(),
						country: z.string().length(2).regex(/^[A-Z]{2}$/),
						addressee: z.string().max(255).optional(),
					}),
				})).max(10).optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, confirmed: _confirmed, ...fields }) => {
				this.requireWriteScope();
				const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
				if (Object.keys(changes).length === 0) throw new Error("At least one structured company field must be provided");
				await teamleaderCall(this.env, this.props!.userId, "companies.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "companies.update", { id, ...changes });
				const verified = await teamleaderCall(this.env, this.props!.userId, "companies.info", { id });
				return this.result({ ok: true, resource: "company", id, updated_fields: Object.keys(changes), verified });
			},
		);

		this.server.tool(
			"link_contact_to_company",
			"Link one exact existing contact to one exact existing company. Retrieve both records and ask the user to confirm the contact, company, position and decision-maker flag immediately before setting confirmed=true.",
			{
				contact_id: TEAMLEADER_ID,
				company_id: TEAMLEADER_ID,
				position: z.string().trim().max(255).optional(),
				decision_maker: z.boolean().optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ contact_id, company_id, position, decision_maker, confirmed: _confirmed }) => {
				this.requireWriteScope();
				await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id }),
					teamleaderCall(this.env, this.props!.userId, "companies.info", { id: company_id }),
				]);
				await teamleaderCall(this.env, this.props!.userId, "contacts.linkToCompany", {
					id: contact_id,
					company_id,
					...(position ? { position } : {}),
					...(decision_maker !== undefined ? { decision_maker } : {}),
				});
				const verified = await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id });
				return this.result({ ok: true, contact_id, company_id, verified });
			},
		);

		this.server.tool(
			"update_contact_company_link",
			"Update the position or decision-maker flag of one exact contact-company relation after explicit confirmation.",
			{
				contact_id: TEAMLEADER_ID,
				company_id: TEAMLEADER_ID,
				position: z.string().trim().max(255).optional(),
				decision_maker: z.boolean().optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ contact_id, company_id, position, decision_maker, confirmed: _confirmed }) => {
				this.requireWriteScope();
				if (position === undefined && decision_maker === undefined) throw new Error("At least one relation field must be provided");
				await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id }),
					teamleaderCall(this.env, this.props!.userId, "companies.info", { id: company_id }),
				]);
				await teamleaderCall(this.env, this.props!.userId, "contacts.updateCompanyLink", {
					id: contact_id,
					company_id,
					...(position !== undefined ? { position } : {}),
					...(decision_maker !== undefined ? { decision_maker } : {}),
				});
				return this.result({ ok: true, contact_id, company_id, verified: await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id }) });
			},
		);

		this.server.tool(
			"unlink_contact_from_company",
			"Remove one exact contact-company relation. This does not delete the contact or company. Retrieve both and ask for explicit confirmation immediately before setting confirmed=true.",
			{ contact_id: TEAMLEADER_ID, company_id: TEAMLEADER_ID, confirmed: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: true, openWorldHint: false },
			async ({ contact_id, company_id, confirmed: _confirmed }) => {
				this.requireWriteScope();
				await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id }),
					teamleaderCall(this.env, this.props!.userId, "companies.info", { id: company_id }),
				]);
				await teamleaderCall(this.env, this.props!.userId, "contacts.unlinkFromCompany", { id: contact_id, company_id });
				return this.result({ ok: true, contact_id, company_id, verified: await teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_id }) });
			},
		);

		this.server.tool(
			"list_deals",
			"Search Teamleader sales opportunities by title, reference or customer. Use a targeted term or exact customer whenever possible.",
			{
				term: z.string().trim().min(2).max(255).optional(),
				customer_type: z.enum(["contact", "company"]).optional(),
				customer_id: TEAMLEADER_ID.optional(),
				status: z.array(z.enum(["open", "won", "lost"])).min(1).max(3).optional(),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ term, customer_type, customer_id, status, page }) => {
				if (Boolean(customer_type) !== Boolean(customer_id)) throw new Error("customer_type and customer_id must be provided together");
				const filter = {
					...(term ? { term } : {}),
					...(customer_type && customer_id ? { customer: { type: customer_type, id: customer_id } } : {}),
					...(status ? { status } : {}),
				};
				return this.result(await teamleaderCall(this.env, this.props!.userId, "deals.list", {
					...(Object.keys(filter).length ? { filter } : {}), page,
				}));
			},
		);

		this.server.tool(
			"get_deal",
			"Get one Teamleader sales opportunity by exact ID.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "deals.info", { id })),
		);

		for (const [toolName, endpoint, label] of [
			["list_deal_phases", "dealPhases.list", "deal phases"],
			["list_deal_sources", "dealSources.list", "deal sources"],
			["list_deal_pipelines", "dealPipelines.list", "deal pipelines"],
		] as const) {
			this.server.tool(
				toolName,
				`List authorized Teamleader ${label}. Read-only.`,
				{ page: PAGE },
				{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				async ({ page }) => this.result(await teamleaderCall(this.env, this.props!.userId, endpoint, { page })),
			);
		}

		this.server.tool(
			"create_deal",
			"Create one Teamleader sales opportunity after checking for a likely duplicate. Retrieve the customer and reference lists, then ask the user to confirm every value immediately before setting confirmed=true.",
			{
				title: z.string().trim().min(1).max(255),
				summary: z.string().max(50_000).optional(),
				customer_type: z.enum(["contact", "company"]),
				customer_id: TEAMLEADER_ID,
				contact_person_id: TEAMLEADER_ID.optional(),
				source_id: TEAMLEADER_ID.optional(),
				department_id: TEAMLEADER_ID.optional(),
				responsible_user_id: TEAMLEADER_ID.optional(),
				phase_id: TEAMLEADER_ID.optional(),
				estimated_value: z.object({ amount: z.number().nonnegative().max(1_000_000_000), currency: z.enum(["BAM", "CAD", "CHF", "CLP", "CNY", "COP", "CZK", "DKK", "EUR", "GBP", "INR", "ISK", "JPY", "MAD", "MXN", "NOK", "PEN", "PLN", "RON", "SEK", "TRY", "USD", "ZAR"]) }).optional(),
				estimated_probability: z.number().min(0).max(1).optional(),
				estimated_closing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
				currency_exchange_rate: z.number().positive().max(1_000_000).optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ title, summary, customer_type, customer_id, contact_person_id, source_id, department_id, responsible_user_id, phase_id, estimated_value, estimated_probability, estimated_closing_date, currency_exchange_rate, confirmed: _confirmed }) => {
				this.requireWriteScope();
				const validations = [teamleaderCall(this.env, this.props!.userId, customer_type === "company" ? "companies.info" : "contacts.info", { id: customer_id })];
				if (contact_person_id) validations.push(teamleaderCall(this.env, this.props!.userId, "contacts.info", { id: contact_person_id }));
				if (department_id) validations.push(teamleaderCall(this.env, this.props!.userId, "departments.info", { id: department_id }));
				if (responsible_user_id) validations.push(teamleaderCall(this.env, this.props!.userId, "users.info", { id: responsible_user_id }));
				const [, duplicates] = await Promise.all([
					Promise.all(validations),
					teamleaderCall(this.env, this.props!.userId, "deals.list", { filter: { term: title, customer: { type: customer_type, id: customer_id } }, page: { number: 1, size: 20 } }),
				]) as [unknown, { data?: Array<{ id?: string; title?: string }> }];
				const duplicate = (duplicates.data || []).find((deal) => this.normalize(deal.title || "") === this.normalize(title));
				if (duplicate?.id) throw new Error(`A deal with the same title already exists for this customer: ${duplicate.id}`);
				if (currency_exchange_rate && !estimated_value) throw new Error("estimated_value is required when currency_exchange_rate is provided");
				const created = await teamleaderCall(this.env, this.props!.userId, "deals.create", {
					lead: { customer: { type: customer_type, id: customer_id }, ...(contact_person_id ? { contact_person_id } : {}) },
					title,
					...(summary ? { summary } : {}),
					...(source_id ? { source_id } : {}),
					...(department_id ? { department_id } : {}),
					...(responsible_user_id ? { responsible_user_id } : {}),
					...(phase_id ? { phase_id } : {}),
					...(estimated_value ? { estimated_value } : {}),
					...(estimated_probability !== undefined ? { estimated_probability } : {}),
					...(estimated_closing_date ? { estimated_closing_date } : {}),
					...(currency_exchange_rate && estimated_value ? { currency: { code: estimated_value.currency, exchange_rate: currency_exchange_rate } } : {}),
				}) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the created deal ID");
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "deals.info", { id }) });
			},
		);

		this.server.tool(
			"update_deal",
			"Update approved fields on one exact Teamleader sales opportunity. Retrieve it first and ask the user to confirm every change immediately before setting confirmed=true.",
			{
				id: TEAMLEADER_ID,
				title: z.string().trim().min(1).max(255).optional(),
				summary: z.string().max(50_000).nullable().optional(),
				source_id: TEAMLEADER_ID.nullable().optional(),
				department_id: TEAMLEADER_ID.nullable().optional(),
				responsible_user_id: TEAMLEADER_ID.nullable().optional(),
				estimated_value: z.object({ amount: z.number().nonnegative().max(1_000_000_000), currency: z.enum(["BAM", "CAD", "CHF", "CLP", "CNY", "COP", "CZK", "DKK", "EUR", "GBP", "INR", "ISK", "JPY", "MAD", "MXN", "NOK", "PEN", "PLN", "RON", "SEK", "TRY", "USD", "ZAR"]) }).nullable().optional(),
				estimated_probability: z.number().min(0).max(1).nullable().optional(),
				estimated_closing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
				currency_exchange_rate: z.number().positive().max(1_000_000).optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, currency_exchange_rate, confirmed: _confirmed, ...fields }) => {
				this.requireWriteScope();
				const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
				if (currency_exchange_rate && !fields.estimated_value) throw new Error("A non-null estimated_value is required when currency_exchange_rate is provided");
				if (Object.keys(changes).length === 0 && !currency_exchange_rate) throw new Error("At least one deal field must be provided");
				await teamleaderCall(this.env, this.props!.userId, "deals.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "deals.update", {
					id, ...changes,
					...(currency_exchange_rate && fields.estimated_value ? { currency: { code: fields.estimated_value.currency, exchange_rate: currency_exchange_rate } } : {}),
				});
				return this.result({ ok: true, id, updated_fields: Object.keys(changes), verified: await teamleaderCall(this.env, this.props!.userId, "deals.info", { id }) });
			},
		);

		this.server.tool(
			"move_deal",
			"Move one exact Teamleader opportunity to one exact phase after explicit confirmation.",
			{ id: TEAMLEADER_ID, phase_id: TEAMLEADER_ID, confirmed: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, phase_id, confirmed: _confirmed }) => {
				this.requireWriteScope();
				await teamleaderCall(this.env, this.props!.userId, "deals.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "deals.move", { id, phase_id });
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "deals.info", { id }) });
			},
		);

		this.server.tool(
			"mark_deal_won",
			"Mark one exact Teamleader opportunity as won after explicit confirmation.",
			{ id: TEAMLEADER_ID, confirmed: z.literal(true) },
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, confirmed: _confirmed }) => {
				this.requireWriteScope();
				await teamleaderCall(this.env, this.props!.userId, "deals.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "deals.win", { id });
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "deals.info", { id }) });
			},
		);

		this.server.tool(
			"mark_deal_lost",
			"Mark one exact Teamleader opportunity as lost, with an optional reason and explanation, after explicit confirmation.",
			{
				id: TEAMLEADER_ID,
				reason_id: TEAMLEADER_ID.optional(),
				extra_info: z.string().trim().max(50_000).optional(),
				confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ id, reason_id, extra_info, confirmed: _confirmed }) => {
				this.requireWriteScope();
				await teamleaderCall(this.env, this.props!.userId, "deals.info", { id });
				await teamleaderCall(this.env, this.props!.userId, "deals.lose", {
					id,
					...(reason_id ? { reason_id } : {}),
					...(extra_info ? { extra_info } : {}),
				});
				return this.result({ ok: true, id, verified: await teamleaderCall(this.env, this.props!.userId, "deals.info", { id }) });
			},
		);

		this.server.tool(
			"list_tickets",
			"List Teamleader tickets related to one exact contact or company ID. First locate the contact or company, then call this tool once; never scan successive ticket pages.",
			{
				related_type: z.enum(["contact", "company"]).optional(),
				related_id: TEAMLEADER_ID.optional().describe("Exact Teamleader contact or company ID."),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ related_type, related_id, page }) => {
				if (Boolean(related_type) !== Boolean(related_id)) throw new Error("related_type and related_id must be provided together");
				return this.result(await teamleaderCall(
					this.env,
					this.props!.userId,
					"tickets.list",
					related_type && related_id ? { filter: { relates_to: { type: related_type, id: related_id } }, page } : { page },
				));
			},
		);

		this.server.tool(
			"list_ticket_statuses",
			"List the Teamleader ticket statuses available to the authenticated account. Use this before creating a ticket so the user can confirm the exact initial status.",
			{},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async () => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"ticketStatus.list",
				{},
			)),
		);

		this.server.tool(
			"create_ticket",
			"Create one Teamleader ticket for one exact contact or company. Retrieve the customer and available ticket statuses first, check for a likely duplicate ticket, then ask the user to confirm the exact customer, subject, status, assignee and description immediately before setting confirmed=true. Automatic initial replies are always disabled.",
			{
				subject: z.string().trim().min(1).max(255),
				customer_type: z.enum(["contact", "company"]),
				customer_id: TEAMLEADER_ID,
				ticket_status_id: TEAMLEADER_ID,
				assignee_user_id: TEAMLEADER_ID.optional(),
				description: z.string().max(50_000).optional().describe("Ticket description using Markdown formatting."),
				confirmed: z.literal(true).describe("True only after the user explicitly confirms this exact ticket creation."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ subject, customer_type, customer_id, ticket_status_id, assignee_user_id, description, confirmed: _confirmed }) => {
				this.requireWriteScope();
				const normalizedSubject = subject.toLocaleUpperCase("fr-FR");
				const [customer, statuses, duplicate] = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, customer_type === "company" ? "companies.info" : "contacts.info", { id: customer_id }),
					teamleaderCall(this.env, this.props!.userId, "ticketStatus.list", {}),
					this.findDuplicateTicket(customer_type, customer_id, normalizedSubject),
				]) as [unknown, { data?: Array<{ id?: string; status?: string; label?: string }> }, { id?: string } | undefined];
				if (!(statuses.data || []).some((status) => status.id === ticket_status_id)) {
					throw new Error("The selected ticket status is not available in this Teamleader account");
				}
				if (duplicate?.id) throw new Error(`A ticket with the same subject already exists for this customer: ${duplicate.id}`);
				if (assignee_user_id) {
					await teamleaderCall(this.env, this.props!.userId, "users.info", { id: assignee_user_id });
				}
				const created = await teamleaderCall(this.env, this.props!.userId, "tickets.create", {
					subject: normalizedSubject,
					customer: { type: customer_type, id: customer_id },
					ticket_status_id,
					initial_reply: "disabled",
					...(assignee_user_id ? { assignee: { type: "user", id: assignee_user_id } } : {}),
					...(description ? { description } : {}),
				}) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the created ticket ID");
				const verified = await teamleaderCall(this.env, this.props!.userId, "tickets.info", { id });
				return this.result({ ok: true, id, customer, verified });
			},
		);

		this.server.tool(
			"add_ticket_internal_message",
			"Add one internal Teamleader message to one exact ticket, optionally attaching files that are already linked to that ticket. Retrieve the ticket and its file metadata first, then ask the user to confirm the exact ticket, message body and attachment names immediately before setting confirmed=true. This never sends a customer reply.",
			{
				ticket_id: TEAMLEADER_ID,
				body_html: z.string().trim().min(1).max(100_000).describe("Internal message body using safe HTML formatting."),
				attachment_ids: z.array(TEAMLEADER_ID).max(20).default([]),
				ticket_status_id: TEAMLEADER_ID.optional(),
				confirmed: z.literal(true).describe("True only after the user explicitly confirms this exact internal message and attachments."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ ticket_id, body_html, attachment_ids, ticket_status_id, confirmed: _confirmed }) => {
				this.requireWriteScope();
				assertSafeInternalMessageHtml(body_html);
				const ticket = await teamleaderCall(this.env, this.props!.userId, "tickets.info", { id: ticket_id });
				const uniqueAttachmentIds = [...new Set(attachment_ids)];
				await this.assertTicketAttachments(ticket_id, uniqueAttachmentIds);
				const message = await teamleaderCall(this.env, this.props!.userId, "tickets.addInternalMessage", {
					id: ticket_id,
					body: body_html,
					...(uniqueAttachmentIds.length ? { attachments: uniqueAttachmentIds } : {}),
					...(ticket_status_id ? { ticket_status_id } : {}),
				}) as { data?: { id?: string } };
				const messageId = message.data?.id;
				if (!messageId) throw new Error("Teamleader did not return the created internal message ID");
				const verifiedMessage = await teamleaderCall(
					this.env,
					this.props!.userId,
					"tickets.getMessage",
					{ message_id: messageId },
				);
				return this.result({ ok: true, ticket, message_id: messageId, verified_message: verifiedMessage });
			},
		);

		this.server.tool(
			"get_ticket",
			"Get one Teamleader ticket and up to 100 recent messages. Attachment links for up to 20 files are optional and disabled by default for speed. Set include_attachments=true only when temporary links are explicitly needed.",
			{
				id: TEAMLEADER_ID,
				include_attachments: z.boolean().default(false).describe(
					"Generate temporary links for up to 20 attachments. Use only when attached files are explicitly requested.",
				),
				extract_attachment_ids: z.array(TEAMLEADER_ID).max(20).optional().describe(
					"Optional attachment IDs from this ticket to extract internally. This compatibility path works even when the client has cached an older tool catalogue.",
				),
				max_characters_per_file: z.number().int().min(1_000).max(250_000).default(DEFAULT_EXTRACTED_TEXT_LIMIT),
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id, include_attachments, extract_attachment_ids, max_characters_per_file }) => {
				const [ticket, messages] = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "tickets.info", { id }),
					teamleaderCall(this.env, this.props!.userId, "tickets.listMessages", {
						id,
						page: { number: 1, size: 100 },
					}),
				]);
				const messageData = messages as {
					data?: Array<{ attachments?: Array<{ id?: string }> }>;
				};
				const attachmentIds = [...new Set(
					(messageData.data || [])
						.flatMap((message) => message.attachments || [])
						.map((attachment) => attachment.id)
						.filter((attachmentId): attachmentId is string => Boolean(attachmentId)),
				)].slice(0, 20);
				const extractionIds = [...new Set(extract_attachment_ids || [])];
				if (include_attachments && extractionIds.length > 0) {
					throw new Error("Request links or text extraction in separate calls to stay within Cloudflare safety limits");
				}
				const unknownExtractionId = extractionIds.find((attachmentId) => !attachmentIds.includes(attachmentId));
				if (unknownExtractionId) throw new Error(`Attachment ${unknownExtractionId} does not belong to this ticket page`);
				if (!include_attachments && extractionIds.length === 0) return this.result({ ticket, messages });

				const attachments = include_attachments ? (await Promise.all(attachmentIds.map(async (attachmentId) => {
					try {
						const [infoValue, downloadValue] = await Promise.all([
							teamleaderCall(this.env, this.props!.userId, "files.info", { id: attachmentId }),
							teamleaderCall(this.env, this.props!.userId, "files.download", { id: attachmentId }),
						]);
						const info = infoValue as {
							data?: { name?: string; mime_type?: string; size?: number };
						};
						const download = downloadValue as {
							data?: { location?: string; expires_at?: string };
						};
						const location = download.data?.location;
						if (!location) return null;
						const url = new URL(location);
						if (url.protocol !== "https:" || !isTrustedTeamleaderFileHost(url.hostname)) return null;
						return {
							id: attachmentId,
							name: info.data?.name || `Teamleader attachment ${attachmentId}`,
							mimeType: info.data?.mime_type,
							size: info.data?.size,
							expiresAt: download.data?.expires_at,
							uri: url.toString(),
						};
					} catch {
						return null;
					}
				}))).filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null) : [];
				const extractedAttachments = extractionIds.length > 0
					? await this.extractFiles(
							await Promise.all(extractionIds.map((attachmentId) => this.getTeamleaderFile(attachmentId, false))),
						max_characters_per_file,
					)
					: [];

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								ticket,
								messages,
								attachments: attachments.map(({ uri: _uri, ...metadata }) => metadata),
								extracted_attachments: extractedAttachments,
							}),
						},
						...attachments.map((attachment) => ({
							type: "resource_link" as const,
							uri: attachment.uri,
							name: attachment.name,
							mimeType: attachment.mimeType,
							size: attachment.size,
							description: `Temporary Teamleader attachment download; expires at ${attachment.expiresAt || "an unspecified time"}.`,
						})),
					],
				};
			},
		);

		this.server.tool(
			"get_tickets_batch",
			"Fast bulk read for several Teamleader tickets and their messages. When a question requires examining multiple tickets, call this tool once instead of calling get_ticket repeatedly. All reads run in parallel; attachments are not downloaded.",
			{
				ids: z.array(TEAMLEADER_ID).min(1).max(20).describe(
					"Exact IDs of up to 20 tickets returned by list_tickets.",
				),
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ ids }) => {
				const uniqueIds = [...new Set(ids)];
				const tickets = await Promise.all(uniqueIds.map(async (id) => {
					const [ticket, messages] = await Promise.all([
						teamleaderCall(this.env, this.props!.userId, "tickets.info", { id }),
						teamleaderCall(this.env, this.props!.userId, "tickets.listMessages", {
							id,
							page: { number: 1, size: 20 },
						}),
					]);
					return { id, ticket, messages };
				}));
				return this.result({ tickets });
			},
		);

		this.server.tool(
			"list_ticket_messages",
			"Read the messages of one exact Teamleader ticket, including message bodies and attachment references. Use the ticket ID returned by list_tickets or get_ticket. Read-only; request only the first page unless the user explicitly asks for more.",
			{
				id: TEAMLEADER_ID.describe("Exact Teamleader ticket ID."),
				message_type: z.enum(["customer", "internal", "thirdParty"]).optional().describe(
					"Optional message category. Omit to return all authorized message types.",
				),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id, message_type, page }) => this.result(await teamleaderCall(
				this.env,
				this.props!.userId,
				"tickets.listMessages",
				message_type ? { id, filter: { type: message_type }, page } : { id, page },
			)),
		);

		this.server.tool(
			"get_attachment_download",
			"Get metadata and a short-lived Teamleader download link for one exact attachment ID. Use attachment IDs returned by ticket messages. The link expires; open it immediately to inspect the document. Read-only.",
			{ id: TEAMLEADER_ID.describe("Exact Teamleader file ID from a ticket message attachment.") },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => {
				const [infoValue, downloadValue] = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "files.info", { id }),
					teamleaderCall(this.env, this.props!.userId, "files.download", { id }),
				]);
				const info = infoValue as {
					data?: { name?: string; mime_type?: string; size?: number; updated_at?: string };
				};
				const download = downloadValue as {
					data?: { location?: string; expires_at?: string };
				};
				const location = download.data?.location;
				if (!location) throw new Error("Teamleader did not return a download link");
					const url = new URL(location);
					if (url.protocol !== "https:" || !isTrustedTeamleaderFileHost(url.hostname)) {
						throw new Error("Teamleader returned an invalid download link");
					}

				const name = info.data?.name || `Teamleader attachment ${id}`;
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								name,
								mime_type: info.data?.mime_type,
								size: info.data?.size,
								updated_at: info.data?.updated_at,
								expires_at: download.data?.expires_at,
							}),
						},
						{
							type: "resource_link" as const,
							uri: url.toString(),
							name,
							mimeType: info.data?.mime_type,
							size: info.data?.size,
							description: "Temporary Teamleader attachment download; expires shortly.",
						},
					],
				};
			},
		);

		this.server.tool(
			"extract_attachment_text",
			"Download one exact Teamleader attachment internally and extract searchable text. Digital PDFs are parsed directly; scanned PDFs and images use Cloudflare AI document conversion/OCR. Prefer this tool over opening the browser. Read-only.",
			{
				id: TEAMLEADER_ID.describe("Exact Teamleader file ID from a ticket message attachment."),
				max_characters: z.number().int().min(1_000).max(250_000).default(DEFAULT_EXTRACTED_TEXT_LIMIT),
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id, max_characters }) => {
				const file = await this.getTeamleaderFile(id);
				const [extracted] = await this.extractFiles([file], max_characters);
				return this.result(extracted);
			},
		);

		this.server.tool(
			"extract_attachments_text",
			"Fast batch text extraction for up to 20 exact Teamleader attachments without persistent file storage. Digital PDFs are parsed directly; scanned PDFs and images use Cloudflare AI document conversion/OCR. Use batches instead of opening files one by one. Read-only.",
			{
				ids: z.array(TEAMLEADER_ID).min(1).max(20).describe("Exact Teamleader file IDs returned by ticket messages."),
				max_characters_per_file: z.number().int().min(1_000).max(250_000).default(DEFAULT_EXTRACTED_TEXT_LIMIT),
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ ids, max_characters_per_file }) => {
				const uniqueIds = [...new Set(ids)];
				// Fetch metadata for every file. Besides preserving the real name and MIME
				// type, this avoids dereferencing a null `files.info` result in
				// getTeamleaderFile and lets us enforce the declared per-file size limit
				// before downloading the batch.
				const files = await Promise.all(uniqueIds.map((id) => this.getTeamleaderFile(id)));
				return this.result({ files: await this.extractFiles(files, max_characters_per_file) });
			},
		);

		this.server.tool(
			"upload_ticket_attachment",
			"Upload one explicitly selected file to one exact Teamleader ticket and publish it in a verified internal activity note. Retrieve and show the exact ticket first, then ask the user to confirm the ticket, file name, MIME type and file size immediately before setting confirmed=true. This never sends a public reply or changes ticket status.",
			{
				ticket_id: TEAMLEADER_ID.describe("Exact Teamleader ticket ID."),
				file_name: FILE_NAME,
				mime_type: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
				content_base64: z.string().min(4).max(MAX_UPLOAD_BASE64_CHARACTERS).describe("Base64-encoded file content, without a data URL prefix; maximum decoded size is 20 MB."),
				folder: z.string().trim().min(1).max(255).optional(),
				confirmed: z.literal(true).describe("True only after the user explicitly confirms this exact ticket and file upload."),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ ticket_id, file_name, mime_type, content_base64, folder, confirmed: _confirmed }) => {
				this.requireWriteScope();
				const ticket = await teamleaderCall(this.env, this.props!.userId, "tickets.info", { id: ticket_id });
				const bytes = decodeBase64(content_base64);
				await uploadTeamleaderFile(this.env, this.props!.userId, {
					name: file_name,
					mimeType: mime_type,
					bytes,
					subject: { type: "ticket", id: ticket_id },
					folder,
				});
				const files = await teamleaderCall(this.env, this.props!.userId, "files.list", {
					filter: { subject: { type: "ticket", id: ticket_id } },
					page: { number: 1, size: 20 },
					sort: [{ field: "updated_at", order: "desc" }],
				}) as { data?: Array<{ id?: string; name?: string; size?: number; mime_type?: string }> };
				const verified = (files.data || []).find((file) => file.name === file_name && file.size === bytes.length);
				if (!verified?.id) throw new Error("Teamleader did not confirm the uploaded ticket attachment");
				const published = await teamleaderCall(this.env, this.props!.userId, "tickets.addInternalMessage", {
					id: ticket_id,
					body: `<p>PIÈCE JOINTE AJOUTÉE : ${escapeHtml(file_name)}</p>`,
					attachments: [verified.id],
				}) as { data?: { id?: string } };
				const messageId = published.data?.id;
				if (!messageId) throw new Error("Teamleader did not return the internal attachment activity ID");
				const verifiedMessage = await teamleaderCall(this.env, this.props!.userId, "tickets.getMessage", { message_id: messageId });
				return this.result({
					ok: true,
					ticket,
					attachment: { id: verified.id, name: verified.name, size: verified.size, mime_type: verified.mime_type },
					activity: { message_id: messageId, verified_message: verifiedMessage },
				});
			},
		);

		this.server.tool(
			"list_invoices",
			"List Teamleader invoices for one exact contact or company ID. First locate the customer, then call this tool once per exact matching customer; never scan successive invoice pages.",
			{
				customer_type: z.enum(["contact", "company"]).optional(),
				customer_id: TEAMLEADER_ID.optional().describe("Exact Teamleader contact or company ID."),
				page: PAGE,
			},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ customer_type, customer_id, page }) => {
				if (Boolean(customer_type) !== Boolean(customer_id)) throw new Error("customer_type and customer_id must be provided together");
				return this.result(await teamleaderCall(
					this.env,
					this.props!.userId,
					"invoices.list",
					customer_type && customer_id ? { filter: { customer: { type: customer_type, id: customer_id } }, page } : { page },
				));
			},
		);

		this.server.tool(
			"get_invoice",
			"Get one Teamleader invoice by its exact ID.",
			{ id: TEAMLEADER_ID },
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, "invoices.info", { id })),
		);

		this.server.tool(
			"list_invoice_settings",
			"List active departments, tax rates and payment terms required to prepare a draft invoice.",
			{},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async () => {
				const [departments, taxRates, paymentTerms] = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, "departments.list", { filter: { status: ["active"] }, page: { number: 1, size: 20 } }),
					teamleaderCall(this.env, this.props!.userId, "taxRates.list", { page: { number: 1, size: 100 } }),
					teamleaderCall(this.env, this.props!.userId, "paymentTerms.list"),
				]);
				return this.result({ departments, tax_rates: taxRates, payment_terms: paymentTerms });
			},
		);

		this.server.tool(
			"create_draft_invoice",
			"Create a draft invoice only. Retrieve the exact customer and settings, calculate totals, and ask the user to confirm every invoice detail immediately before setting confirmed=true.",
			{
				customer_type: z.enum(["contact", "company"]), customer_id: TEAMLEADER_ID, department_id: TEAMLEADER_ID,
				invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
				payment_term: z.discriminatedUnion("type", [z.object({ type: z.literal("cash") }), z.object({ type: z.enum(["end_of_month", "after_invoice_date"]), days: z.number().int().min(0).max(365) })]),
				currency: z.enum(["BAM", "CAD", "CHF", "CLP", "CNY", "COP", "CZK", "DKK", "EUR", "GBP", "INR", "ISK", "JPY", "MAD", "MXN", "NOK", "PEN", "PLN", "RON", "SEK", "TRY", "USD", "ZAR"]),
				currency_exchange_rate: z.number().positive().max(1_000_000).optional().describe("Exchange rate to the department currency. Omit when both currencies match; the connector will send 1."),
				purchase_order_number: z.string().max(255).optional(), note: z.string().max(50_000).optional(),
				project_id: TEAMLEADER_ID.optional(), document_template_id: TEAMLEADER_ID.optional(),
				lines: z.array(z.object({
					section_title: z.string().max(255).optional(), description: z.string().trim().min(1).max(2000),
					extended_description: z.string().max(50_000).optional(), quantity: z.number().positive().max(1_000_000),
					unit_price_excluding_tax: z.number().nonnegative().max(1_000_000_000), tax_rate_id: TEAMLEADER_ID,
					discount_percentage: z.number().min(0).max(100).optional(),
					unit_of_measure_id: TEAMLEADER_ID.optional(), product_category_id: TEAMLEADER_ID.optional(),
					product_id: TEAMLEADER_ID.optional(), withholding_tax_rate_id: TEAMLEADER_ID.optional(),
				})).min(1).max(200), confirmed: z.literal(true),
			},
			{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async ({ customer_type, customer_id, department_id, invoice_date, payment_term, currency, currency_exchange_rate, purchase_order_number, note, project_id, document_template_id, lines, confirmed: _confirmed }) => {
				this.requireWriteScope();
				const [, department, taxRates] = await Promise.all([
					teamleaderCall(this.env, this.props!.userId, customer_type === "company" ? "companies.info" : "contacts.info", { id: customer_id }),
					teamleaderCall(this.env, this.props!.userId, "departments.info", { id: department_id }),
					teamleaderCall(this.env, this.props!.userId, "taxRates.list", { page: { number: 1, size: 100 } }),
				]);
				const departmentData = (department as { data?: { currency?: string; status?: string } }).data;
				if (departmentData?.status !== "active") throw new Error("The selected Teamleader department is not active");
				const effectiveExchangeRate = departmentData?.currency === currency ? 1 : currency_exchange_rate;
				if (!effectiveExchangeRate) {
					throw new Error(`currency_exchange_rate is required when the invoice currency differs from the department currency (${departmentData?.currency || "unknown"})`);
				}
				const allowedTaxRateIds = new Set(((taxRates as { data?: Array<{ id?: string; department?: { id?: string } }> }).data || [])
					.filter((taxRate) => taxRate.department?.id === department_id)
					.flatMap((taxRate) => taxRate.id ? [taxRate.id] : []));
				const invalidTaxRateIds = [...new Set(lines.map((line) => line.tax_rate_id))]
					.filter((taxRateId) => !allowedTaxRateIds.has(taxRateId));
				if (invalidTaxRateIds.length > 0) {
					throw new Error(`Tax rate does not belong to the selected department: ${invalidTaxRateIds.join(", ")}`);
				}
				const payload = buildDraftInvoicePayload({
					customer_type, customer_id, department_id, invoice_date, payment_term, currency,
					currency_exchange_rate: effectiveExchangeRate,
					purchase_order_number, note, project_id, document_template_id, lines,
				});
				const created = await teamleaderCall(this.env, this.props!.userId, "invoices.draft", payload) as { data?: { id?: string }; id?: string };
				const id = created.data?.id || created.id;
				if (!id) throw new Error("Teamleader did not return the draft invoice ID");
				const verified = await teamleaderCall(this.env, this.props!.userId, "invoices.info", { id }) as { data?: { status?: string } };
				if (verified.data?.status !== "draft") throw new Error("The invoice was not verified as a draft");
				return this.result({ ok: true, id, status: "draft", verified });
			},
		);

		for (const resource of [
			"departments",
		] as const) {
			this.server.tool(
				`list_${resource}`,
				`List authorized Teamleader ${resource}. Use pagination and do not request more data than needed.`,
				{ page: PAGE },
				{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				async ({ page }) => this.result(await teamleaderCall(this.env, this.props!.userId, `${resource}.list`, { page })),
			);
			this.server.tool(
				`get_${resource.slice(0, -1)}`,
				`Get one Teamleader ${resource.slice(0, -1)} by its exact ID.`,
				{ id: TEAMLEADER_ID },
				{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, `${resource}.info`, { id })),
			);
		}
	}

	private result(value: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
	}

	private requireWriteScope() {
		assertWriteScope(this.props?.scopes);
	}

	private async getTeamleaderFile(id: string, includeMetadata = true): Promise<TeamleaderFile> {
		const [infoValue, downloadValue] = await Promise.all([
			includeMetadata ? teamleaderCall(this.env, this.props!.userId, "files.info", { id }) : Promise.resolve(null),
			teamleaderCall(this.env, this.props!.userId, "files.download", { id }),
		]);
		const info = infoValue as { data?: { name?: string; mime_type?: string; size?: number } };
		const download = downloadValue as { data?: { location?: string } };
		const location = download.data?.location;
		if (!location) throw new Error(`Teamleader did not return a download link for attachment ${id}`);
		const url = new URL(location);
		if (url.protocol !== "https:") throw new Error(`Teamleader returned an insecure download link for attachment ${id}`);
		if (!isTrustedTeamleaderFileHost(url.hostname)) {
			throw new Error(`Teamleader returned an unexpected download host for attachment ${id}`);
		}
		const mimeType = (info.data?.mime_type || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
		if (mimeType !== "application/octet-stream" && !EXTRACTABLE_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported attachment type for text extraction: ${mimeType}`);
		if (info.data?.size && info.data.size > MAX_EXTRACTION_FILE_BYTES) {
			throw new Error(`Attachment ${id} exceeds the 20 MB extraction limit`);
		}
		return {
			id,
			name: info.data?.name || `attachment-${id}`,
			mimeType,
			size: info.data?.size,
			location: url.toString(),
		};
	}

	private async extractFiles(files: TeamleaderFile[], maxCharacters: number) {
		const declaredBytes = files.reduce((total, file) => total + (file.size || 0), 0);
		if (declaredBytes > MAX_EXTRACTION_BATCH_BYTES) throw new Error("Attachment batch exceeds the 40 MB extraction limit");

		const documents: Array<{ name: string; blob: Blob }> = [];
		let downloadedBytes = 0;
		for (const file of files) {
			const response = await fetch(file.location);
			if (!response.ok) throw new Error(`Unable to download ${file.name}: HTTP ${response.status}`);
			const contentLength = Number(response.headers.get("content-length") || 0);
			if (contentLength > MAX_EXTRACTION_FILE_BYTES) throw new Error(`${file.name} exceeds the 20 MB extraction limit`);
			if (downloadedBytes + contentLength > MAX_EXTRACTION_BATCH_BYTES) throw new Error("Attachment batch exceeds the 40 MB extraction limit");
			const bytes = await readResponseWithLimit(response, MAX_EXTRACTION_FILE_BYTES);
			downloadedBytes += bytes.byteLength;
			if (downloadedBytes > MAX_EXTRACTION_BATCH_BYTES) throw new Error("Downloaded attachment batch exceeds the 40 MB extraction limit");
			const responseMimeType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
			const mimeType = file.mimeType === "application/octet-stream" ? responseMimeType : file.mimeType;
			if (!EXTRACTABLE_MIME_TYPES.has(mimeType)) throw new Error(`Unsupported attachment type for text extraction: ${mimeType || "unknown"}`);
			file.mimeType = mimeType;
			documents.push({ name: file.name, blob: new Blob([bytes], { type: mimeType }) });
		}

		const convertedValue = await this.env.AI.toMarkdown(documents, {
			conversionOptions: {
				pdf: { metadata: false },
				image: { descriptionLanguage: "fr" },
			},
		});
		const converted = Array.isArray(convertedValue) ? convertedValue : [convertedValue];
		return files.map((file, index) => {
			const item = converted[index];
			if (!item || item.format === "error") {
				return { id: file.id, name: file.name, mime_type: file.mimeType, ok: false, error: item?.error || "Text extraction failed" };
			}
			const text = item.data || "";
			const likelyUnrecognizedScan = file.mimeType === "application/pdf" && text.trim().length < 40;
			return {
				id: file.id,
				name: file.name,
				mime_type: file.mimeType,
				ok: !likelyUnrecognizedScan,
				extraction: "cloudflare_ai_document_conversion",
				text: text.slice(0, maxCharacters),
				truncated: text.length > maxCharacters,
				characters_extracted: text.length,
				...(likelyUnrecognizedScan ? {
					error: "The PDF appears to be an image-only scan and requires a dedicated page-rendering OCR service.",
				} : {}),
			};
		});
	}

	private async updateText(resource: "contact" | "company", id: string, fields: Record<string, string | null | undefined>) {
		const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
		if (Object.keys(changes).length === 0) throw new Error("At least one field must be provided");
		const endpoint = resource === "company" ? "companies.update" : "contacts.update";
		await teamleaderCall(this.env, this.props!.userId, endpoint, { id, ...changes });
		const verified = await teamleaderCall(this.env, this.props!.userId, resource === "company" ? "companies.info" : "contacts.info", { id });
		return this.result({ ok: true, resource, id, updated_fields: Object.keys(changes), verified });
	}

	private async findDuplicateTicket(customerType: "contact" | "company", customerId: string, subject: string) {
		const normalizedSubject = this.normalize(subject);
		for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
			const response = await teamleaderCall(this.env, this.props!.userId, "tickets.list", {
				filter: { relates_to: { type: customerType, id: customerId } },
				page: { number: pageNumber, size: 20 },
			}) as { data?: Array<{ id?: string; subject?: string }> };
			const tickets = response.data || [];
			const duplicate = tickets.find((ticket) => this.normalize(ticket.subject || "") === normalizedSubject);
			if (duplicate) return duplicate;
			if (tickets.length < 20) return undefined;
		}
		throw new Error("Unable to safely complete the duplicate-ticket check across more than 400 tickets");
	}

	private async assertTicketAttachments(ticketId: string, attachmentIds: string[]) {
		if (attachmentIds.length === 0) return;
		const pendingIds = new Set(attachmentIds);
		for (let pageNumber = 1; pageNumber <= 1000; pageNumber += 1) {
			const response = await teamleaderCall(this.env, this.props!.userId, "files.list", {
				filter: { subject: { type: "ticket", id: ticketId } },
				page: { number: pageNumber, size: 100 },
			}) as { data?: Array<{ id?: string }> };
			const files = response.data || [];
			for (const file of files) {
				if (file.id) pendingIds.delete(file.id);
			}
			if (pendingIds.size === 0) return;
			if (files.length < 100) break;
		}
		throw new Error(`Attachments are not linked to this ticket: ${[...pendingIds].join(", ")}`);
	}

	private normalize(value: string) {
		return value.normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
	}

	private async searchContacts(term: string, page: { number: number; size: number }) {
		return teamleaderCall(this.env, this.props!.userId, "contacts.list", {
			filter: { term },
			page,
		});
	}
}

const oauthProvider = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: TeamleaderMCP.serve("/mcp"),
	defaultHandler: TeamleaderHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["teamleader:read", "teamleader:write"],
	allowPlainPKCE: false,
	resourceMetadata: {
		resource: "https://teamleader-chatgpt.mm-979.workers.dev/mcp",
		authorization_servers: ["https://teamleader-chatgpt.mm-979.workers.dev"],
		scopes_supported: ["teamleader:read", "teamleader:write"],
		resource_name: "APA Teamleader Secure",
	},
	clientIdMetadataDocumentEnabled: true,
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const response = await oauthProvider.fetch(request, env, ctx);
		const headers = new Headers(response.headers);
		const requestUrl = new URL(request.url);
		if (requestUrl.pathname.startsWith("/mcp") && response.status === 401) {
			const challenge = headers.get("WWW-Authenticate");
			if (challenge && !/\bscope=/i.test(challenge)) {
				headers.set(
					"WWW-Authenticate",
					`${challenge}, scope="teamleader:read teamleader:write"`,
				);
			}
		}
		headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
		if (["/authorize", "/oauth/callback", "/token", "/register", "/mcp"].some(
			(path) => requestUrl.pathname.startsWith(path),
		)) headers.set("Cache-Control", "no-store");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
