export function assertSafeInternalMessageHtml(value: string) {
	if (/<\s*\/?\s*(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|meta|link)\b/i.test(value) ||
		/\son[a-z]+\s*=/i.test(value) || /(?:javascript|data|vbscript)\s*:/i.test(value)) {
		throw new Error("The internal message contains unsafe HTML");
	}
	return value;
}

export function assertWriteScope(scopes: readonly string[] | undefined) {
	if (!scopes?.includes("teamleader:write")) {
		throw new Error("Insufficient OAuth scope: reconnect Teamleader with teamleader:write permission");
	}
}

export function assertCompleteOAuthScopes(scopes: readonly string[] | undefined) {
	const required = ["teamleader:read", "teamleader:write"] as const;
	const missing = required.filter((scope) => !scopes?.includes(scope));
	if (missing.length > 0) {
		throw new Error(`Missing required OAuth scopes: ${missing.join(", ")}`);
	}
	return [...required];
}

export async function readResponseWithLimit(response: Response, limit: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel("size limit exceeded");
				throw new Error("Downloaded file exceeds the configured safety limit");
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
	return output;
}
