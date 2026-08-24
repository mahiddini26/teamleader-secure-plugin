# APA Teamleader Secure

This plugin connects ChatGPT and Codex to Teamleader Focus through a remote MCP server. The current version combines targeted reads with explicitly confirmed business writes.

## Security model

- OAuth 2.1 with PKCE between ChatGPT/Codex and the MCP server.
- Mandatory `teamleader:read` and `teamleader:write` grants; OAuth completion is rejected if either is missing, and every mutation verifies the write scope again at execution time.
- Teamleader authorization-code OAuth on the server; the Teamleader client secret never reaches the browser or model.
- One-time state, browser binding, CSRF protection, short-lived access tokens, rotating refresh tokens, and server-side token storage.
- Concurrent refresh protection reuses the newly rotated Teamleader token when two requests refresh at the same time, preventing spurious reconnect failures.
- Fixed Teamleader API origin and allowlisted tool endpoints; no arbitrary URL proxy.
- Targeted contact, company, opportunity, user, ticket, invoice, and attachment reads.
- Explicitly confirmed contact/company/opportunity creation and updates, relationship updates, ticket creation, internal ticket messages, draft invoice creation, and ticket attachment uploads.
- Ticket creation validates the customer and status, checks likely duplicates, disables automatic initial replies, and verifies the created record.
- Internal ticket messages accept only files already linked to the exact ticket and never send a customer reply.
- Ticket uploads use Teamleader's temporary `files.upload` URL, are published in a verified internal activity note, and are re-read after transfer.
- Attachment text extraction runs inside the connector through the Workers AI binding. It supports digital PDFs, common image formats, Word, Excel, and CSV, with single-file and batch tools.
- `get_ticket` and `extract_attachments_text` accept up to 20 attachment IDs without persistent file storage. Link generation and extraction must be requested separately to remain within Cloudflare Free subrequest limits.
- Extraction is limited to 20 MB per file and 40 MB per batch. Image-only PDFs that yield no meaningful text are reported as requiring a dedicated page-rendering OCR service; they are never reported as successfully read.
- Downloads are read with an enforced streaming byte limit before conversion, and executable HTML is rejected from internal ticket messages.
- Tool results never contain credentials.

## Required Teamleader configuration

Keep only the scopes required by the exposed tools: `users`, `contacts`, `companies`, `deals`, `departments`, `invoices`, `tickets`, and files if Teamleader exposes it separately for the integration. Remove unrelated scopes.

The production redirect URI must be exactly:

`https://teamleader-chatgpt.mm-979.workers.dev/oauth/callback`

## Deploy the Worker

From `server/`:

1. Run `pnpm install`.
2. Create KV: `pnpm exec wrangler kv namespace create OAUTH_KV`.
3. Replace the KV ID in `wrangler.jsonc`.
4. Store secrets with `pnpm exec wrangler secret put TEAMLEADER_CLIENT_ID`, `TEAMLEADER_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, and `TOKEN_ENCRYPTION_KEY`.
5. Run `pnpm run check && pnpm test && pnpm exec wrangler deploy --dry-run`.
6. Deploy with `pnpm deploy`.
7. Test `https://teamleader-chatgpt.mm-979.workers.dev/mcp` with MCP Inspector before enabling the plugin.

Generate the cookie key with `openssl rand -hex 32`. Never put real secrets in `.dev.vars.example`, Git, plugin metadata, or chat messages.

## Connect in ChatGPT

Enable Developer mode, add the MCP URL above under Plugins, complete OAuth, inspect the discovered tools, and test both reads and confirmed writes. Remove and reconnect the plugin after tool metadata or OAuth-scope changes so old grants and cached schemas are replaced.
