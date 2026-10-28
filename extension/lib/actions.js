// Input actions on a group tab: the ghost cursor glides to the target first,
// then real input goes through CDP so the page receives trusted events.
// Callers must have passed the tab through the group boundary already; it is
// checked again right before every input. One action runs at a time, across
// all sessions; each call may bring its session's group check, approval
// route and owner (`ActionScope`), so STOP can end one session's actions only.
// Every acting step goes through the permission mode the user chose (policy.js):
// it may wait for the user's approval in Gentle Shell, where in remember mode
// the user can save the decision for that site and kind of step. The agent's
// `risky: true` can only add an approval; it can never make a step less risky.

import { keyEvent } from "./keys.js";
import { pageInfoExpression, pageRiskExpression, resolveRefExpression } from "./page.js";
import { decideStep, isRiskyPage, NOT_APPROVED, normalizeMode, readAnswer, siteOf, stepCategory, WAITING_LABEL } from "./policy.js";

export const STOPPED = "Stopped by the user in Chrome.";
const SETTLE_MS = 600;
const LOAD_TIMEOUT_MS = 15_000;
const LOAD_EVENTS = ["Page.loadEventFired", "Page.navigatedWithinDocument"];
const BUTTONS = { left: 1, right: 2, middle: 4 };
const TARGET = "Pass either ref (from browser_snapshot) or both x and y.";
const SELECT_ALL = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
const MOVED = "The page moved under the cursor; take a new browser_snapshot.";

/**
 * @typedef {{
 *   send: (tabId: number, method: string, params?: object) => Promise<any>,
 *   evaluate: (tabId: number, expression: string) => Promise<any>,
 *   waitForEvent: (tabId: number, methods: string[], timeoutMs: number) => Promise<unknown>,
 *   tabs: () => number[],
 *   detachAll: () => Promise<void>,
 * }} ActionsDebugger
 * @typedef {{
 *   move: (tabId: number, x: number | null, y: number | null, label: string, rect?: Rect) => Promise<unknown>,
 *   clear: (tabId: number) => Promise<void>,
 * }} ActionsOverlay
 * @typedef {{left: number, top: number, width: number, height: number}} Rect
 * @typedef {{
 *   inGroup?: (tabId: number) => Promise<boolean>,
 *   approve?: (request: ApprovalRequest) => Promise<unknown>,
 *   owner?: string,
 * }} ActionScope the calling session's group check and approval route (the deps' when missing)
 *   and its id, which `stop(owner)` matches
 * @typedef {{active: boolean, stopped: Promise<never>, reject: (error: Error) => void, tabs: Set<number>} & ActionScope} Run
 *   one action; `tabs` are the tabs it touched
 * @typedef {import("./navguard.js").NewTab} NewTab
 * @typedef {import("./policy.js").Verdict} Verdict
 * @typedef {{url: string, title: string, urlChanged: boolean, newTabs?: NewTab[], unguardedNavigation?: {url: string}, risk?: Verdict}} ActionResult
 *   `risk` is set when the action loaded a page that looks risky
 * @typedef {{
 *   begin: (tabId: number, options?: {allowedUrl?: string}) => Promise<void>,
 *   end: (tabId: number) => void,
 *   drain: (tabId: number) => Promise<NewTab[] | void>,
 *   stop: () => Promise<void>,
 *   unguarded: (tabId: number) => {url: string} | undefined,
 * }} ActionsGuard the navigation guard (navguard.js)
 * @typedef {import("./navguard.js").ApprovalRequest} ApprovalRequest
 * @typedef {import("./navguard.js").Settings} Settings
 * @typedef {import("./navguard.js").SaveRule} SaveRule
 * @typedef {{
 *   cdp: ActionsDebugger,
 *   overlay: ActionsOverlay,
 *   sleep: (ms: number) => Promise<void>,
 *   settings: () => Promise<Settings>,
 *   approve: (request: ApprovalRequest) => Promise<unknown>,
 *   guard: ActionsGuard,
 *   inGroup: (tabId: number) => Promise<boolean>,
 *   saveRule?: SaveRule,
 * }} ActionsDeps `saveRule` stores a decision the user chose to remember
 */

/**
 * Runs inside the page. Self-contained: serialized with `.toString()`.
 * Facts the policy needs about the element behind `ref`, at (x, y), or
 * focused; null when there is none. Open shadow roots are searched; a
 * closed one (or a custom element) is reported as a shadow host.
 * @param {{ref?: string, x?: number, y?: number}} at
 */
