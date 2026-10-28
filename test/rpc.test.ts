import assert from "node:assert/strict";
import { test } from "node:test";
import { Peer, Unanswered } from "../extension/lib/rpc.js";

/** Two peers wired back to back, delivering messages asynchronously like a socket. */
function pair() {
	const a: Peer = new Peer((text: string) => queueMicrotask(() => b.receive(text)));
	const b: Peer = new Peer((text: string) => queueMicrotask(() => a.receive(text)));
	return { a, b };
}

test("a call resolves with the handler's result", async () => {
	const { a, b } = pair();
	b.handle("add", async (params: { x: number; y: number }) => params.x + params.y);
	assert.equal(await a.call("add", { x: 2, y: 3 }), 5);
});

test("a handler error rejects the call with its message", async () => {
	const { a, b } = pair();
	b.handle("fail", async () => {
		throw new Error("Tab is not in the Gentle Shell group");
	});
	await assert.rejects(a.call("fail", {}), { message: "Tab is not in the Gentle Shell group" });
});

test("an unknown method rejects the call", async () => {
	const { a } = pair();
	await assert.rejects(a.call("nope", {}), { message: "Unknown method: nope" });
});

test("a call times out when no answer arrives", async () => {
	const a = new Peer(() => {});
	await assert.rejects(a.call("slow", {}, { timeoutMs: 20 }), (error) => error instanceof Unanswered && error.message === "Timed out waiting for slow");
});

test("an aborted signal rejects the call as unanswered and a late answer is ignored", async () => {
	const sent: string[] = [];
	const a = new Peer((text: string) => sent.push(text));
	const controller = new AbortController();
	const pending = a.call("slow", {}, { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, (error) => error instanceof Unanswered && error.message === "Cancelled waiting for slow");
	assert.equal(a.pending.size, 0);
	a.receive(JSON.stringify({ kind: "res", id: 1, ok: true, result: "late" }));
	assert.equal(sent.length, 1);
});

test("an already aborted signal rejects without sending", async () => {
	const sent: string[] = [];
	const a = new Peer((text: string) => sent.push(text));
	await assert.rejects(a.call("slow", {}, { signal: AbortSignal.abort() }), (error) => error instanceof Unanswered && error.message === "Cancelled waiting for slow");
	assert.deepEqual(sent, []);
});

test("an answer or a remote error is not unanswered", async () => {
	const { a, b } = pair();
	b.handle("fail", () => {
		throw new Error("boom");
	});
	await assert.rejects(a.call("fail", {}), (error) => error instanceof Error && !(error instanceof Unanswered) && error.message === "boom");
});

test("close rejects every pending call", async () => {
	const a = new Peer(() => {});
	const pending = a.call("x", {});
	a.close("Chrome disconnected");
	await assert.rejects(pending, { message: "Chrome disconnected" });
});

test("malformed messages are ignored", () => {
	const a = new Peer(() => {});
	a.receive("not json");
	a.receive(JSON.stringify({ kind: "res", id: 999, ok: true }));
	a.receive(JSON.stringify([1, 2]));
});
