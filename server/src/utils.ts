export type TeamleaderToken = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

export type Props = {
	userId: string;
	displayName: string;
	scopes: Array<"teamleader:read" | "teamleader:write">;
};

type EnvLike = {
	OAUTH_KV: KVNamespace;
	TEAMLEADER_CLIENT_ID: string;
	TEAMLEADER_CLIENT_SECRET: string;
	TOKEN_ENCRYPTION_KEY: string;
};

type EncryptedToken = {
	v: 1;
	iv: string;
	ciphertext: string;
};

const TOKEN_ENDPOINT = "https://focus.teamleader.eu/oauth2/access_token";
const API_ORIGIN = "https://api.focus.teamleader.eu";

function isTrustedTeamleaderFileHost(hostname: string) {
	return hostname === "teamleader.s3.eu-west-1.amazonaws.com" ||
		hostname === "teamleader.eu" || hostname.endsWith(".teamleader.eu");
}

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

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function tokenEncryptionKey(secret: string): Promise<CryptoKey> {
	if (secret.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(secret: string, userId: string, token: TeamleaderToken): Promise<EncryptedToken> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: new TextEncoder().encode(`teamleader-token:${userId}:v1`),
		},
		await tokenEncryptionKey(secret),
		new TextEncoder().encode(JSON.stringify(token)),
	);
	return { v: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptToken(secret: string, userId: string, encrypted: EncryptedToken): Promise<TeamleaderToken> {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: base64ToBytes(encrypted.iv),
			additionalData: new TextEncoder().encode(`teamleader-token:${userId}:v1`),
		},
		await tokenEncryptionKey(secret),
		base64ToBytes(encrypted.ciphertext),
	);
	const token = JSON.parse(new TextDecoder().decode(plaintext)) as TeamleaderToken;
	if (!token.accessToken || !token.refreshToken || !Number.isFinite(token.expiresAt)) {
		throw new Error("Invalid encrypted Teamleader token");
	}
	return token;
}

export async function saveToken(env: EnvLike, userId: string, token: TeamleaderToken) {
	const encrypted = await encryptToken(env.TOKEN_ENCRYPTION_KEY, userId, token);
	await env.OAUTH_KV.put(`teamleader-token:${userId}`, JSON.stringify(encrypted));
}

export async function deleteToken(env: EnvLike, userId: string) {
	await env.OAUTH_KV.delete(`teamleader-token:${userId}`);
}

async function loadFreshToken(env: EnvLike, userId: string) {
	const key = `teamleader-token:${userId}`;
	const stored = await env.OAUTH_KV.get(key);
	if (!stored) throw new Error("Teamleader account is not linked");
	const parsed = JSON.parse(stored) as TeamleaderToken | EncryptedToken;
	const isEncrypted = "v" in parsed && parsed.v === 1 && "ciphertext" in parsed && "iv" in parsed;
	const token = isEncrypted
		? await decryptToken(env.TOKEN_ENCRYPTION_KEY, userId, parsed)
		: parsed as TeamleaderToken;
	if (!token.accessToken || !token.refreshToken || !Number.isFinite(token.expiresAt)) {
		throw new Error("Invalid Teamleader token");
	}
	// Transparently migrate legacy plaintext records on their first use.
	if (!isEncrypted) await saveToken(env, userId, token);
	if (token.expiresAt > Date.now() + 60_000) return token;

	let refreshed: TeamleaderToken;
	try {
		refreshed = await exchange({
			client_id: env.TEAMLEADER_CLIENT_ID,
			client_secret: env.TEAMLEADER_CLIENT_SECRET,
			refresh_token: token.refreshToken,
			grant_type: "refresh_token",
		});
	} catch (error) {
		// Teamleader rotates refresh tokens. If two requests refresh concurrently,
		// the winner stores the new token and the loser must reuse it instead of
		// invalidating an otherwise healthy connection.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const latestStored = await env.OAUTH_KV.get(key);
		if (!latestStored || latestStored === stored) throw error;
		const latestParsed = JSON.parse(latestStored) as TeamleaderToken | EncryptedToken;
		const latestEncrypted = "v" in latestParsed && latestParsed.v === 1 && "ciphertext" in latestParsed && "iv" in latestParsed;
		const latest = latestEncrypted
			? await decryptToken(env.TOKEN_ENCRYPTION_KEY, userId, latestParsed)
			: latestParsed as TeamleaderToken;
		if (!latest.accessToken || !latest.refreshToken || latest.expiresAt <= Date.now()) throw error;
		return latest;
	}
	await saveToken(env, userId, refreshed);
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
		const bytes = await readBoundedErrorBody(response, 32 * 1024);
		const details = summarizeTeamleaderErrors(bytes);
		throw new Error(`Teamleader API error ${response.status}${details ? `: ${details}` : ""} (request ${requestId})`);
	}
	if (response.status === 204) return null;
	return response.json();
}

async function readBoundedErrorBody(response: Response, limit: number) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel("error body size limit exceeded");
				return "";
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(output);
}

function summarizeTeamleaderErrors(value: string) {
	if (!value) return "";
	try {
		const parsed = JSON.parse(value) as { errors?: Array<{ title?: unknown; detail?: unknown; source?: { pointer?: unknown } }> };
		return (parsed.errors || []).slice(0, 5).map((error) => {
			const title = typeof error.title === "string" ? error.title : "Invalid request";
			const detail = typeof error.detail === "string" ? ` — ${error.detail}` : "";
			const pointer = typeof error.source?.pointer === "string" ? ` [${error.source.pointer}]` : "";
			return `${title}${detail}${pointer}`;
		}).join("; ").replace(/[\r\n\t]+/g, " ").slice(0, 2_000);
	} catch {
		return "";
	}
}

export async function uploadTeamleaderFile(
	env: EnvLike,
	userId: string,
	options: {
		name: string;
		mimeType: string;
		bytes: Uint8Array;
		subject: { type: "ticket"; id: string };
		folder?: string;
	},
) {
	const requested = await teamleaderCall(env, userId, "files.upload", {
		name: options.name,
		subject: options.subject,
		...(options.folder ? { folder: options.folder } : {}),
	}) as { data?: { location?: string; expires_at?: string } };
	const location = requested.data?.location;
	if (!location) throw new Error("Teamleader did not return a file upload location");

	const uploadUrl = new URL(location);
	if (uploadUrl.protocol !== "https:" || !isTrustedTeamleaderFileHost(uploadUrl.hostname)) {
		throw new Error("Teamleader returned an invalid file upload location");
	}

	const uploaded = await fetch(uploadUrl, {
		method: "POST",
		headers: { "content-type": options.mimeType },
		body: options.bytes,
	});
	if (!uploaded.ok) throw new Error(`Teamleader file upload failed (${uploaded.status})`);

	return { expiresAt: requested.data?.expires_at };
}