function elementFacts(at) {
	const CONTROL = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[contenteditable]:not([contenteditable=false])";
	/** @type {Element | null | undefined} */
	let el;
	if (at.ref !== undefined) el = /** @type {any} */ (globalThis).__gentleRefs?.get(at.ref);
	else if (typeof at.x === "number" && typeof at.y === "number") {
		el = document.elementFromPoint(at.x, at.y);
		while (el?.shadowRoot) {
			const inner = el.shadowRoot.elementFromPoint(at.x, at.y);
			if (!inner || inner === el) break;
			el = inner;
		}
		el = el?.closest(CONTROL) ?? el;
	} else {
		el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
	}
	if (!el || !el.isConnected) return null;
	const html = /** @type {HTMLInputElement} */ (el);
	const tag = el.tagName.toLowerCase();
	const label = html.labels?.[0]?.innerText;
	const text = tag === "input" ? (["button", "submit", "reset"].includes(html.type) ? html.value : "") : /** @type {HTMLElement} */ (el).innerText;
	const raw = el.getAttribute("aria-label") || label || text || el.getAttribute("title") || el.getAttribute("placeholder") || "";
	const form = html.form ?? el.closest("form");
	const buttonType = tag === "button" ? (el.getAttribute("type") ?? "submit").toLowerCase() : tag === "input" ? html.type : "";
	// The attribute, not form.action: a field named "action" would shadow that property.
	/** @param {Element} owner */
	const actionOf = (owner) => {
		try {
			return new URL(owner.getAttribute("action") ?? "", document.baseURI).href;
		} catch {
			return "";
		}
	};
	/** @param {Element} field */
	const fieldFacts = (field) => ({ type: /** @type {HTMLInputElement} */ (field).type ?? "", autocomplete: field.getAttribute("autocomplete") ?? "", name: field.getAttribute("name") ?? "", id: field.id });
	return {
		tag,
		type: tag === "input" ? html.type : undefined,
		name: raw.replace(/\s+/g, " ").trim().slice(0, 200),
		autocomplete: el.getAttribute("autocomplete") ?? "",
		fieldName: el.getAttribute("name") ?? "",
		id: el.id,
		role: el.getAttribute("role") ?? "",
		editable: Boolean(/** @type {HTMLElement} */ (el).isContentEditable),
		isSubmit: Boolean(form) && ["submit", "image"].includes(buttonType),
		formFields: form ? [...form.querySelectorAll("input")].slice(0, 100).map(fieldFacts) : [],
		inForm: Boolean(form),
		formAction: form ? actionOf(form) : "",
		searchLandmark: Boolean(el.closest("[role=search], search")),
		shadowHost: Boolean(el.shadowRoot) || tag.includes("-"),
	};
}

/**
 * Expression for Debugger.evaluate that returns the element facts for the policy.
 * @param {{ref?: string, x?: number, y?: number}} at
 */
export function elementFactsExpression(at) {
	return `(${elementFacts.toString()})(${JSON.stringify(at)})`;
}

/**
 * Runs inside the page. Self-contained: serialized with `.toString()`.
 * Whether a press at (x, y) reaches the element behind `ref`: the topmost
 * element there is the element, inside it, or contains it. Open shadow roots
 * are searched; our overlay takes no pointer events, so it is never the hit.
 * @param {{ref: string, x: number, y: number}} at
 */
function hitTest(at) {
	const target = /** @type {any} */ (globalThis).__gentleRefs?.get(at.ref);
	if (!target || !target.isConnected) return false;
	let hit = document.elementFromPoint(at.x, at.y);
	while (hit?.shadowRoot) {
		const inner = hit.shadowRoot.elementFromPoint(at.x, at.y);
		if (!inner || inner === hit) break;
		hit = inner;
	}
	if (!hit) return false;
	/** @param {Node} node */
	const parent = (node) => node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
	for (let node = /** @type {Node | null} */ (hit); node; node = parent(node)) if (node === target) return true;
	for (let node = /** @type {Node | null} */ (target); node; node = parent(node)) if (node === hit) return true;
	return false;
}

/**
 * Expression for Debugger.evaluate: true when a press at (x, y) reaches the element behind `ref`.
 * @param {{ref: string, x: number, y: number}} at
 */
export function hitTestExpression(at) {
	return `(${hitTest.toString()})(${JSON.stringify(at)})`;
}

