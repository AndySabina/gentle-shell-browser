// Pauses document loads caused by Gentle Shell's actions until the permission
// mode allows them (policy.js decideStep, category "navigate"). Fetch interception is on only while an action runs on a tab
// (and a short grace period after it), so the user's own navigations are
// never paused. Only main-frame documents are checked; sub-frames continue.
// Service workers are bypassed meanwhile so their navigations reach Fetch;
// main-frame changes that still skip it (in-page routes, back-forward cache)
// are reported. A tab opened by the action (target=_blank, window.open,
// middle click) is kept out of the group until the same decision admits it,
// otherwise closed; one a group tab opens later is just taken out. With one
// group per session, `opened` looks up the opener's group.

import { decideStep, isRiskyPage, NOT_APPROVED, normalizeMode, readAnswer, siteOf, stepCategory } from "./policy.js";

const PATTERNS = [{ resourceType: "Document", requestStage: "Request" }];
const GRACE_MS = 1500;
const LOAD_TIMEOUT_MS = 15_000;
const NEW_TAB_WAIT_MS = 3000;
const LATE_GROUP_MS = 2000;

/**
 * @typedef {{
 *   send: (tabId: number, method: string, params?: object) => Promise<any>,
 *   on: (method: string, listener: (tabId: number, params: any) => unknown) => () => void,
 *   waitForEvent: (tabId: number, methods: string[], timeoutMs: number) => Promise<unknown>,
 *   isAttached: (tabId: number) => boolean,
 * }} GuardDebugger
 * @typedef {{level: string, riskyDomains: readonly string[], rules?: unknown}} Settings `level` holds the permission mode
 * @typedef {(site: string, category: string, decision: "allow" | "deny") => Promise<unknown>} SaveRule
 * @typedef {{kind: "navigate" | "open" | "action", title: string, detail: string, url: string, reason: string, level?: string, remember?: {site: string, category: string}}} ApprovalRequest
 *   `remember` (remember mode only) lets the user save the answer for that site and category
 * @typedef {{
 *   urls: Set<string>, passed: Set<string>, requests: Set<string>, networks: Set<string>, denied: Error | undefined,
 * }} Act one action: URLs the user approved, URLs let through, and the request and network ids of allowed loads (their redirects are covered)
 * @typedef {{tabId: number, url: string, added: boolean}} NewTab a tab the action opened and whether it joined the group
 * @typedef {{
 *   depth: number, mainFrame: string | undefined, url: string, act: Act, timer: ReturnType<typeof setTimeout> | undefined,
 *   queue: Promise<unknown>, pending: Set<Promise<unknown>>, loads: Promise<unknown>[], newTabs: NewTab[],
 *   unguarded: {url: string} | undefined, stopped: boolean, abort: () => void, aborted: Promise<false>,
 * }} Window
 * @typedef {{
 *   hold: (tabId: number) => Promise<void>,
 *   admit: (tabId: number) => Promise<void>,
 *   discard: (tabId: number) => Promise<void>,
 *   isHeld: (tabId: number) => boolean,
 *   contains: (tabId: number) => Promise<boolean>,
 *   evict: (tabId: number) => Promise<boolean>,
 * }} OpenedTabs the group side of new tabs (group.js)
 * @typedef {OpenedTabs | ((opener: number) => OpenedTabs | undefined)} OpenedLookup one group, or the group of each opener
 * @typedef {{timer: ReturnType<typeof setTimeout>, openerInGroup: Promise<boolean>, opened: OpenedTabs}} LateTab
 */

/** @param {string} url */
const isWeb = (url) => /^https?:\/\//i.test(url);

/** @param {string} url */
function withoutHash(url) {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.href;
	} catch {
		return url;
	}
}

/** @returns {Act} */
const newAct = () => ({ urls: new Set(), passed: new Set(), requests: new Set(), networks: new Set(), denied: undefined });

