# APA Teamleader Secure

This plugin connects ChatGPT and Codex to Teamleader Focus through a remote MCP server. Version 0.2 is intentionally read-only.

## Security model

- OAuth 2.1 with PKCE between ChatGPT/Codex and the MCP server.
- Teamleader authorization-code OAuth on the server; the Teamleader client secret never reaches the browser or model.
- One-time state, browser binding, CSRF protection, short-lived access tokens, rotating refresh tokens, and server-side token storage.
- Fixed Teamleader API origin and allowlisted tool endpoints; no arbitrary URL proxy.
- Read-only tools and least-privilege Teamleader scopes.
- Tool results never contain credentials.

## Required Teamleader configuration

Keep only these scopes for version 0.2: `users`, `contacts`, `companies`, `departments`, `invoices`, and `tickets`. Remove Admin, Deals, Events, Products, Projects, Quotations, Subscriptions, Todos, and all other unused scopes.

The production redirect URI must be exactly:

`https://teamleader-chatgpt.mm-979.workers.dev/oauth/callback`

## Deploy the Worker

From `server/`:

1. Run `npm install`.
2. Create KV: `npx wrangler kv namespace create OAUTH_KV`.
3. Replace the KV ID in `wrangler.jsonc`.
4. Store secrets with `npx wrangler secret put TEAMLEADER_CLIENT_ID`, `TEAMLEADER_CLIENT_SECRET`, and `COOKIE_ENCRYPTION_KEY`.
5. Deploy with `npm run deploy`.
6. Test `https://teamleader-chatgpt.mm-979.workers.dev/mcp` with MCP Inspector before enabling the plugin.

Generate the cookie key with `openssl rand -hex 32`. Never put real secrets in `.dev.vars.example`, Git, plugin metadata, or chat messages.

## Connect in ChatGPT

Enable Developer mode, add the MCP URL above under Plugins, complete OAuth, inspect the discovered tools, and run read-only test prompts. Refresh the connection after tool metadata changes.
