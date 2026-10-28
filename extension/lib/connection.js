// The extension side of the bridge: connects to one Gentle Shell session,
// authenticates with the shared token from the native messaging host, and
// reconnects while open (a replaced connection only at the next ensure).
// The token never leaves the extension: the session first proves it knows the
// token (an HMAC over both nonces and its session id), then the extension
// proves it the same way. A listener that cannot prove it, or that names
// another session than the one asked for, is "untrusted" and is not retried.

import { Peer } from "./rpc.js";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;
const SERVER_PROOF = "gentle-chrome/server";
const CLIENT_PROOF = "gentle-chrome/client";

/**
 * @typedef {"off" | "connecting" | "connected" | "waiting" | "unauthorized" | "untrusted" | "replaced"} ConnectionState
 * @typedef {{
 *   createSocket: (url: string) => WebSocket,
 *   version: string,
 *   build?: string | (() => string | Promise<string>),
 *   handlers: Record<string, (params: any) => any>,
 *   onState?: (state: ConnectionState) => void,
 *   crypto?: Crypto,
 * }} ConnectionDeps
 * @typedef {{port: number, token: string, sessionId?: string}} Pairing
 */

/** @param {Uint8Array} bytes */
function base64url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} text
 * @returns {Uint8Array} throws when `text` is not base64url
 */