export class NavGuard {
	/**
	 * @param {{
	 *   cdp: GuardDebugger,
	 *   settings: () => Promise<Settings>,
	 *   approve: (request: ApprovalRequest, tabId: number) => Promise<unknown>,
	 *   saveRule?: SaveRule,
	 *   waiting?: (tabId: number) => unknown,
	 *   graceMs?: number,
	 *   opened?: OpenedLookup,
	 *   newTabWaitMs?: number,
	 *   lateGroupMs?: number,
	 * }} deps
	 */
	constructor(deps) {
		this.cdp = deps.cdp;
		this.settings = deps.settings;
		this.approve = deps.approve;
		this.saveRule = deps.saveRule;
		this.waiting = deps.waiting;
		this.graceMs = deps.graceMs ?? GRACE_MS;
		this.opened = deps.opened;
		this.newTabWaitMs = deps.newTabWaitMs ?? NEW_TAB_WAIT_MS;
		this.lateGroupMs = deps.lateGroupMs ?? LATE_GROUP_MS;
		/** @type {Map<number, Window>} */
		this.windows = new Map();
		/** @type {Map<number, (url: string) => void>} new tabs waiting for their first web address */
		this.addresses = new Map();
		/** @type {Map<number, LateTab>} tabs a group tab opened outside any action window */
		this.lateTabs = new Map();
		/** @type {Map<number, OpenedTabs>} undecided new tabs and the group that holds them */
		this.holders = new Map();
		this.cdp.on("Fetch.requestPaused", (tabId, params) => this.paused(tabId, params));
		this.cdp.on("Page.frameNavigated", (tabId, params) => {
			if (params?.frame?.parentId === undefined && !params?.frame?.unreachableUrl) this.navigated(tabId, params?.frame?.id, String(params?.frame?.url ?? ""), false);
		});
		this.cdp.on("Page.navigatedWithinDocument", (tabId, params) => this.navigated(tabId, params?.frameId, String(params?.url ?? ""), true));
	}

	/**
	 * Starts an action window on `tabId`: agent-caused document loads are paused
	 * from now until shortly after `end`. `allowedUrl` was already approved (or
	 * needs no approval) and is let through.
	 * @param {number} tabId
	 * @param {{allowedUrl?: string}} [options]
	 */
	async begin(tabId, options = {}) {
		let state = this.windows.get(tabId);
		const created = !state;
		if (!state) {
			/** @type {() => void} */
			let abort = () => {};
			/** @type {Promise<false>} */
			const aborted = new Promise((resolve) => (abort = () => resolve(false)));
			state = {
				depth: 0, mainFrame: undefined, url: "", act: newAct(), timer: undefined, queue: Promise.resolve(), pending: new Set(), loads: [], newTabs: [],
				unguarded: undefined, stopped: false, abort, aborted,
			};
			this.windows.set(tabId, state);
		}
		clearTimeout(state.timer);
		if (state.depth === 0) {
			try {
				const { frameTree } = await this.cdp.send(tabId, "Page.getFrameTree");
				state.mainFrame = frameTree.frame.id;
				state.url = withoutHash(String(frameTree.frame.url ?? ""));
				await this.cdp.send(tabId, "Page.enable");
				await this.cdp.send(tabId, "Network.enable");
				await this.cdp.send(tabId, "Network.setBypassServiceWorker", { bypass: true });
				await this.cdp.send(tabId, "Fetch.enable", { patterns: PATTERNS });
			} catch (error) {
				// Count the window only once it is set up, so a failure leaves nothing behind.
				if (state.depth === 0) {
					if (created) this.windows.delete(tabId);
					else state.timer = setTimeout(() => void this.close(tabId, /** @type {Window} */ (state)), this.graceMs);
				}
				throw error;
			}
			state.act = newAct();
			state.unguarded = undefined;
		}
		state.depth++;
		if (options.allowedUrl) state.act.urls.add(withoutHash(options.allowedUrl));
	}

	/** @param {number} tabId */
	end(tabId) {
		const state = this.windows.get(tabId);
		if (!state || --state.depth > 0) return;
		state.timer = setTimeout(() => void this.close(tabId, state), this.graceMs);
	}

