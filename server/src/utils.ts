export type TeamleaderToken = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

export type Props = {
	userId: string;
	displayName: string;
};

type EnvLike = {
	OAUTH_KV: KVNamespace;
	TEAMLEADER_CLIENT_ID: string;
	TEAMLEADER_CLIENT_SECRET: string;
};

const TOKEN_ENDPOINT = "https://focus.teamleader.eu/oauth2/access_token";
const API_ORIGIN = "https://api.focus.teamleader.eu";

export function getUpstreamAuthorizeUrl(options: {
	clientId: string;
	redirectUri: string;
	state: string;
}) {
	const url = new URL("https://focus.teamleader.eu/oauth2/authorize");
	url.searchParams.set("client_id", options.clientId);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", options.state);
	return url.toString();
}

async function exchange(body: Record<string, string>): Promise<TeamleaderToken> {
	const response = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	if (!response.ok) throw new Error(`Teamleader OAuth exchange failed (${response.status})`);
	const value = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};
	if (!value.access_token || !value.refresh_token) throw new Error("Invalid Teamleader OAuth response");
	return {
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		expiresAt: Date.now() + value.expires_in * 1000,
	};
}

export async function exchangeAuthorizationCode(
	env: EnvLike,
	code: string,
	redirectUri: string,
) {
	return exchange({
		client_id: env.TEAMLEADER_CLIENT_ID,
		client_secret: env.TEAMLEADER_CLIENT_SECRET,
		code,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});
}

export async function saveToken(env: EnvLike, userId: string, token: TeamleaderToken) {
	await env.OAUTH_KV.put(`teamleader-token:${userId}`, JSON.stringify(token));
}

async function loadFreshToken(env: EnvLike, userId: string) {
	const key = `teamleader-token:${userId}`;
	const token = await env.OAUTH_KV.get<TeamleaderToken>(key, "json");
	if (!token) throw new Error("Teamleader account is not linked");
	if (token.expiresAt > Date.now() + 60_000) return token;

	const refreshed = await exchange({
		client_id: env.TEAMLEADER_CLIENT_ID,
		client_secret: env.TEAMLEADER_CLIENT_SECRET,
		refresh_token: token.refreshToken,
		grant_type: "refresh_token",
	});
	await env.OAUTH_KV.put(key, JSON.stringify(refreshed));
	return refreshed;
}

export async function teamleaderCall(
	env: EnvLike,
	userId: string,
	endpoint: string,
	body: Record<string, unknown> = {},
) {
	if (!/^[a-zA-Z0-9.-]+$/.test(endpoint)) throw new Error("Invalid endpoint");
	const token = await loadFreshToken(env, userId);
	const response = await fetch(`${API_ORIGIN}/${endpoint}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token.accessToken}`,
			accept: "application/json",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const requestId = response.headers.get("x-request-id") || "unknown";
		throw new Error(`Teamleader API error ${response.status} (request ${requestId})`);
	}
	if (response.status === 204) return null;
	return response.json();
}
