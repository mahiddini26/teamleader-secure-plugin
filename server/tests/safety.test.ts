import assert from "node:assert/strict";
import test from "node:test";
import { assertCompleteOAuthScopes, assertSafeInternalMessageHtml, assertWriteScope, readResponseWithLimit } from "../src/safety.ts";

test("accepts basic formatting for internal messages", () => {
	assert.equal(assertSafeInternalMessageHtml("<p>Bonjour <strong>Michael</strong></p>"), "<p>Bonjour <strong>Michael</strong></p>");
});

test("rejects executable HTML", () => {
	assert.throws(() => assertSafeInternalMessageHtml("<img src=x onerror=alert(1)>"), /unsafe HTML/);
	assert.throws(() => assertSafeInternalMessageHtml("<a href=javascript:alert(1)>x</a>"), /unsafe HTML/);
	assert.throws(() => assertSafeInternalMessageHtml("<script>alert(1)</script>"), /unsafe HTML/);
});

test("requires the write scope for mutations", () => {
	assert.doesNotThrow(() => assertWriteScope(["teamleader:read", "teamleader:write"]));
	assert.throws(() => assertWriteScope(["teamleader:read"]), /Insufficient OAuth scope/);
	assert.throws(() => assertWriteScope(undefined), /Insufficient OAuth scope/);
});

test("requires both read and write scopes when completing OAuth", () => {
	assert.deepEqual(
		assertCompleteOAuthScopes(["teamleader:write", "teamleader:read"]),
		["teamleader:read", "teamleader:write"],
	);
	assert.throws(() => assertCompleteOAuthScopes(["teamleader:read"]), /teamleader:write/);
	assert.throws(() => assertCompleteOAuthScopes(["teamleader:write"]), /teamleader:read/);
});

test("reads a bounded response", async () => {
	const result = await readResponseWithLimit(new Response(new Uint8Array([1, 2, 3])), 3);
	assert.deepEqual([...result], [1, 2, 3]);
});

test("stops a response larger than the configured limit", async () => {
	await assert.rejects(
		readResponseWithLimit(new Response(new Uint8Array([1, 2, 3, 4])), 3),
		/safety limit/,
	);
});
