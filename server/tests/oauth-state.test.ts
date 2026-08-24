import assert from "node:assert/strict";
import test from "node:test";
import { consumeOAuthApproval, createOAuthApproval } from "../src/workers-oauth-utils.ts";

class MemoryKV {
	values = new Map<string, string>();
	async put(key: string, value: string) { this.values.set(key, value); }
	async get(key: string) { return this.values.get(key) ?? null; }
	async delete(key: string) { this.values.delete(key); }
}

test("approval data is server-side and one-time", async () => {
	const kv = new MemoryKV();
	const request = {
		clientId: "client-1",
		redirectUri: "https://example.com/callback",
		responseType: "code",
		scope: ["teamleader:read"],
	} as never;
	const { approvalToken } = await createOAuthApproval(request, kv as never);
	assert.deepEqual(await consumeOAuthApproval(approvalToken, kv as never), request);
	await assert.rejects(consumeOAuthApproval(approvalToken, kv as never), /already used/);
});

test("rejects a forged approval token", async () => {
	const kv = new MemoryKV();
	await assert.rejects(consumeOAuthApproval("not-a-token", kv as never), /Invalid approval token/);
});