	/**
	 * Waits for the pending decisions and approved loads of the current action;
	 * throws when the user denied one of its loads. Returns the tabs it opened.
	 * @param {number} tabId
	 * @returns {Promise<NewTab[]>}
	 */
	async drain(tabId) {
		const state = this.windows.get(tabId);
		if (!state) return [];
		while (state.pending.size) await Promise.allSettled([...state.pending]);
		await Promise.all(state.loads.splice(0));
		const newTabs = state.newTabs.splice(0);
		const denied = state.act.denied;
		state.act.denied = undefined;
		if (denied) throw denied;
		return newTabs;
	}

	/**
	 * A main-frame change in an action window that no paused load let
	 * through, taken once: in-page routes and back-forward cache restores
	 * never reach Fetch.
	 * @param {number} tabId
	 * @returns {{url: string} | undefined}
	 */
	unguarded(tabId) {
		const state = this.windows.get(tabId);
		const found = state?.unguarded;
		if (state) state.unguarded = undefined;
		return found;
	}

	/**
	 * @param {number} tabId
	 * @param {unknown} frameId
	 * @param {string} url
	 * @param {boolean} sameDocument
	 */
	navigated(tabId, frameId, url, sameDocument) {
		const state = this.windows.get(tabId);
		if (!state || frameId !== state.mainFrame || !isWeb(url)) return;
		const page = withoutHash(url);
		const previous = state.url;
		state.url = page;
		// A hash jump stays on the same page.
		if (sameDocument && page === previous) return;
		if (!sameDocument && (state.act.urls.has(page) || state.act.passed.has(page))) return;
		state.unguarded = { url };
	}

	/**
	 * chrome.tabs.onCreated. A tab opened from a tab in an action window is held
	 * out of the group at once, then admitted or closed by the permission mode.
	 * One opened from a group tab with no action running (a late window.open)
	 * is only taken out of the group. Any other tab is left alone.
	 * @param {chrome.tabs.Tab} tab
	 */
	created(tab) {
		const opener = tab.openerTabId;
		const state = opener === undefined ? undefined : this.windows.get(opener);
		const opened = opener === undefined ? undefined : this.openedFor(opener);
		if (!state && opened && tab.id !== undefined && opener !== undefined) return this.lateTab(tab.id, opener, opened);
		if (!state || !opened || tab.id === undefined || opener === undefined) return Promise.resolve();
		const tabId = tab.id;
		this.holders.set(tabId, opened);
		const held = opened.hold(tabId);
		const address = this.address(tabId, tab.pendingUrl || tab.url || "");
		const decision = state.queue.then(() => this.decideTab(opener, state, tabId, held, address, opened));
		state.queue = decision;
		state.pending.add(decision);
		return decision.finally(() => state.pending.delete(decision));
	}

	/**
	 * chrome.tabs.onUpdated: undoes Chrome putting an undecided tab back in the
	 * group, and gives a waiting new tab its web address.
	 * @param {number} tabId
	 * @param {{groupId?: number, url?: string}} change
	 */
	tabUpdated(tabId, change) {
		const holder = this.holders.get(tabId);
		if (change.groupId !== undefined && holder?.isHeld(tabId)) void holder.hold(tabId).catch(() => {});
		if (change.groupId !== undefined && this.lateTabs.has(tabId)) void this.evictLate(tabId);
		if (change.url && isWeb(change.url)) this.addresses.get(tabId)?.(change.url);
	}

	/**
	 * A tab a group tab opened outside an action window: if Chrome puts it in
	 * the group now or within `lateGroupMs`, it is taken out once, without
	 * asking. Dragging it back in later grants it.
	 * @param {number} tabId
	 * @param {number} opener
	 * @param {OpenedTabs} opened the opener's group
	 */
	lateTab(tabId, opener, opened) {
		const timer = setTimeout(() => this.lateTabs.delete(tabId), this.lateGroupMs);
		this.lateTabs.set(tabId, { timer, openerInGroup: opened.contains(opener).catch(() => false), opened });
		return this.evictLate(tabId);
	}

	/** @param {number} tabId */
	async evictLate(tabId) {
		const late = this.lateTabs.get(tabId);
		if (!late || !(await late.openerInGroup) || this.lateTabs.get(tabId) !== late) return;
		if (!(await late.opened.evict(tabId).catch(() => false))) return;
		// Once is enough: a later drag into the group is the user's grant.
		clearTimeout(late.timer);
		this.lateTabs.delete(tabId);
	}

