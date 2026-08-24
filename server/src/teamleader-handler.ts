import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	addApprovedClient,
	bindStateToSession,
	consumeOAuthApproval,
	createOAuthApproval,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";
import {
	exchangeAuthorizationCode,
	getUpstreamAuthorizeUrl,
	saveToken,
	teamleaderCall,
	type Props,
} from "./utils";
import { assertCompleteOAuthScopes } from "./safety";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	let requestInfo: AuthRequest;
	try {
		requestInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		return c.text("Invalid authorization request", 400);
	}
	if (!requestInfo.clientId) return c.text("Invalid client", 400);

	if (await isClientApproved(c.req.raw, requestInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(requestInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToTeamleader(c.env, c.req.raw, stateToken, { "Set-Cookie": setCookie });
	}

	const { token, setCookie } = generateCSRFProtection();
	const { approvalToken } = await createOAuthApproval(requestInfo, c.env.OAUTH_KV);
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(requestInfo.clientId),
		csrfToken: token,
		server: {
			name: "APA Teamleader Secure",
			description: "Secure access to authorized Teamleader Focus business data, with explicit confirmation required for writes.",
		},
		setCookie,
		state: { approvalToken },
	});
});

app.post("/authorize", async (c) => {
	try {
		const form = await c.req.raw.formData();
		const { clearCookie } = validateCSRFToken(form, c.req.raw);
		const encoded = form.get("state");
		if (typeof encoded !== "string") return c.text("Missing state", 400);
		const state = JSON.parse(atob(encoded)) as { approvalToken?: string };
		if (!state.approvalToken) return c.text("Invalid state", 400);
		const requestInfo = await consumeOAuthApproval(state.approvalToken, c.env.OAUTH_KV);

		const approved = await addApprovedClient(
			c.req.raw,
			requestInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);
		const { stateToken } = await createOAuthState(requestInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		const headers = new Headers();
		headers.append("Set-Cookie", approved);
		headers.append("Set-Cookie", clearCookie);
		headers.append("Set-Cookie", setCookie);
		return redirectToTeamleader(c.env, c.req.raw, stateToken, headers);
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Authorization failed", 400);
	}
});

function redirectToTeamleader(
	workerEnv: Env,
	request: Request,
	state: string,
	headers: Headers | Record<string, string>,
) {
	const responseHeaders = new Headers(headers);
	responseHeaders.set(
		"Location",
		getUpstreamAuthorizeUrl({
			clientId: workerEnv.TEAMLEADER_CLIENT_ID,
			redirectUri: new URL("/oauth/callback", request.url).href,
			state,
		}),
	);
	return new Response(null, {
		status: 302,
		headers: responseHeaders,
	});
}

app.get("/oauth/callback", async (c) => {
	try {
		const { oauthReqInfo, clearCookie } = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		const scopes = assertCompleteOAuthScopes(oauthReqInfo.scope);
		const code = c.req.query("code");
		if (!code) return c.text("Missing authorization code", 400);
		const redirectUri = new URL("/oauth/callback", c.req.url).href;
		const token = await exchangeAuthorizationCode(c.env, code, redirectUri);
		const me = (await teamleaderCallWithToken(token.accessToken, "users.me")) as {
			data: { id: string; first_name?: string; last_name?: string };
		};
		const userId = me.data.id;
		const displayName = [me.data.first_name, me.data.last_name].filter(Boolean).join(" ") || "Teamleader user";
		await saveToken(c.env, userId, token);

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: oauthReqInfo,
			userId,
			metadata: { label: displayName },
			scope: scopes,
			props: { userId, displayName, scopes } satisfies Props,
		});
		const headers = new Headers({ Location: redirectTo });
		if (clearCookie) headers.set("Set-Cookie", clearCookie);
		return new Response(null, { status: 302, headers });
	} catch (error) {
		console.error(
			"OAuth callback failed",
			error instanceof Error ? error.message : "Unknown OAuth callback error",
		);
		return c.text("OAuth callback failed", 400);
	}
});

async function teamleaderCallWithToken(accessToken: string, endpoint: string) {
	const response = await fetch(`https://api.focus.teamleader.eu/${endpoint}`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
	});
	if (!response.ok) throw new Error("Unable to identify Teamleader user");
	return response.json();
}

app.get("/health", (c) => c.json({ ok: true, service: "teamleader-secure" }));

export { app as TeamleaderHandler };
