interface Env {
	OAUTH_KV: KVNamespace;
	MCP_OBJECT: DurableObjectNamespace;
	OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
	TEAMLEADER_CLIENT_ID: string;
	TEAMLEADER_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
}
