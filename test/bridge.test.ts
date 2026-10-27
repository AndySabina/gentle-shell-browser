import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { type Bridge, handshakeProof, startBridge } from "../src/bridge.ts";
import { Peer } from "../extension/lib/rpc.js";

const TOKEN = "t".repeat(43);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SESSION = "c2Vzc2lvbi1pZC0xMjM0NQ";

async function bridge(overrides: Partial<Parameters<typeof startBridge>[0]> = {}): Promise<Bridge> {
	return startBridge({ token: TOKEN, port: 0, sessionId: SESSION, helloTimeoutMs: 200, handlers: {}, ...overrides });
}

const proof = (token: string, side: "server" | "client", clientNonce: string, serverNonce: string, sessionId = SESSION) =>
	createHmac("sha256", token).update(`gentle-chrome/${side}\n${clientNonce}\n${serverNonce}\n${sessionId}`).digest("base64url");

test("handshake proofs bind the session id", () => {
	const [client, server] = ["c".repeat(43), "s".repeat(43)];
	assert.equal(handshakeProof(TOKEN, "server", client, server, SESSION), proof(TOKEN, "server", client, server));
	assert.equal(handshakeProof(TOKEN, "client", client, server, SESSION), proof(TOKEN, "client", client, server));
	assert.notEqual(handshakeProof(TOKEN, "server", client, server, SESSION), handshakeProof(TOKEN, "server", client, server, "b3RoZXItc2Vzc2lvbi1pZA"));
	assert.notEqual(handshakeProof(TOKEN, "client", client, server, SESSION), handshakeProof(TOKEN, "client", client, server, "b3RoZXItc2Vzc2lvbi1pZA"));
});

/**
 * Connects like the Chrome extension: origin header, hello with a nonce, then
 * the client proof for the server's challenge, computed with `token`.
 */
async function connect(port: number, options: { origin?: string; token?: string; build?: string; sessionId?: string } = {}) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: options.origin ?? ORIGIN });
	const peer = new Peer((text: string) => socket.send(text));
	const messages: any[] = [];
	const clientNonce = randomBytes(32).toString("base64url");
	socket.on("message", (data) => {
		const text = data.toString();
		const message = JSON.parse(text);
		messages.push(message);
		if (message.kind === "challenge") socket.send(JSON.stringify({ kind: "auth", proof: proof(options.token ?? TOKEN, "client", clientNonce, message.serverNonce, options.sessionId ?? message.sessionId) }));
		else peer.receive(text);
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ kind: "hello", version: "0.1.0", build: options.build, clientNonce }));
	return { socket, peer, messages, clientNonce };
}

async function closeCode(socket: WebSocket): Promise<number> {
	const [code] = await once(socket, "close");
	return code as number;
}

