// chrome.debugger (CDP) wrapper: attaches lazily (only to tabs the injected
// `canAttach` allows), tracks attached tabs, and runs our page scripts in an
// isolated world that the page's own JavaScript cannot see or tamper with.

const PROTOCOL_VERSION = "1.3";
const WORLD_NAME = "gentle-shell";

/**
 * @typedef {{
 *   debugger: Pick<typeof chrome.debugger, "attach" | "detach" | "sendCommand" | "onDetach" | "onEvent">,
 *   tabs: {onRemoved: typeof chrome.tabs.onRemoved},
 * }} DebuggerApi
 * @typedef {(tabId: number, params: any) => void} EventListener
 */

export class Debugger {
	/**
	 * @param {DebuggerApi} api
	 * @param {{canAttach?: (tabId: number) => Promise<boolean>}} [options] the group check, asked before every (re-)attach
	 */
	constructor(api, options = {}) {
		this.api = api;
		this.canAttach = options.canAttach ?? (async () => true);
		/** @type {Map<number, Promise<void>>} */
		this.attached = new Map();
		/** @type {Map<number, number>} isolated world execution context id per tab */
		this.worlds = new Map();
		/** @type {Set<string>} bindings exposed to our isolated world on every attach */
		this.bindings = new Set();
		/** @type {Map<string, Set<EventListener>>} */
		this.listeners = new Map();
		api.debugger.onDetach.addListener((source) => {
			if (source.tabId !== undefined) this.forget(source.tabId);
		});
		api.debugger.onEvent.addListener((source, method, params) => {
			if (source.tabId === undefined) return;
			for (const listener of this.listeners.get(method) ?? []) listener(source.tabId, params);
		});
		api.tabs.onRemoved.addListener((tabId) => this.forget(tabId));
	}

	/** @param {number} tabId */
	isAttached(tabId) {
		return this.attached.has(tabId);
	}

	/** @returns {number[]} */
	tabs() {
		return [...this.attached.keys()];
	}

	/**
	 * Exposes `globalThis[name]` to our isolated world in every tab attached
	 * from now on; calls arrive as `Runtime.bindingCalled` events. Page scripts
	 * cannot call it.
	 * @param {string} name
	 */
	bind(name) {
		this.bindings.add(name);
	}

	/**
	 * Subscribes to a CDP event from any attached tab. Returns the unsubscribe function.
	 * @param {string} method
	 * @param {EventListener} listener
	 */
	on(method, listener) {
		let set = this.listeners.get(method);
		if (!set) this.listeners.set(method, (set = new Set()));
		set.add(listener);
		return () => set.delete(listener);
	}

	/**
	 * Resolves with the first of `methods` fired by `tabId`, or undefined after `timeoutMs`.
	 * Subscribe before triggering the event.
	 * @param {number} tabId
	 * @param {string[]} methods
	 * @param {number} timeoutMs
	 * @returns {Promise<{method: string, params: any} | undefined>}
	 */
	waitForEvent(tabId, methods, timeoutMs) {
		return new Promise((resolve) => {
			/** @param {{method: string, params: any} | undefined} value */
			const done = (value) => {
				clearTimeout(timer);
				for (const off of offs) off();
				resolve(value);
			};
			const offs = methods.map((method) => this.on(method, (source, params) => source === tabId && done({ method, params })));
			const timer = setTimeout(() => done(undefined), timeoutMs);
		});
	}

	/** @param {number} tabId */
	attach(tabId) {
		let attaching = this.attached.get(tabId);
		if (!attaching) {
			attaching = Promise.resolve()
				.then(() => this.canAttach(tabId))
				.then((allowed) => {
					if (!allowed) throw new Error(`Tab ${tabId} is not in the Gentle Shell group; the debugger was not attached.`);
					return this.api.debugger.attach({ tabId }, PROTOCOL_VERSION);
				})
				.then(() =>
					this.install(tabId).catch(async (error) => {
						await this.api.debugger.detach({ tabId }).catch(() => {});
						throw error;
					}),
				);
			this.attached.set(tabId, attaching);
			attaching.catch(() => this.forget(tabId));
		}
		return attaching;
	}

	/**
	 * Makes the page behave as focused: with Chrome in the background (the user
	 * away from the screen), clicks would not move the focus and typing would
	 * reach nothing. Then adds the bindings before our isolated world is
	 * created, so the world has them.
	 * @param {number} tabId
	 */
	async install(tabId) {
		await this.api.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
		if (this.bindings.size === 0) return;
		await this.api.debugger.sendCommand({ tabId }, "Runtime.enable");
		for (const name of this.bindings) await this.api.debugger.sendCommand({ tabId }, "Runtime.addBinding", { name, executionContextName: WORLD_NAME });
	}

	/**
	 * @param {number} tabId
	 * @param {string} method
	 * @param {object} [params]
	 * @returns {Promise<any>}
	 */
	async send(tabId, method, params) {
		await this.attach(tabId);
		return this.api.debugger.sendCommand({ tabId }, method, params);
	}

	/** @param {number} tabId */
	async detach(tabId) {
		if (!this.attached.has(tabId)) return;
		this.forget(tabId);
		await this.api.debugger.detach({ tabId }).catch(() => {});
	}

	async detachAll() {
		await Promise.all(this.tabs().map((tabId) => this.detach(tabId)));
	}

	/**
	 * Evaluates `expression` in the main frame's isolated world and returns the
	 * value. A page exception is thrown as an Error.
	 * @param {number} tabId
	 * @param {string} expression
	 */
	async evaluate(tabId, expression) {
		for (let attempt = 0; ; attempt++) {
			const contextId = await this.world(tabId);
			let response;
			try {
				response = await this.send(tabId, "Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
			} catch (error) {
				// A navigation destroys the world; recreate it once.
				if (attempt === 0 && /context/i.test(error instanceof Error ? error.message : String(error))) {
					this.worlds.delete(tabId);
					continue;
				}
				throw error;
			}
			if (response.exceptionDetails) {
				const details = response.exceptionDetails;
				throw new Error(details.exception?.description ?? details.text ?? "Page script failed");
			}
			return response.result?.value;
		}
	}

	/**
	 * @param {number} tabId
	 * @returns {Promise<number>}
	 */
	async world(tabId) {
		const cached = this.worlds.get(tabId);
		if (cached !== undefined) return cached;
		const { frameTree } = await this.send(tabId, "Page.getFrameTree");
		const { executionContextId } = await this.send(tabId, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME });
		this.worlds.set(tabId, executionContextId);
		return executionContextId;
	}

	/** @param {number} tabId */
	forget(tabId) {
		this.attached.delete(tabId);
		this.worlds.delete(tabId);
	}
}
