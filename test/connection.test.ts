import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startBridge } from "../src/bridge.ts";
import { Connection } from "../extension/lib/connection.js";

const TOKEN = "t".repeat(43);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SESSION = "c2Vzc2lvbi1pZC0xMjM0NQ";

function extension(handlers: Record<string, (params: any) => any> = {}, build?: string | (() => Promise<string>)) {
	const states: string[] = [];
	const connection = new Connection({
		createSocket: (url: string) => new WebSocket(url, { origin: ORIGIN }) as unknown as globalThis.WebSocket,
		version: "0.1.0",
		build,
		handlers,
		onState: (state: string) => states.push(state),
	});
	return { connection, states };
}

test("connects, serves bridge calls and calls back into the session", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: { approve: () => ({ approved: true }) } });
	const { connection, states } = extension({ tabs: () => [{ id: 7 }] });
	try {
		connection.open({ port: bridge.port, token: TOKEN });
		await waitUntil(() => connection.state === "connected" && bridge.connected() !== undefined);
		assert.deepEqual(states, ["connecting", "connected"]);
		assert.deepEqual(await bridge.call("tabs", {}), [{ id: 7 }]);
		assert.deepEqual(await connection.call("approve", {}), { approved: true });
	} finally {
		connection.close();
		await bridge.close();
	}
	assert.equal(connection.state, "off");
});

test("the hello carries the build, given as a string or a promise, and the session reports it", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	try {
		for (const [build, expected] of [["0123456789abcdef", "0123456789abcdef"], [async () => "fedcba9876543210", "fedcba9876543210"], [undefined, "unknown"]] as const) {
			const { connection } = extension({}, build);
			try {
				connection.open({ port: bridge.port, token: TOKEN });
				await waitUntil(() => connection.state === "connected" && bridge.connected() !== undefined);
				assert.deepEqual(bridge.connected(), { version: "0.1.0", build: expected });
			} finally {
				connection.close();
				await waitUntil(() => bridge.connected() === undefined);
			}
		}
	} finally {
		await bridge.close();
	}
});

test("a stale token cannot verify the session's proof: untrusted, not retried", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const { connection, states } = extension();
	try {
		connection.open({ port: bridge.port, token: "x".repeat(43) });
		await waitUntil(() => connection.state === "untrusted");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.deepEqual(states, ["connecting", "untrusted"]);
		await assert.rejects(connection.call("approve", {}), { message: "Not connected to Gentle Shell" });
		assert.equal(bridge.connected(), undefined);
	} finally {
		connection.close();
		await bridge.close();
	}
});

const proof = (token: string, side: string, clientNonce: string, serverNonce: string, sessionId = SESSION) =>
	createHmac("sha256", token).update(`gentle-chrome/${side}\n${clientNonce}\n${serverNonce}\n${sessionId}`).digest("base64url");

/** A listener on the port that records every message; `reply` answers each one. */
async function fakeServer(reply: (socket: WebSocket, message: any) => void) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const received: string[] = [];
	let connections = 0;
	server.on("connection", (socket) => {
		connections++;
		socket.on("message", (data) => {
			received.push(data.toString());
			reply(socket, JSON.parse(data.toString()));
		});
	});
	return {
		port: (server.address() as AddressInfo).port,
		received,
		connections: () => connections,
		close: () => new Promise<void>((done) => {
			for (const client of server.clients) client.terminate();
			server.close(() => done());
		}),
	};
}