	/**
	 * The group that decides tabs `opener` opens.
	 * @param {number} opener
	 * @returns {OpenedTabs | undefined}
	 */
	openedFor(opener) {
		return typeof this.opened === "function" ? this.opened(opener) : this.opened;
	}

	/**
	 * The first web address of a new tab: window.open often starts at about:blank.
	 * Resolves with whatever it has after `newTabWaitMs`.
	 * @param {number} tabId
	 * @param {string} url
	 * @returns {Promise<string>}
	 */
	address(tabId, url) {
		if (isWeb(url)) return Promise.resolve(url);
		return new Promise((resolve) => {
			/** @param {string} value */
			const done = (value) => {
				clearTimeout(timer);
				this.addresses.delete(tabId);
				resolve(value);
			};
			const timer = setTimeout(() => done(url), this.newTabWaitMs);
			this.addresses.set(tabId, done);
		});
	}

	/**
	 * Fails closed: anything but an allowed, admitted tab closes it.
	 * @param {number} opener the acting tab
	 * @param {Window} state
	 * @param {number} tabId
	 * @param {Promise<void>} held
	 * @param {Promise<string>} address
	 * @param {OpenedTabs} opened the opener's group
	 */
	async decideTab(opener, state, tabId, held, address, opened) {
		let url = "";
		let added = false;
		try {
			await held;
			url = await Promise.race([address, state.aborted.then(() => "")]);
			const settings = await this.settings();
			const web = isWeb(url);
			const reason = web ? stepCategory({ kind: "navigate", pageUrl: url, riskyDomains: settings.riskyDomains }).reason : "the new tab has no web address yet";
			const { verdict, mode, site } = this.verdict(settings, web ? url : "", reason);
			let allow = !verdict.ask && verdict.allow === true;
			if (verdict.ask && !state.stopped) {
				this.waiting?.(opener);
				/** @type {ApprovalRequest} */
				const request = {
					kind: "open",
					title: `open a new tab from this action: ${url || "about:blank"}`,
					detail: `Gentle Shell's last action in tab ${opener} opened tab ${tabId}. It stays out of the Gentle Shell group unless you allow it; otherwise it is closed.`,
					url,
					reason: verdict.reason,
					level: mode,
					...(mode === "remember" && site ? { remember: { site, category: "navigate" } } : {}),
				};
				allow = await Promise.race([this.ask(request, opener), state.aborted]);
			}
			if (allow && !state.stopped) {
				await opened.admit(tabId);
				added = true;
			}
		} catch {
			added = false;
		}
		if (!added) await opened.discard(tabId).catch(() => {});
		this.holders.delete(tabId);
		state.newTabs.push({ tabId, url, added });
	}

	/** STOP: fails every pending load and turns interception off everywhere. */
	async stop() {
		const windows = [...this.windows];
		this.windows.clear();
		for (const [, state] of windows) {
			clearTimeout(state.timer);
			state.stopped = true;
			state.abort();
		}
		for (const [tabId, state] of windows) {
			await Promise.allSettled([...state.pending]);
			await this.disable(tabId);
		}
	}

