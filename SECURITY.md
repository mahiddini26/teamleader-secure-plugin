# Security policy

Report security issues privately to mm@apa-insurances.com. Do not include production tokens or personal customer data in reports.

## Operational requirements

- Rotate the Teamleader client secret immediately if it is ever pasted into chat, committed, logged, or exposed.
- Keep Cloudflare secrets in secret bindings only.
- Disable request/response body logging and redact authorization headers.
- Restrict Cloudflare access to APA administrators with MFA.
- Review Teamleader OAuth scopes quarterly and after every tool addition.
- Revoke the Teamleader integration and clear `teamleader-token:*` KV records when access is withdrawn.
- Keep every write tool behind an explicit user-confirmation step and review its scope whenever the tool changes.
- Enforce `teamleader:write` inside every mutation handler; schema confirmation alone is not authorization.
- Run TypeScript, unit tests, dependency audit, and Wrangler dry-run before every production deployment.
