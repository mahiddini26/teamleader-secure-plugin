import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { TeamleaderHandler } from "./teamleader-handler";
import { teamleaderCall, type Props } from "./utils";

const PAGE = z.object({
	number: z.number().int().min(1).max(1000).default(1),
	size: z.number().int().min(1).max(100).default(20),
}).default({ number: 1, size: 20 });

export class TeamleaderMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "APA Teamleader Secure", version: "0.2.0" });

	async init() {
		this.server.tool(
			"get_current_user",
			"Return the authenticated Teamleader Focus user.",
			{},
			{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			async () => this.result(await teamleaderCall(this.env, this.props!.userId, "users.me")),
		);

		for (const resource of [
			"contacts",
			"companies",
			"departments",
			"invoices",
			"tickets",
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
				{ id: z.string().uuid() },
				{ readOnlyHint: true, destructiveHint: false, openWorldHint: false },
				async ({ id }) => this.result(await teamleaderCall(this.env, this.props!.userId, `${resource}.info`, { id })),
			);
		}
	}

	private result(value: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
	}
}

export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: TeamleaderMCP.serve("/mcp"),
	defaultHandler: TeamleaderHandler as any,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["teamleader:read"],
	allowPlainPKCE: false,
	resourceMetadata: {
		resource: "https://teamleader-chatgpt.mm-979.workers.dev/mcp",
		authorization_servers: ["https://teamleader-chatgpt.mm-979.workers.dev"],
		scopes_supported: ["teamleader:read"],
		resource_name: "APA Teamleader Secure",
	},
	clientIdMetadataDocumentEnabled: true,
});