test("a listener that does not know the token never receives it and is untrusted", async () => {
	const replies: [string, (socket: WebSocket, message: any) => void][] = [
		["forged proof", (socket, message) => message.kind === "hello" && socket.send(JSON.stringify({ kind: "challenge", serverNonce: randomBytes(32).toString("base64url"), proof: randomBytes(32).toString("base64url") }))],
		["welcome without a challenge", (socket) => socket.send(JSON.stringify({ kind: "welcome" }))],
		["garbage proof", (socket) => socket.send(JSON.stringify({ kind: "challenge", serverNonce: "n", proof: "%%%" }))],
	];
	for (const [name, reply] of replies) {
		const fake = await fakeServer(reply);
		const { connection, states } = extension();
		try {
			connection.open({ port: fake.port, token: TOKEN });
			await waitUntil(() => connection.state === "untrusted");
			await new Promise((resolve) => setTimeout(resolve, 1200));
			assert.deepEqual(states, ["connecting", "untrusted"], name);
			assert.equal(fake.connections(), 1, name);
			assert.equal(fake.received.length, 1, name);
			const hello = JSON.parse(fake.received[0]);
			assert.deepEqual(Object.keys(hello).sort(), ["build", "clientNonce", "kind", "version"], name);
			assert.match(hello.clientNonce, /^[A-Za-z0-9_-]{43}$/, name);
			assert.equal(fake.received.some((text) => text.includes(TOKEN)), false, name);
		} finally {
			connection.close();
			await fake.close();
		}
	}
});

test("the client proves itself with an HMAC, never the token; a 4401 answer is unauthorized", async () => {
	let serverNonce = "";
	const fake = await fakeServer((socket, message) => {
		if (message.kind === "hello") {
			serverNonce = randomBytes(32).toString("base64url");
			socket.send(JSON.stringify({ kind: "challenge", sessionId: SESSION, serverNonce, proof: proof(TOKEN, "server", message.clientNonce, serverNonce) }));
		} else socket.close(4401, "unauthorized");
	});
	const { connection, states } = extension();
	try {
		connection.open({ port: fake.port, token: TOKEN });
		await waitUntil(() => connection.state === "unauthorized");
		assert.deepEqual(states, ["connecting", "unauthorized"]);
		const [hello, auth] = fake.received.map((text) => JSON.parse(text));
		assert.deepEqual(auth, { kind: "auth", proof: proof(TOKEN, "client", hello.clientNonce, serverNonce) });
		assert.equal(fake.received.some((text) => text.includes(TOKEN)), false);
	} finally {
		connection.close();
		await fake.close();
	}
});

test("a client that knows the session id connects to that session", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const { connection, states } = extension();
	try {
		connection.open({ port: bridge.port, token: TOKEN, sessionId: SESSION });
		await waitUntil(() => connection.state === "connected" && bridge.connected() !== undefined);
		assert.deepEqual(states, ["connecting", "connected"]);
	} finally {
		connection.close();
		await bridge.close();
	}
});

test("a session whose challenge names another session id is untrusted and never gets an auth", async () => {
	const other = "b3RoZXItc2Vzc2lvbi1pZA";
	// A real session that knows the token, but is not the one this client was opened for.
	const fake = await fakeServer((socket, message) => {
		if (message.kind !== "hello") return;
		const serverNonce = randomBytes(32).toString("base64url");
		socket.send(JSON.stringify({ kind: "challenge", sessionId: other, serverNonce, proof: proof(TOKEN, "server", message.clientNonce, serverNonce, other) }));
	});
	const { connection, states } = extension();
	try {
		connection.open({ port: fake.port, token: TOKEN, sessionId: SESSION });
		await waitUntil(() => connection.state === "untrusted");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(states, ["connecting", "untrusted"]);
		assert.deepEqual(fake.received.map((text) => JSON.parse(text).kind), ["hello"]);
	} finally {
		connection.close();
		await fake.close();
	}
});

test("a challenge without a session id is untrusted", async () => {
	const fake = await fakeServer((socket, message) => {
		if (message.kind !== "hello") return;
		const serverNonce = randomBytes(32).toString("base64url");
		const legacy = createHmac("sha256", TOKEN).update(`gentle-chrome/server\n${message.clientNonce}\n${serverNonce}`).digest("base64url");
		socket.send(JSON.stringify({ kind: "challenge", serverNonce, proof: legacy }));
	});
	const { connection } = extension();
	try {
		connection.open({ port: fake.port, token: TOKEN });
		await waitUntil(() => connection.state === "untrusted");
		assert.deepEqual(fake.received.map((text) => JSON.parse(text).kind), ["hello"]);
	} finally {
		connection.close();
		await fake.close();
	}
});