/**
 * Runs inside the page. Self-contained: serialized with `.toString()`.
 * What typing reaches: `{value}` of the focused text field or editable
 * element (through open shadow roots), `{none: true}` when no element has the
 * focus, and null when the focus is somewhere the page cannot read (a frame,
 * a closed shadow root, a non-text control).
 */
function focusedValue() {
	let active = document.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	if (!active || active === document.body || active === document.documentElement) return { none: true };
	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return { value: active.value };
	if (active instanceof HTMLElement && active.isContentEditable) return { value: active.innerText };
	return null;
}

/** Expression for Debugger.evaluate: what focusedValue returns. */
export function focusedValueExpression() {
	return `(${focusedValue.toString()})()`;
}

/**
 * Validates a URL Gentle Shell wants to open.
 * @param {unknown} value
 */
export function httpUrl(value) {
	let url;
	try {
		url = new URL(String(value));
	} catch {
		throw new Error(`Not a valid URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be opened, got: ${url.protocol}`);
	return url.href;
}

/** @param {string} url */
function shortUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname === "/" ? parsed.host : `${parsed.host}${parsed.pathname}`;
	} catch {
		return url;
	}
}

/** @param {string} url */
const unguardedLabel = (url) => `Page changed without approval → ${shortUrl(url)}`;

/**
 * @param {{x: number, y: number, name: string, left: number, top: number, width: number, height: number}} found what resolveRef returned
 * @returns {{x: number, y: number, name: string, rect: Rect}}
 */
const resolved = (found) => ({ x: found.x, y: found.y, name: found.name, rect: { left: found.left, top: found.top, width: found.width, height: found.height } });

/** @param {string | undefined} name */
const quoted = (name) => (name ? ` · ${JSON.stringify(name)}` : "");