function fromBase64url(text) {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export class Connection {
	/** @param {ConnectionDeps} deps */
	constructor(deps) {
		this.deps = deps;
		/** @type {ConnectionState} */
		this.state = "off";
		/** @type {WebSocket | undefined} */
		this.socket = undefined;
		/** @type {Peer | undefined} */
		this.peer = undefined;
		/** @type {Pairing | undefined} */
		this.pairing = undefined;
		this.retryMs = RETRY_MIN_MS;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		this.retryTimer = undefined;
		this.crypto = deps.crypto ?? globalThis.crypto;
	}

	/**
	 * @param {Pairing} pairing `sessionId`, when given, is the only session
	 *   this connection accepts; without it, any session that knows the token.
	 */
	open(pairing) {
		this.pairing = pairing;
		this.retryMs = RETRY_MIN_MS;
		this.connect();
	}

	close() {
		this.pairing = undefined;
		clearTimeout(this.retryTimer);
		const socket = this.socket;
		this.drop("Disconnected from Gentle Shell");
		socket?.close();
		this.setState("off");
	}

	/** Reconnects if enabled and idle; safe to call from a periodic alarm. */
	ensure() {
		if (this.pairing && !this.socket) this.connect();
	}

	/**
	 * Calls a method on the Gentle Shell side.
	 * @param {string} method
	 * @param {unknown} params
	 * @param {{timeoutMs?: number}} [options]
	 */
	call(method, params, options) {
		if (this.state !== "connected" || !this.peer) return Promise.reject(new Error("Not connected to Gentle Shell"));
		return this.peer.call(method, params, options);
	}

	connect() {
		if (!this.pairing || this.socket) return;
		clearTimeout(this.retryTimer);
		const { port, token, sessionId: expectedSession } = this.pairing;
		this.setState("connecting");
		let socket;
		try {
			socket = this.deps.createSocket(`ws://127.0.0.1:${port}`);
		} catch {
			this.scheduleRetry();
			return;
		}
		this.socket = socket;
		const peer = new Peer((text) => socket.send(text));
		for (const [method, handler] of Object.entries(this.deps.handlers)) peer.handle(method, handler);
		const clientNonce = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
		/** @type {"challenge" | "welcome" | "done"} what the handshake waits for */
		let stage = "challenge";
		/** @type {Promise<void>} handshake messages are handled one at a time, in order */
		let handshake = Promise.resolve();

		/** @param {string} text */
		const authenticate = async (text) => {
			if (this.socket !== socket) return;
			const message = safeParse(text);
			if (stage === "challenge" && message?.kind === "challenge" && typeof message.sessionId === "string" && typeof message.serverNonce === "string" && typeof message.proof === "string") {
				const { sessionId, serverNonce } = message;
				if (expectedSession !== undefined && sessionId !== expectedSession) return this.distrust(socket);
				const key = await this.key(token);
				const proven = await this.verify(key, `${SERVER_PROOF}\n${clientNonce}\n${serverNonce}\n${sessionId}`, message.proof);
				if (this.socket !== socket) return;
				if (!proven) return this.distrust(socket);
				const proof = await this.sign(key, `${CLIENT_PROOF}\n${clientNonce}\n${serverNonce}\n${sessionId}`);
				if (this.socket !== socket) return;
				stage = "welcome";
				socket.send(JSON.stringify({ kind: "auth", proof }));
				return;
			}
			if (stage === "welcome" && message?.kind === "welcome") {
				stage = "done";
				this.peer = peer;
				this.retryMs = RETRY_MIN_MS;
				this.setState("connected");
				return;
			}
			// Anything else before the session proved itself: not our Gentle Shell.
			this.distrust(socket);
		};

		socket.onopen = async () => {
			const build = await this.build();
			if (this.socket !== socket) return;
			socket.send(JSON.stringify({ kind: "hello", version: this.deps.version, build, clientNonce }));
		};
		socket.onmessage = (event) => {
			const text = typeof event.data === "string" ? event.data : String(event.data);
			if (stage !== "done") {
				handshake = handshake.then(() => authenticate(text)).catch(() => this.distrust(socket));
				return;
			}
			if (safeKind(text) === "ping") return;
			peer.receive(text);
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			this.drop("Gentle Shell disconnected");
			if (!this.pairing) return this.setState("off");
			if (event.code === CLOSE_UNAUTHORIZED) {
				this.pairing = undefined;
				return this.setState("unauthorized");
			}
			// Another client took the session: no retry of our own, so two clients
			// do not replace each other in a loop; the next ensure() takes it back.
			if (event.code === CLOSE_REPLACED) return this.setState("replaced");
			this.scheduleRetry();
		};
		socket.onerror = () => {};
	}

	/** The build id from build.js (the build this code was installed with), or "unknown". */
	async build() {
		try {
			const build = typeof this.deps.build === "function" ? await this.deps.build() : this.deps.build;
			return typeof build === "string" && build ? build : "unknown";
		} catch {
			return "unknown";
		}
	}

	/**
	 * The listener could not prove it knows the token: close, and do not retry
	 * until it is opened again (the popup switch, or a new token).
	 * @param {WebSocket} socket
	 */
	distrust(socket) {
		if (this.socket !== socket) return;
		this.pairing = undefined;
		this.drop("Gentle Shell could not prove it is yours");
		socket.close();
		this.setState("untrusted");
	}

	/** @param {string} token */
	key(token) {
		return this.crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
	}

	/**
	 * @param {CryptoKey} key
	 * @param {string} text
	 */
	async sign(key, text) {
		return base64url(new Uint8Array(await this.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
	}

	/**
	 * Constant-time: WebCrypto compares the HMAC itself.
	 * @param {CryptoKey} key
	 * @param {string} text
	 * @param {string} proof base64url
	 */
	async verify(key, text, proof) {
		let signature;
		try {
			signature = fromBase64url(proof);
		} catch {
			return false;
		}
		return this.crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(text));
	}

	/** @param {string} reason */
	drop(reason) {
		this.peer?.close(reason);
		this.peer = undefined;
		this.socket = undefined;
	}

	scheduleRetry() {
		this.setState("waiting");
		this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
		this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
	}

	/** @param {ConnectionState} state */
	setState(state) {
		if (this.state === state) return;
		this.state = state;
		this.deps.onState?.(state);
	}
}

/**
 * @param {string} text
 * @returns {any}
 */
function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** @param {string} text */
function safeKind(text) {
	return safeParse(text)?.kind;
}