test("waits while the session is down and connects once it starts", async () => {
	const probe = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const port = probe.port;
	await probe.close();
	const { connection, states } = extension();
	try {
		connection.open({ port, token: TOKEN });
		await waitUntil(() => states.includes("waiting"));
		const bridge = await startBridge({ token: TOKEN, port, sessionId: SESSION, handlers: {} });
		try {
			await waitUntil(() => connection.state === "connected", 5000);
		} finally {
			connection.close();
			await bridge.close();
		}
	} finally {
		connection.close();
	}
});

test("a newer extension connection marks the older one replaced", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const first = extension();
	const second = extension();
	try {
		first.connection.open({ port: bridge.port, token: TOKEN });
		await waitUntil(() => first.connection.state === "connected");
		second.connection.open({ port: bridge.port, token: TOKEN });
		await waitUntil(() => first.connection.state === "replaced" && second.connection.state === "connected");
	} finally {
		first.connection.close();
		second.connection.close();
		await bridge.close();
	}
});

test("a replaced connection waits, then the next ensure reconnects it to the same session", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const first = extension();
	const second = extension();
	try {
		first.connection.open({ port: bridge.port, token: TOKEN, sessionId: SESSION });
		await waitUntil(() => first.connection.state === "connected");
		second.connection.open({ port: bridge.port, token: TOKEN, sessionId: SESSION });
		await waitUntil(() => first.connection.state === "replaced" && second.connection.state === "connected");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.deepEqual(first.states, ["connecting", "connected", "replaced"]);
		assert.equal(second.connection.state, "connected");
		second.connection.close();
		await waitUntil(() => bridge.connected() === undefined);
		first.connection.ensure();
		await waitUntil(() => first.connection.state === "connected" && bridge.connected() !== undefined);
		assert.deepEqual(first.states, ["connecting", "connected", "replaced", "connecting", "connected"]);
	} finally {
		first.connection.close();
		second.connection.close();
		await bridge.close();
	}
});

test("ensure does not reconnect an unauthorized or untrusted connection", async () => {
	const replies: [string, (socket: WebSocket, message: any) => void][] = [
		["unauthorized", (socket, message) => {
			if (message.kind !== "hello") return socket.close(4401, "unauthorized");
			const serverNonce = randomBytes(32).toString("base64url");
			socket.send(JSON.stringify({ kind: "challenge", sessionId: SESSION, serverNonce, proof: proof(TOKEN, "server", message.clientNonce, serverNonce) }));
		}],
		["untrusted", (socket) => socket.send(JSON.stringify({ kind: "welcome" }))],
	];
	for (const [state, reply] of replies) {
		const fake = await fakeServer(reply);
		const { connection, states } = extension();
		try {
			connection.open({ port: fake.port, token: TOKEN, sessionId: SESSION });
			await waitUntil(() => connection.state === state);
			connection.ensure();
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.deepEqual(states, ["connecting", state], state);
			assert.equal(fake.connections(), 1, state);
		} finally {
			connection.close();
			await fake.close();
		}
	}
});

test("ensure does not reconnect after close", async () => {
	const bridge = await startBridge({ token: TOKEN, port: 0, sessionId: SESSION, handlers: {} });
	const { connection, states } = extension();
	try {
		connection.open({ port: bridge.port, token: TOKEN, sessionId: SESSION });
		await waitUntil(() => connection.state === "connected" && bridge.connected() !== undefined);
		connection.close();
		await waitUntil(() => bridge.connected() === undefined);
		connection.ensure();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(states, ["connecting", "connected", "off"]);
		assert.equal(bridge.connected(), undefined);
	} finally {
		connection.close();
		await bridge.close();
	}
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
