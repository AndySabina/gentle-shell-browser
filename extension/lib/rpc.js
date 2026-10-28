// Symmetric JSON request/response over any text channel. Shared by the Pi
// extension (Node) and the Chrome extension service worker, so both sides
// speak exactly the same protocol.
//
//   request:  {"kind":"req","id":1,"method":"tabs","params":{}}
//   response: {"kind":"res","id":1,"ok":true,"result":...}
//             {"kind":"res","id":1,"ok":false,"error":"message"}

const DEFAULT_TIMEOUT_MS = 30_000;

/** A call that ended without an answer: it timed out or its signal aborted. The other side may still be working on it. */
export class Unanswered extends Error {}

export class Peer {
	/** @param {(text: string) => void} send */
	constructor(send) {
		this.send = send;
		this.nextId = 1;
		/** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
		this.pending = new Map();
		/** @type {Map<string, (params: any) => any>} */
		this.handlers = new Map();
	}

	/**
	 * @param {string} method
	 * @param {(params: any) => any} handler
	 */
	handle(method, handler) {
		this.handlers.set(method, handler);
	}

	/**
	 * @param {string} method
	 * @param {unknown} params
	 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
	 * @returns {Promise<any>}
	 */
	call(method, params, options = {}) {
		const { signal } = options;
		if (signal?.aborted) return Promise.reject(new Unanswered(`Cancelled waiting for ${method}`));
		const id = this.nextId++;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Unanswered(`Cancelled waiting for ${method}`));
			};
			const done = () => signal?.removeEventListener("abort", onAbort);
			const timer = setTimeout(() => {
				done();
				this.pending.delete(id);
				reject(new Unanswered(`Timed out waiting for ${method}`));
			}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (value) => (done(), resolve(value)),
				reject: (error) => (done(), reject(error)),
				timer,
			});
			try {
				this.send(JSON.stringify({ kind: "req", id, method, params }));
			} catch (error) {
				done();
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** @param {string} text */
	receive(text) {
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) return;
		if (message.kind === "res") this.settle(message);
		else if (message.kind === "req" && typeof message.method === "string") void this.dispatch(message);
	}

	/** @param {string} reason */
	close(reason) {
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(new Error(reason));
		}
		this.pending.clear();
	}

	/** @param {any} message */
	settle(message) {
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.ok) entry.resolve(message.result);
		else entry.reject(new Error(typeof message.error === "string" ? message.error : "Request failed"));
	}

	/** @param {any} message */
	async dispatch(message) {
		const handler = this.handlers.get(message.method);
		let reply;
		if (!handler) reply = { kind: "res", id: message.id, ok: false, error: `Unknown method: ${message.method}` };
		else {
			try {
				reply = { kind: "res", id: message.id, ok: true, result: await handler(message.params) };
			} catch (error) {
				reply = { kind: "res", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		try {
			this.send(JSON.stringify(reply));
		} catch {
			// The channel closed while the handler ran; nobody is waiting anymore.
		}
	}
}
