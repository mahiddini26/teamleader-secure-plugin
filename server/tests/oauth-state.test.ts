import assert from "node:assert/strict";
import test from "node:test";
import { consumeOAuthApproval, createOAuthApproval, renderApprovalDialog, generateCSRFProtection, validateCSRFToken } from "../src/workers-oauth-utils.ts";

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

test("OAuth form allows only the expected upstream redirect and cannot be cached", () => {
	const csrf = generateCSRFProtection();
	const response = renderApprovalDialog(new Request("https://connector.example/authorize"), {client:undefined,server:{name:"Test"},state:{approvalToken:"test"},csrfToken:csrf.token,setCookie:csrf.setCookie} as never);
	assert.equal(response.headers.get("Cache-Control"),"no-store");
	assert.match(response.headers.get("Content-Security-Policy")!, /form-action 'self' https:\/\/focus\.teamleader\.eu;/);
	const form = new FormData(); form.set("csrf_token",csrf.token);
	assert.throws(()=>validateCSRFToken(form,new Request("https://connector.example/authorize")),/Missing CSRF token cookie/);
	assert.doesNotThrow(()=>validateCSRFToken(form,new Request("https://connector.example/authorize",{headers:{cookie:csrf.setCookie.split(";")[0]}})));
});