test("an authenticated extension is welcomed and reported connected", async () => {
	const changes: unknown[] = [];
	const server = await bridge({ onConnectionChange: (info) => changes.push(info) });
	try {
		const client = await connect(server.port, { build: "0123456789abcdef" });
		await waitUntil(() => server.connected() !== undefined && client.messages.length > 1);
		assert.deepEqual(server.connected(), { version: "0.1.0", build: "0123456789abcdef" });
		const [challenge, welcome] = client.messages;
		assert.deepEqual(Object.keys(challenge).sort(), ["kind", "proof", "serverNonce", "sessionId"]);
		assert.equal(challenge.kind, "challenge");
		assert.equal(challenge.sessionId, SESSION);
		assert.match(challenge.serverNonce, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(challenge.proof, proof(TOKEN, "server", client.clientNonce, challenge.serverNonce));
		assert.deepEqual(welcome, { kind: "welcome" });
		assert.deepEqual(changes, [{ version: "0.1.0", build: "0123456789abcdef" }]);
		client.socket.close();
		await waitUntil(() => server.connected() === undefined);
		assert.deepEqual(changes, [{ version: "0.1.0", build: "0123456789abcdef" }, undefined]);
	} finally {
		await server.close();
	}
});

test("an extension that sends no build is reported with build unknown", async () => {
	const server = await bridge();
	try {
		await connect(server.port);
		await waitUntil(() => server.connected() !== undefined);
		assert.deepEqual(server.connected(), { version: "0.1.0", build: "unknown" });
	} finally {
		await server.close();
	}
});

test("calls reach the extension and its requests reach the handlers", async () => {
	const server = await bridge({ handlers: { approve: async (params) => ({ approved: (params as { ok: boolean }).ok }) } });
	try {
		const client = await connect(server.port);
		client.peer.handle("tabs", async () => [{ id: 1 }]);
		await waitUntil(() => server.connected() !== undefined);
		assert.deepEqual(await server.call("tabs", {}), [{ id: 1 }]);
		assert.deepEqual(await client.peer.call("approve", { ok: true }), { approved: true });
	} finally {
		await server.close();
	}
});

test("a call without a connected extension fails with a clear message", async () => {
	const server = await bridge();
	try {
		await assert.rejects(server.call("tabs", {}), {
			message: "Chrome is not connected. Make sure Chrome is open and the Gentle Shell extension is On (click its icon).",
		});
	} finally {
		await server.close();
	}
});

test("a wrong client proof is closed with 4401 and never reported connected", async () => {
	const server = await bridge();
	try {
		const client = await connect(server.port, { token: "x".repeat(43) });
		assert.equal(await closeCode(client.socket), 4401);
		assert.equal(server.connected(), undefined);
		assert.deepEqual(client.messages.map((message) => message.kind), ["challenge"]);
	} finally {
		await server.close();
	}
});

test("a client proof made for another session id is closed with 4401", async () => {
	const server = await bridge();
	try {
		const client = await connect(server.port, { sessionId: "b3RoZXItc2Vzc2lvbi1pZA" });
		assert.equal(await closeCode(client.socket), 4401);
		assert.equal(server.connected(), undefined);
	} finally {
		await server.close();
	}
});

test("the old hello with a token, or a hello without a valid nonce, gets no challenge and is closed with 4401", async () => {
	const server = await bridge();
	try {
		for (const hello of [{ kind: "hello", token: TOKEN, version: "0.1.0" }, { kind: "hello", clientNonce: "short" }, { kind: "auth", proof: "x" }]) {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
			const messages: unknown[] = [];
			socket.on("message", (data) => messages.push(data.toString()));
			await once(socket, "open");
			socket.send(JSON.stringify(hello));
			assert.equal(await closeCode(socket), 4401, JSON.stringify(hello));
			assert.deepEqual(messages, [], JSON.stringify(hello));
		}
		assert.equal(server.connected(), undefined);
	} finally {
		await server.close();
	}
});

test("a client that says hello but never answers the challenge is closed with 4401", async () => {
	const server = await bridge();
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
		await once(socket, "open");
		socket.send(JSON.stringify({ kind: "hello", version: "0.1.0", clientNonce: randomBytes(32).toString("base64url") }));
		assert.equal(await closeCode(socket), 4401);
	} finally {
		await server.close();
	}
});

test("more than 4 KiB before authentication closes the connection", async () => {
	const server = await bridge({ helloTimeoutMs: 5000 });
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
		await once(socket, "open");
		socket.send(JSON.stringify({ kind: "hello", version: "x".repeat(4100), clientNonce: randomBytes(32).toString("base64url") }));
		assert.equal(await closeCode(socket), 1009);
		assert.equal(server.connected(), undefined);
	} finally {
		await server.close();
	}
});

test("a client that never says hello is closed with 4401", async () => {
	const server = await bridge();
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
		assert.equal(await closeCode(socket), 4401);
	} finally {
		await server.close();
	}
});

test("a web page origin is refused before the upgrade", async () => {
	const server = await bridge();
	try {
		for (const origin of ["https://evil.example", "null", ""]) {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, origin ? { origin } : {});
			const [error] = await once(socket, "error");
			assert.match(String(error), /Unexpected server response: 401/, origin);
		}
		assert.equal(server.connected(), undefined);
	} finally {
		await server.close();
	}
});

test("a newer authenticated connection replaces the previous one", async () => {
	const server = await bridge();
	try {
		const first = await connect(server.port);
		await waitUntil(() => server.connected() !== undefined);
		const firstClosed = closeCode(first.socket);
		const second = await connect(server.port);
		second.peer.handle("who", async () => "second");
		assert.equal(await firstClosed, 4000);
		await waitUntil(() => second.messages.some((message) => message.kind === "welcome"));
		assert.equal(await server.call("who", {}), "second");
	} finally {
		await server.close();
	}
});

test("starting on a busy port fails with a clear message", async () => {
	const first = await bridge();
	try {
		await assert.rejects(bridge({ port: first.port }), {
			message: `Port ${first.port} is already in use (another Gentle Shell session may own the browser).`,
			code: "EADDRINUSE",
		});
	} finally {
		await first.close();
	}
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
