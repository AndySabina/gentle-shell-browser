import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { Peer } from "../extension/lib/rpc.js";
import { tokensEqual } from "./token.ts";

/**
 * Loopback WebSocket the Chrome extension connects to.
 *
 * Any web page can open a socket to localhost, so a client must pass two
 * checks: its Origin is a Chrome extension (checked before the upgrade), and
 * it proves it holds the pairing token without sending it:
 *
 *   client: {kind:"hello", version, build, clientNonce}
 *   server: {kind:"challenge", sessionId, serverNonce, proof: HMAC(token, "gentle-chrome/server\n" + clientNonce + "\n" + serverNonce + "\n" + sessionId)}
 *   client: {kind:"auth", proof: HMAC(token, "gentle-chrome/client\n" + clientNonce + "\n" + serverNonce + "\n" + sessionId)}
 *   server: {kind:"welcome"}
 *
 * The server proves itself first, so the extension never talks to a listener
 * that does not know the token. Both proofs bind the session id, so a proof
 * made for one Gentle Shell session is worthless to another. Only one extension is connected at a time; a
 * newer one replaces the older.
 */

export type Handler = (params: unknown) => unknown;

export interface ExtensionInfo {
	version: string;
	/** Content hash of the extension's files, from its build.json; "unknown" when it has none. */
	build: string;
}

export interface BridgeOptions {
	token: string;
	port: number;
	/** This Gentle Shell session's id, sent in the challenge and bound into both proofs. */
	sessionId: string;
	host?: string;
	handlers: Record<string, Handler>;
	helloTimeoutMs?: number;
	pingMs?: number;
	onConnectionChange?(info: ExtensionInfo | undefined): void;
}

export interface Bridge {
	port: number;
	connected(): ExtensionInfo | undefined;
	call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
	close(): Promise<void>;
}

export const NOT_CONNECTED = "Chrome is not connected. Make sure Chrome is open and the Gentle Shell extension is On (click its icon).";
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;
const CLOSE_TOO_BIG = 1009;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** What an unauthenticated client may send in total. */
const PRE_AUTH_MAX_BYTES = 4 * 1024;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** base64url HMAC-SHA256 that one side of the handshake sends, over both nonces and the session id. */
export function handshakeProof(token: string, side: "server" | "client", clientNonce: string, serverNonce: string, sessionId: string): string {
	return createHmac("sha256", token).update(`gentle-chrome/${side}\n${clientNonce}\n${serverNonce}\n${sessionId}`).digest("base64url");
}

function size(data: RawData): number {
	return Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
}

function parse(text: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

interface Client {
	socket: WebSocket;
	peer: Peer;
	info: ExtensionInfo;
}

function isExtensionOrigin(req: IncomingMessage): boolean {
	return /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? "");
}

export function startBridge(options: BridgeOptions): Promise<Bridge> {
	const host = options.host ?? "127.0.0.1";
	const helloTimeoutMs = options.helloTimeoutMs ?? 5000;
	const pingMs = options.pingMs ?? 20_000;
	let current: Client | undefined;

	const server = new WebSocketServer({
		host,
		port: options.port,
		maxPayload: MAX_PAYLOAD_BYTES,
		verifyClient: (info: { req: IncomingMessage }) => isExtensionOrigin(info.req),
	});

	const setCurrent = (client: Client | undefined) => {
		current = client;
		options.onConnectionChange?.(client?.info);
	};

	server.on("connection", (socket) => {
		let client: Client | undefined;
		let hello: { clientNonce: string; serverNonce: string; info: ExtensionInfo } | undefined;
		let received = 0;
		const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, "authentication required"), helloTimeoutMs);
		const refuse = (code = CLOSE_UNAUTHORIZED, reason = "unauthorized") => {
			clearTimeout(helloTimer);
			socket.close(code, reason);
		};

		socket.on("message", (data) => {
			if (client) return client.peer.receive(data.toString());
			received += size(data);
			if (received > PRE_AUTH_MAX_BYTES) return refuse(CLOSE_TOO_BIG, "too much data before authentication");
			const message = parse(data.toString());
			if (!hello) {
				if (message.kind !== "hello" || typeof message.clientNonce !== "string" || !NONCE.test(message.clientNonce)) return refuse();
				const serverNonce = randomBytes(32).toString("base64url");
				const info = {
					version: typeof message.version === "string" ? message.version : "unknown",
					build: typeof message.build === "string" ? message.build : "unknown",
				};
				hello = { clientNonce: message.clientNonce, serverNonce, info };
				const proof = handshakeProof(options.token, "server", hello.clientNonce, serverNonce, options.sessionId);
				socket.send(JSON.stringify({ kind: "challenge", sessionId: options.sessionId, serverNonce, proof }));
				return;
			}
			const expected = handshakeProof(options.token, "client", hello.clientNonce, hello.serverNonce, options.sessionId);
			if (message.kind !== "auth" || typeof message.proof !== "string" || !tokensEqual(message.proof, expected)) return refuse();
			clearTimeout(helloTimer);
			const peer = new Peer((text: string) => socket.send(text));
			for (const [method, handler] of Object.entries(options.handlers)) peer.handle(method, handler);
			client = { socket, peer, info: hello.info };
			const previous = current;
			setCurrent(client);
			socket.send(JSON.stringify({ kind: "welcome" }));
			if (previous) previous.socket.close(CLOSE_REPLACED, "replaced by a newer connection");
		});

		socket.on("close", () => {
			clearTimeout(helloTimer);
			if (!client) return;
			client.peer.close("Chrome disconnected");
			if (current === client) setCurrent(undefined);
		});
		socket.on("error", () => {});
	});

	// Traffic keeps the extension's service worker alive between commands.
	const pinger = setInterval(() => {
		if (current?.socket.readyState === current?.socket.OPEN) current?.socket.send(JSON.stringify({ kind: "ping" }));
	}, pingMs);
	pinger.unref();

	return new Promise((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			clearInterval(pinger);
			// Keeps the code so a port scan can tell a busy port from a real failure.
			reject(error.code === "EADDRINUSE" ? Object.assign(new Error(`Port ${options.port} is already in use (another Gentle Shell session may own the browser).`), { code: "EADDRINUSE" }) : error);
		});
		server.once("listening", () => {
			resolve({
				port: (server.address() as AddressInfo).port,
				connected: () => current?.info,
				call(method, params, callOptions) {
					if (!current) return Promise.reject(new Error(NOT_CONNECTED));
					return current.peer.call(method, params, callOptions);
				},
				close() {
					clearInterval(pinger);
					for (const socket of server.clients) socket.terminate();
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}