	/**
	 * Turns interception and the service worker bypass off.
	 * @param {number} tabId
	 */
	async disable(tabId) {
		// A detached tab has no interception left; sending would attach it again.
		if (!this.cdp.isAttached(tabId)) return;
		await this.cdp.send(tabId, "Fetch.disable").catch(() => {});
		await this.cdp.send(tabId, "Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
		await this.cdp.send(tabId, "Network.disable").catch(() => {});
	}

	/**
	 * @param {number} tabId
	 * @param {Window} state
	 */
	async close(tabId, state) {
		await Promise.allSettled([...state.pending]);
		if (state.depth > 0 || this.windows.get(tabId) !== state) return;
		this.windows.delete(tabId);
		await this.disable(tabId);
	}

	/**
	 * @param {number} tabId
	 * @param {any} params Fetch.requestPaused
	 */
	paused(tabId, params) {
		const state = this.windows.get(tabId);
		if (!state || params?.resourceType !== "Document" || params.frameId !== state.mainFrame) return this.release(tabId, params, true);
		const act = state.act;
		// One prompt at a time per tab.
		const decision = state.queue.then(() => this.decide(tabId, state, act, params));
		state.queue = decision;
		state.pending.add(decision);
		return decision.finally(() => state.pending.delete(decision));
	}

	/**
	 * @param {number} tabId
	 * @param {Window} state
	 * @param {Act} act
	 * @param {any} params
	 */
	async decide(tabId, state, act, params) {
		const url = String(params.request?.url ?? "");
		let allow = false;
		try {
			const settings = await this.settings();
			const { verdict, mode, site } = this.verdict(settings, url, stepCategory({ kind: "navigate", pageUrl: url, riskyDomains: settings.riskyDomains }).reason);
			// Covered: this exact URL was approved in this action, the mode allows it
			// without asking, or it is a redirect of an allowed load. A saved deny
			// refuses it. A risky page is covered only by its exact URL or the mode.
			const redirect = act.requests.has(String(params.redirectedRequestId ?? "")) || act.networks.has(String(params.networkId ?? ""));
			const approved = act.urls.has(withoutHash(url));
			const refused = !approved && !verdict.ask && !verdict.allow;
			const covered = approved || (!verdict.ask && verdict.allow === true) || (verdict.ask && redirect && !isRiskyPage(url, settings.riskyDomains).risky);
			if (refused) act.denied = new Error(`${NOT_APPROVED} load ${url} (${verdict.reason}). The page was not opened.`);
			else if (covered) allow = !state.stopped;
			else if (!state.stopped) {
				this.waiting?.(tabId);
				/** @type {ApprovalRequest} */
				const request = {
					kind: "navigate",
					title: `load ${url}`,
					detail: "The page is loading a new document after Gentle Shell's last action.",
					url,
					reason: verdict.reason,
					level: mode,
					...(mode === "remember" && site ? { remember: { site, category: "navigate" } } : {}),
				};
				allow = (await Promise.race([this.ask(request, tabId), state.aborted])) && !state.stopped;
				if (allow) {
					act.urls.add(withoutHash(url));
					state.loads.push(this.cdp.waitForEvent(tabId, ["Page.loadEventFired"], LOAD_TIMEOUT_MS));
				} else act.denied = new Error(`${NOT_APPROVED} load ${url}. The page was not opened.`);
			}
		} catch {
			allow = false;
			act.denied ??= new Error(`${NOT_APPROVED} load ${url}. The page was not opened.`);
		}
		if (allow) {
			act.passed.add(withoutHash(url));
			if (params.requestId) act.requests.add(String(params.requestId));
			if (params.networkId) act.networks.add(String(params.networkId));
		}
		await this.release(tabId, params, allow);
	}

	/**
	 * What the permission mode says about loading `url` (a navigate step on its site).
	 * @param {Settings} settings
	 * @param {string} url
	 * @param {string | undefined} reason the risk of the destination, shown when asking
	 */
	verdict({ level, rules }, url, reason) {
		const mode = normalizeMode(level);
		const site = siteOf(url);
		return { verdict: decideStep({ mode, site, category: "navigate", reason, rules }), mode, site };
	}

	/**
	 * Asks the session acting on `tabId`; true only for an explicit approval.
	 * A decision the user chose to remember is saved first. Fails closed.
	 * @param {ApprovalRequest} request
	 * @param {number} tabId
	 * @returns {Promise<boolean>}
	 */
	async ask(request, tabId) {
		const offered = request.remember;
		const { approved, remember } = await Promise.resolve()
			.then(() => this.approve(request, tabId))
			.then((value) => readAnswer(value, offered !== undefined), () => readAnswer(false, false));
		if (offered && remember) await Promise.resolve().then(() => this.saveRule?.(offered.site, offered.category, remember)).catch(() => {});
		return approved;
	}

	/**
	 * @param {number} tabId
	 * @param {any} params
	 * @param {boolean} allow
	 */
	async release(tabId, params, allow) {
		const requestId = params?.requestId;
		if (allow) await this.cdp.send(tabId, "Fetch.continueRequest", { requestId }).catch(() => {});
		else await this.cdp.send(tabId, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
	}
}