/** @param {string} url */
function hostOf(url) {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

export class Actions {
	/** @param {ActionsDeps} deps */
	constructor(deps) {
		this.cdp = deps.cdp;
		this.overlay = deps.overlay;
		this.sleep = deps.sleep;
		this.settings = deps.settings;
		this.approve = deps.approve;
		this.guard = deps.guard;
		this.inGroup = deps.inGroup;
		this.saveRule = deps.saveRule;
		/** @type {Set<Run>} actions running or waiting their turn */
		this.runs = new Set();
		/** @type {Promise<void>} settles when the action before the newest one ended */
		this.queue = Promise.resolve();
	}

	/**
	 * @param {{tabId: number, ref?: string, x?: number, y?: number, button?: "left" | "right" | "middle", clickCount?: number, risky?: unknown}} params
	 * @param {ActionScope} [scope]
	 */
	async click(params, scope) {
		const { tabId, button = "left", clickCount = 1 } = params;
		if (!(button in BUTTONS)) throw new Error(`Unknown mouse button: ${button}`);
		if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) throw new Error("clickCount must be 1, 2 or 3.");
		return this.exclusive(async (run) => {
			run.tabs.add(tabId);
			const before = await this.info(run, tabId);
			const target = await this.target(run, tabId, params);
			const element = await this.facts(run, tabId, params.ref !== undefined ? { ref: params.ref } : { x: target.x, y: target.y });
			const label = `Click${target.name === undefined ? ` · (${target.x}, ${target.y})` : quoted(target.name)}`;
			await this.step(run, this.overlay.move(tabId, target.x, target.y, label, target.rect));
			const what = element?.name ? JSON.stringify(element.name) : `at (${target.x}, ${target.y})`;
			await this.check(run, tabId, { kind: "click", element, pageUrl: before.url, agentRisky: params.risky }, `click ${what} on ${hostOf(before.url)}`, { ...target, label });
			return this.guarded(run, tabId, {}, async () => {
				const at = params.ref === undefined ? target : await this.aim(run, tabId, params.ref, target, label);
				await this.press(run, tabId, at.x, at.y, button, clickCount);
				return this.settle(run, tabId, before);
			});
		}, scope);
	}

	/**
	 * @param {{tabId: number, ref?: string, text: string, clear?: boolean, submit?: boolean, risky?: unknown}} params
	 * @param {ActionScope} [scope]
	 */
	async type(params, scope) {
		const { tabId, ref, text, clear = false, submit = false } = params;
		if (typeof text !== "string") throw new Error("text must be a string.");
		return this.exclusive(async (run) => {
			run.tabs.add(tabId);
			const before = await this.info(run, tabId);
			const target = ref !== undefined ? await this.target(run, tabId, { ref }) : undefined;
			const element = await this.facts(run, tabId, ref !== undefined ? { ref } : {});
			const label = target ? `Type${quoted(target.name)}` : "Type";
			/** @type {{x: number | null, y: number | null, rect?: Rect}} */
			const at = target ?? { x: null, y: null };
			await this.step(run, this.overlay.move(tabId, at.x, at.y, label, at.rect));
			// Never the typed text: it may be a secret.
			const into = element?.name ? JSON.stringify(element.name) : "the focused field";
			await this.check(run, tabId, { kind: "type", element, submit, pageUrl: before.url, agentRisky: params.risky }, `type into ${into}${submit ? " and press Enter" : ""} on ${hostOf(before.url)}`, { ...at, label });
			return this.guarded(run, tabId, {}, async () => {
				if (target && ref !== undefined) {
					const field = await this.aim(run, tabId, ref, target, label);
					await this.press(run, tabId, field.x, field.y, "left", 1);
				}
				if (clear) {
					await this.keyPress(run, tabId, SELECT_ALL, ["selectAll"]);
					if (!text) await this.keyPress(run, tabId, keyEvent("Backspace"));
				}
				/** @type {{verified: true} | {unverified: string} | {}} */
				let check = {};
				if (text) {
					const was = await this.focused(run, tabId);
					await this.input(run, tabId, "Input.insertText", { text });
					const now = await this.focused(run, tabId);
					if (was.none && now.none) throw new Error("No field has the focus, so nothing was typed. Pass the field's ref from a new browser_snapshot.");
					const unreadable = was.unreadable ?? now.unreadable;
					if (unreadable) check = { unverified: unreadable };
					else if (was.value === now.value) {
						throw new Error(`The text did not reach ${into}: the field's value did not change. Take a new browser_snapshot and pass the field's ref.`);
					} else check = { verified: true };
				}
				if (submit) await this.keyPress(run, tabId, keyEvent("Enter"));
				return { ...(await this.settle(run, tabId, before)), ...check };
			});
		}, scope);
	}

	/**
	 * @param {{tabId: number, key: string, risky?: unknown}} params
	 * @param {ActionScope} [scope]
	 */
	async key(params, scope) {
		const { tabId, key } = params;
		const event = keyEvent(key);
		return this.exclusive(async (run) => {
			run.tabs.add(tabId);
			const before = await this.info(run, tabId);
			const element = await this.facts(run, tabId, {});
			const label = `Key · ${key}`;
			await this.step(run, this.overlay.move(tabId, null, null, label));
			const where = element?.name ? ` in ${JSON.stringify(element.name)}` : "";
			await this.check(run, tabId, { kind: "key", key, element, pageUrl: before.url, agentRisky: params.risky }, `press ${key}${where} on ${hostOf(before.url)}`, { x: null, y: null, label });
			return this.guarded(run, tabId, {}, async () => {
				await this.keyPress(run, tabId, event);
				return this.settle(run, tabId, before);
			});
		}, scope);
	}

	/**
	 * @param {{tabId: number, ref?: string, x?: number, y?: number, deltaX?: number, deltaY?: number}} params
	 * @param {ActionScope} [scope]
	 */
	async scroll(params, scope) {
		const { tabId, deltaX = 0, deltaY = 0 } = params;
		if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) throw new Error("Pass a non-zero deltaX or deltaY.");
		return this.exclusive(async (run) => {
			run.tabs.add(tabId);
			const before = await this.info(run, tabId);
			const point =
				params.ref === undefined && params.x === undefined && params.y === undefined
					? { x: Math.round(before.width / 2), y: Math.round(before.height / 2), rect: undefined }
					: await this.target(run, tabId, params);
			const arrows = [deltaY > 0 ? "↓" : deltaY < 0 ? "↑" : "", deltaX > 0 ? "→" : deltaX < 0 ? "←" : ""].join("");
			const label = `Scroll ${arrows}`;
			await this.step(run, this.overlay.move(tabId, point.x, point.y, label, point.rect));
			await this.check(run, tabId, { kind: "scroll", pageUrl: before.url }, `scroll on ${hostOf(before.url)}`, { ...point, label });
			await this.input(run, tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
			return this.settle(run, tabId, before);
		}, scope);
	}

	/**
	 * @param {{tabId: number, url?: string, action?: "back" | "forward" | "reload", risky?: unknown}} params
	 * @param {ActionScope} [scope]
	 */
	async navigate(params, scope) {
		const { tabId, action } = params;
		const hasUrl = params.url !== undefined;
		if (hasUrl === (action !== undefined) || (action !== undefined && !["back", "forward", "reload"].includes(action))) {
			throw new Error('Pass either url or action ("back", "forward" or "reload").');
		}
		const url = hasUrl ? httpUrl(params.url) : undefined;
		return this.exclusive(async (run) => {
			run.tabs.add(tabId);
			const label = url ? `Navigate · ${new URL(url).host}` : `Navigate · ${action}`;
			await this.step(run, this.overlay.move(tabId, null, null, label));
			let destination = url;
			let entryId;
			if (action) {
				const history = await this.step(run, this.cdp.send(tabId, "Page.getNavigationHistory"));
				const entry = history.entries[history.currentIndex + (action === "back" ? -1 : action === "forward" ? 1 : 0)];
				if (!entry) throw new Error(`There is no page to go ${action} to.`);
				entryId = entry.id;
				destination = entry.url;
			}
			const target = String(destination);
			const title = url ? `open ${url} in tab ${tabId}` : `${action === "reload" ? "reload" : `go ${action} to`} ${target} in tab ${tabId}`;
			await this.checkNavigation(run, tabId, { kind: "navigate", title, detail: `Navigate tab ${tabId}.`, url: target }, label, params.risky);
			return this.load(run, tabId, target, async () => {
				if (url) return this.input(run, tabId, "Page.navigate", { url });
				if (action === "reload") return this.input(run, tabId, "Page.reload");
				return this.input(run, tabId, "Page.navigateToHistoryEntry", { entryId });
			});
		}, scope);
	}

	/**
	 * browser_act open: asks before the tab exists, creates it empty with
	 * `createTab`, then loads `url` in it under the navigation guard.
	 * @param {string} url validated http(s) URL
	 * @param {() => Promise<{tabId: number, groupId: number}>} createTab
	 * @param {{risky?: unknown} & ActionScope} [options] `risky: true` from the agent asks even over a saved allow
	 */
	open(url, createTab, options = {}) {
		const { risky, ...scope } = options;
		return this.exclusive(async (run) => {
			await this.checkNavigation(run, undefined, { kind: "open", title: `open ${url} in a new tab`, detail: "Open a new tab in the Gentle Shell group.", url }, undefined, risky);
			const opened = await this.step(run, createTab());
			run.tabs.add(opened.tabId);
			await this.step(run, this.overlay.move(opened.tabId, null, null, `Open · ${hostOf(url)}`).catch(() => {}));
			await this.load(run, opened.tabId, url, () => this.input(run, opened.tabId, "Page.navigate", { url }));
			return opened;
		}, scope);
	}

	/**
	 * Runs `start` (which begins a document load) inside a guard window that
	 * already allows `allowedUrl`, then waits for the load.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {string} allowedUrl
	 * @param {() => Promise<any>} start
	 */
	load(run, tabId, allowedUrl, start) {
		return this.guarded(run, tabId, { allowedUrl }, async () => {
			await this.input(run, tabId, "Page.enable");
			const loaded = this.cdp.waitForEvent(tabId, LOAD_EVENTS, LOAD_TIMEOUT_MS);
			const response = await start();
			if (response?.errorText) {
				// A redirect the user denied fails the navigation: report the denial first.
				await this.step(run, this.guard.drain(tabId));
				throw new Error(`Could not open ${allowedUrl}: ${response.errorText}`);
			}
			await this.step(run, loaded);
			const newTabs = await this.step(run, this.guard.drain(tabId));
			const unguarded = this.guard.unguarded(tabId);
			const { url: now, title } = await this.info(run, tabId);
			// Never pauses: a risky page makes the next action on it ask.
			const risk = await this.pageRisk(run, tabId, now);
			if (unguarded) await this.step(run, this.overlay.move(tabId, null, null, unguardedLabel(unguarded.url)).catch(() => {}));
			return { url: now, title, ...(newTabs?.length ? { newTabs } : {}), ...(unguarded ? { unguardedNavigation: unguarded } : {}), ...(risk.risky ? { risk } : {}) };
		});
	}

	/**
	 * STOP: the in-flight action and the ones waiting their turn reject before
	 * sending more input; later actions work. Without `owner` (STOP in the
	 * popup) that is every action, the overlay disappears and the debugger
	 * leaves every tab. With `owner` (a session's page STOP or disconnect) only
	 * that session's actions stop; while another session's action remains, only
	 * the cursor leaves the stopped actions' tabs and the navigation guard and
	 * debugger stay for the other one.
	 * @param {string} [owner]
	 */
	async stop(owner) {
		const stopped = [...this.runs].filter((run) => owner === undefined || run.owner === owner);
		for (const run of stopped) {
			this.runs.delete(run);
			run.active = false;
			run.reject(new Error(STOPPED));
		}
		if (this.runs.size > 0) {
			const tabs = new Set(stopped.flatMap((run) => [...run.tabs]));
			for (const tabId of tabs) await this.overlay.clear(tabId).catch(() => {});
			return;
		}
		// Pending loads fail before the debugger leaves; detaching would let them through.
		await this.guard.stop().catch(() => {});
		for (const tabId of this.cdp.tabs()) await this.overlay.clear(tabId).catch(() => {});
		await this.cdp.detachAll();
	}

	/**
	 * Runs `task` after every action started before it has ended. STOP fails
	 * the running action and every one waiting its turn, or only its owner's.
	 * @template T
	 * @param {(run: Run) => Promise<T>} task
	 * @param {ActionScope} [scope] bound to this action only: the next one may come from another session
	 * @returns {Promise<T>}
	 */
	async exclusive(task, scope = {}) {
		/** @type {(error: Error) => void} */
		let reject = () => {};
		/** @type {Promise<never>} */
		const stopped = new Promise((_resolve, fail) => (reject = fail));
		stopped.catch(() => {});
		/** @type {Run} */
		const run = { active: true, stopped, reject, tabs: new Set(), inGroup: scope.inGroup, approve: scope.approve, owner: scope.owner };
		this.runs.add(run);
		const previous = this.queue;
		/** @type {() => void} */
		let done = () => {};
		this.queue = new Promise((resolve) => (done = resolve));
		let started = false;
		try {
			await this.step(run, previous);
			started = true;
			return await task(run);
		} finally {
			this.runs.delete(run);
			// Stopped while waiting its turn: hand the turn on only once the action
			// ahead has ended, or the one behind would run next to it.
			if (started) done();
			else void previous.then(done);
		}
	}

	/**
	 * Awaits `promise` unless STOP comes first.
	 * @template T
	 * @param {Run} run
	 * @param {Promise<T>} promise
	 * @returns {Promise<T>}
	 */
	async step(run, promise) {
		const value = await Promise.race([promise, run.stopped]);
		if (!run.active) throw new Error(STOPPED);
		return value;
	}

	/**
	 * What typing reaches in the tab (see focusedValue); `unreadable` says why it could not be read.
	 * @param {Run} run
	 * @param {number} tabId
	 * @returns {Promise<{value?: string, none?: boolean, unreadable?: string}>}
	 */
	async focused(run, tabId) {
		const found = await this.step(
			run,
			this.cdp.evaluate(tabId, focusedValueExpression()).catch((error) => ({ unreadable: `the page check failed: ${error instanceof Error ? error.message : String(error)}` })),
		);
		return found && typeof found === "object" ? found : { unreadable: "the focused element is not a text field the page can read" };
	}

	/**
	 * Sends one input command; never after STOP, and never to a tab that left the group.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {string} method
	 * @param {object} [params]
	 */
	async input(run, tabId, method, params) {
		if (!run.active) throw new Error(STOPPED);
		await this.member(run, tabId);
		return this.step(run, this.cdp.send(tabId, method, params));
	}

	/**
	 * Throws when the user took the tab out of the group since the action started.
	 * @param {Run} run
	 * @param {number} tabId
	 */
	async member(run, tabId) {
		if (!(await this.step(run, (run.inGroup ?? this.inGroup)(tabId)))) throw new Error(`Tab ${tabId} left the Gentle Shell group; the action was cancelled.`);
	}

	/**
	 * Decides the action by the permission mode, reading the page content
	 * right before deciding, and asks the user when the mode says so.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {Omit<import("./policy.js").Action, "riskyDomains" | "pageSignals">} action
	 * @param {string} title what the user is asked to allow
	 * @param {{x: number | null, y: number | null, rect?: Rect, label: string}} at where the cursor is
	 */
	async check(run, tabId, action, title, at) {
		const pageSignals = await this.signals(run, tabId);
		const settings = await this.step(run, this.settings());
		const { agentRisky, ...facts } = action;
		const step = stepCategory({ ...facts, riskyDomains: settings.riskyDomains, pageSignals });
		const detail = `${action.kind[0].toUpperCase()}${action.kind.slice(1)} in tab ${tabId}.`;
		await this.decide(run, tabId, { kind: "action", title, detail, url: action.pageUrl }, step, settings, agentRisky, at);
	}

	/**
	 * Decides a navigation to `request.url` by the permission mode.
	 * @param {Run} run
	 * @param {number | undefined} tabId
	 * @param {Omit<ApprovalRequest, "reason" | "level">} request
	 * @param {string} [label] the cursor label to restore afterwards
	 * @param {unknown} [agentRisky] `true` when the agent marked the step as sensitive
	 */
	async checkNavigation(run, tabId, request, label, agentRisky) {
		const settings = await this.step(run, this.settings());
		const step = stepCategory({ kind: "navigate", pageUrl: request.url, riskyDomains: settings.riskyDomains });
		await this.decide(run, tabId, request, step, settings, agentRisky, label === undefined ? undefined : { x: null, y: null, label });
	}

	/**
	 * Goes ahead, refuses (a saved deny) or asks, as decideStep says for the
	 * step's site and category. In remember mode the request offers to save
	 * the answer for that site and category.
	 * @param {Run} run
	 * @param {number | undefined} tabId
	 * @param {Omit<ApprovalRequest, "reason" | "level">} request
	 * @param {ReturnType<typeof stepCategory>} step
	 * @param {Settings} settings
	 * @param {unknown} agentRisky
	 * @param {{x: number | null, y: number | null, rect?: Rect, label: string}} [at]
	 */
	async decide(run, tabId, request, step, { level, rules }, agentRisky, at) {
		const mode = normalizeMode(level);
		const site = siteOf(request.url);
		// Content that could not be read is never covered by a saved allow.
		const verdict = decideStep({ mode, site, category: step.category, reason: step.reason, rules, agentRisky: agentRisky === true || step.unsure === true });
		if (!verdict.ask) {
			if (verdict.allow) return;
			throw new Error(`${NOT_APPROVED} ${request.title} (${verdict.reason}). Do not retry this step unless the user asks.`);
		}
		const remember = mode === "remember" && site ? { remember: { site, category: step.category } } : {};
		await this.ask(run, tabId, { ...request, reason: verdict.reason, level: mode, ...remember }, at);
	}

	/**
	 * Shows the waiting label, asks Gentle Shell and throws unless the user
	 * allowed this exact step. A decision the user chose to remember is saved
	 * first. STOP while waiting rejects.
	 * @param {Run} run
	 * @param {number | undefined} tabId
	 * @param {ApprovalRequest} request
	 * @param {{x: number | null, y: number | null, rect?: Rect, label: string}} [at]
	 */
	async ask(run, tabId, request, at) {
		if (tabId !== undefined && at) await this.step(run, this.overlay.move(tabId, at.x, at.y, WAITING_LABEL, at.rect).catch(() => {}));
		const offered = request.remember;
		const answer = Promise.resolve()
			.then(() => (run.approve ?? this.approve)(request))
			.then((value) => readAnswer(value, offered !== undefined), () => readAnswer(false, false));
		const { approved, remember } = await this.step(run, answer);
		if (offered && remember) await this.step(run, Promise.resolve().then(() => this.saveRule?.(offered.site, offered.category, remember)).catch(() => {}));
		if (!approved) throw new Error(`${NOT_APPROVED} ${request.title}. Do not retry this step unless the user asks.`);
		if (tabId !== undefined && at) await this.step(run, this.overlay.move(tabId, at.x, at.y, at.label, at.rect).catch(() => {}));
	}

	/**
	 * Runs `task` with the navigation guard on, so document loads it causes wait for the policy.
	 * @template T
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{allowedUrl?: string}} options
	 * @param {() => Promise<T>} task
	 * @returns {Promise<T>}
	 */
	async guarded(run, tabId, options, task) {
		// After any approval wait: a tab that left the group is not touched again.
		await this.member(run, tabId);
		await this.step(run, this.guard.begin(tabId, options));
		try {
			return await task();
		} finally {
			this.guard.end(tabId);
		}
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{ref?: string, x?: number, y?: number}} at
	 * @returns {Promise<import("./policy.js").ElementFacts | null>}
	 */
	facts(run, tabId, at) {
		return this.step(run, this.cdp.evaluate(tabId, elementFactsExpression(at)));
	}

	/**
	 * The page risk signals; null when the page could not be read, which the policy treats as risky.
	 * @param {Run} run
	 * @param {number} tabId
	 * @returns {Promise<unknown>}
	 */
	signals(run, tabId) {
		return this.step(run, Promise.resolve().then(() => this.cdp.evaluate(tabId, pageRiskExpression())).catch(() => null));
	}

	/**
	 * Whether the page now in the tab looks risky, by address or content.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {string} url
	 * @returns {Promise<Verdict>}
	 */
	async pageRisk(run, tabId, url) {
		const signals = await this.signals(run, tabId);
		const { riskyDomains } = await this.step(run, this.settings());
		return isRiskyPage(url, riskyDomains, signals);
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{ref?: string, x?: number, y?: number}} params
	 * @returns {Promise<{x: number, y: number, name?: string, rect?: Rect}>}
	 */
	async target(run, tabId, { ref, x, y }) {
		if (ref !== undefined) {
			if (typeof ref !== "string" || !ref || x !== undefined || y !== undefined) throw new Error(TARGET);
			const found = await this.step(run, this.cdp.evaluate(tabId, resolveRefExpression(ref)));
			if (!found) throw new Error(`Element reference ${ref} is stale or unknown. Take a new browser_snapshot.`);
			return resolved(found);
		}
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(TARGET);
		return { x, y };
	}

	/**
	 * Right before pressing: the element under (x, y) must still be the ref's.
	 * Otherwise the ref is resolved once more and the cursor glides there; if it
	 * is still covered, nothing is pressed.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {string} ref
	 * @param {{x: number, y: number}} target
	 * @param {string} label
	 * @returns {Promise<{x: number, y: number}>}
	 */
	async aim(run, tabId, ref, target, label) {
		if (await this.step(run, this.cdp.evaluate(tabId, hitTestExpression({ ref, x: target.x, y: target.y })))) return target;
		const found = await this.step(run, this.cdp.evaluate(tabId, resolveRefExpression(ref)));
		if (found) {
			const again = resolved(found);
			await this.step(run, this.overlay.move(tabId, again.x, again.y, label, again.rect));
			if (await this.step(run, this.cdp.evaluate(tabId, hitTestExpression({ ref, x: again.x, y: again.y })))) return again;
		}
		throw new Error(MOVED);
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {number} x
	 * @param {number} y
	 * @param {"left" | "right" | "middle"} button
	 * @param {number} clickCount
	 */
	async press(run, tabId, x, y, button, clickCount) {
		await this.input(run, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
		await this.input(run, tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: BUTTONS[button], clickCount });
		await this.input(run, tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, text?: string}} event
	 * @param {string[]} [commands] editor commands such as "selectAll"
	 */
	async keyPress(run, tabId, event, commands) {
		const { text, ...base } = event;
		const down = text ? { type: "keyDown", ...base, text, unmodifiedText: text } : { type: "rawKeyDown", ...base };
		await this.input(run, tabId, "Input.dispatchKeyEvent", commands ? { ...down, commands } : down);
		await this.input(run, tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @returns {Promise<{url: string, title: string, width: number, height: number}>}
	 */
	info(run, tabId) {
		return this.step(run, this.cdp.evaluate(tabId, pageInfoExpression()));
	}

	/**
	 * Lets the page react, then reports where it is. SPA route changes cannot
	 * be paused, so a changed URL is at least shown to the user.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{url: string}} before
	 * @returns {Promise<ActionResult>}
	 */
	async settle(run, tabId, before) {
		await this.step(run, this.sleep(SETTLE_MS));
		// Waits for loads and new tabs the guard holds for approval; throws if the user denied a load.
		const newTabs = await this.step(run, this.guard.drain(tabId));
		const unguarded = this.guard.unguarded(tabId);
		const { url, title } = await this.info(run, tabId);
		const urlChanged = url !== before.url;
		// A new page never pauses here: if it looks risky, the next action on it asks.
		const risk = urlChanged ? await this.pageRisk(run, tabId, url) : undefined;
		const label = unguarded ? unguardedLabel(unguarded.url) : urlChanged ? `URL changed → ${shortUrl(url)}` : undefined;
		if (label) await this.step(run, this.overlay.move(tabId, null, null, label).catch(() => {}));
		return { url, title, urlChanged, ...(newTabs?.length ? { newTabs } : {}), ...(unguarded ? { unguardedNavigation: unguarded } : {}), ...(risk?.risky ? { risk } : {}) };
	}
}
