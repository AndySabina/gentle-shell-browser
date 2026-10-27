// The live Gentle Shell sessions: the native messaging host ("dev.gentle.shell")
// lists them with the shared token; the extension connects to each one and
// gives it its own tab group, "Gentle · <name>". A session reads and acts only
// on its own group; approvals and STOP go to the session that started the
// action. A session that disappears keeps its group, renamed "… (ended)";
// no live session's title ends that way, so an ended group is never adopted.

import { httpUrl } from "./actions.js";
import { pageRiskExpression, snapshotExpression } from "./page.js";
import { isRiskyPage, readAnswer } from "./policy.js";

export const HELPER = "dev.gentle.shell";
export const HELPER_MISSING = "Gentle Shell helper not installed — run scripts/install-extension.sh once";
export const INVALID_REPLY = "Gentle Shell helper sent an invalid reply";
const FIRST_PORT = 48733;
const LAST_PORT = 48832;
const MAX_SESSIONS = 100;
const MAX_NAME = 60;
const TOKEN = /^[A-Za-z0-9_-]{32,}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const GROUPS_KEY = "groups";
const LIVE_KEY = "liveSessions";
const ENDED = "(ended)";
const ENABLED_KEY = "enabled";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const SCREENSHOT_TIMEOUT_MS = 5000;

/**
 * @typedef {{id: string, name: string, port: number}} SessionInfo
 * @typedef {{token: string, sessions: SessionInfo[]}} Discovery
 * @typedef {import("./connection.js").ConnectionState} ConnectionState
 * @typedef {{
 *   state: ConnectionState | string,
 *   open: (pairing: {port: number, token: string, sessionId: string}) => void,
 *   close: () => void,
 *   ensure: () => void,
 *   call: (method: string, params: unknown, options?: {timeoutMs?: number}) => Promise<any>,
 * }} SessionConnection the parts of Connection the manager uses
 * @typedef {import("./group.js").TabGroup} TabGroup
 * @typedef {SessionInfo & {title: string, group: TabGroup, connection: SessionConnection | undefined, running: number}} Session
 * @typedef {import("./navguard.js").ApprovalRequest} ApprovalRequest
 * @typedef {import("./navguard.js").OpenedTabs} OpenedTabs
 * @typedef {{get: (keys: Record<string, unknown>) => Promise<Record<string, any>>, set: (items: Record<string, unknown>) => Promise<void>}} Storage
 * @typedef {{
 *   createConnection: (session: Session) => SessionConnection,
 *   createGroup: (options: import("./group.js").GroupOptions) => TabGroup,
 *   storage: Storage,
 *   stopActions?: (owner?: string) => Promise<void>,
 * }} ManagerDeps
 */

/**
 * Validates the helper's reply: a malformed reply throws; a session entry
 * that is not valid (or repeats an id) is skipped, so the others still connect.
 * @param {unknown} reply
 * @returns {Discovery}
 */
export function parseDiscovery(reply) {
	const invalid = () => new Error(INVALID_REPLY);
	if (!reply || typeof reply !== "object") throw invalid();
	const { token, sessions } = /** @type {{token?: unknown, sessions?: unknown}} */ (reply);
	if (typeof token !== "string" || !TOKEN.test(token)) throw invalid();
	if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) throw invalid();
	const ids = new Set();
	/** @type {SessionInfo[]} */
	const parsed = [];
	for (const session of sessions) {
		if (!session || typeof session !== "object") continue;
		const { id, name, port } = session;
		if (typeof id !== "string" || !SESSION_ID.test(id) || ids.has(id)) continue;
		if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME) continue;
		if (!Number.isInteger(port) || port < FIRST_PORT || port > LAST_PORT) continue;
		ids.add(id);
		parsed.push({ id, name, port });
	}
	return { token, sessions: parsed };
}

/**
 * "Gentle · <name>". A name ending in "(ended)" ends in "(ended session)"
 * instead, so a live title never looks like an ended group's.
 * @param {string} name
 */
const baseTitle = (name) => `Gentle · ${name.endsWith(ENDED) ? `${name.slice(0, -ENDED.length)}(ended session)` : name}`;

export class SessionManager {
	/** @param {ManagerDeps} deps */
	constructor(deps) {
		this.deps = deps;
		/** @type {Map<string, Session>} live sessions, in discovery order */
		this.sessions = new Map();
		/** @type {Map<number, Session>} the session that last read or acted on each tab */
		this.owners = new Map();
		/** @type {string | undefined} */
		this.token = undefined;
		/** @type {Promise<unknown>} syncs and writes of the group map run one at a time */
		this.syncing = Promise.resolve();
		/** Whether the sessions stored as live before this worker started were checked. */
		this.recovered = false;
		this.writing = Promise.resolve();
	}

	/**
	 * Connects to new sessions, drops the ones that are gone and keeps the
	 * others; calling it again with the same discovery changes nothing.
	 * @param {Discovery} discovery
	 */
	sync(discovery) {
		const run = this.syncing.then(() => this.apply(discovery));
		this.syncing = run.catch(() => {});
		return run;
	}

	/** @param {Discovery} discovery */
	async apply({ token, sessions }) {
		const live = new Set(sessions.map((session) => session.id));
		if (!this.recovered) await this.recover(live);
		for (const session of [...this.sessions.values()]) {
			if (!live.has(session.id)) await this.end(session);
		}
		const enabled = await this.enabled();
		const tokenChanged = this.token !== undefined && this.token !== token;
		this.token = token;
		for (const info of sessions) {
			let session = this.sessions.get(info.id);
			if (!session) session = this.add(info);
			// The same Gentle Shell session now listens elsewhere: dial the new port.
			const moved = session.port !== info.port;
			session.port = info.port;
			if (!enabled) continue;
			if (!session.connection) {
				session.connection = this.deps.createConnection(session);
				session.connection.open({ port: session.port, token, sessionId: session.id });
			} else if (moved) {
				session.connection.close();
				session.connection.open({ port: session.port, token, sessionId: session.id });
			} else if (tokenChanged) session.connection.open({ port: session.port, token, sessionId: session.id });
			else session.connection.ensure();
		}
		await this.deps.storage.set({ [LIVE_KEY]: this.live().map(({ id, name, title }) => ({ id, name, groupTitle: title })) });
	}

	/**
	 * Once per worker, at the first discovery: sessions stored as live that are
	 * gone now ended while the worker was down. Their groups are ended as if
	 * they had disappeared during a sync.
	 * @param {Set<string>} live
	 */
	async recover(live) {
		this.recovered = true;
		const stored = (await this.deps.storage.get({ [LIVE_KEY]: [] }))[LIVE_KEY];
		if (!Array.isArray(stored)) return;
		for (const entry of stored) {
			const { id, groupTitle } = entry ?? {};
			if (typeof id !== "string" || typeof groupTitle !== "string" || live.has(id)) continue;
			const group = this.deps.createGroup({
				title: groupTitle,
				load: async () => (await this.groups())[id],
				save: (groupId) => this.writeGroup(id, groupId),
				adoptable: () => false,
			});
			await group.end().catch(() => {});
		}
	}

	/**
	 * A new session gets the first free title: "Gentle · <name>", then " · 2", " · 3"…
	 * @param {SessionInfo} info
	 * @returns {Session}
	 */
	add(info) {
		const taken = new Set([...this.sessions.values()].map((session) => session.title));
		let title = baseTitle(info.name);
		for (let n = 2; taken.has(title); n++) title = `${baseTitle(info.name)} · ${n}`;
		const id = info.id;
		const group = this.deps.createGroup({
			title,
			load: async () => (await this.groups())[id],
			save: (groupId) => this.writeGroup(id, groupId),
			// A same-titled group another session owns is not this one's.
			adoptable: async (groupId) => !Object.entries(await this.groups()).some(([owner, stored]) => owner !== id && stored === groupId),
		});
		/** @type {Session} */
		const session = { ...info, title, group, connection: undefined, running: 0 };
		this.sessions.set(id, session);
		return session;
	}

	/**
	 * The session is gone: close its connection and rename its group as ended.
	 * @param {Session} session
	 */
	async end(session) {
		// Closed first: whoever watches the connection still finds the session's tabs.
		session.connection?.close();
		this.sessions.delete(session.id);
		for (const [tabId, owner] of this.owners) if (owner === session) this.owners.delete(tabId);
		await session.group.end().catch(() => {});
	}

	/** @returns {Promise<Record<string, number>>} */
	async groups() {
		const stored = (await this.deps.storage.get({ [GROUPS_KEY]: {} }))[GROUPS_KEY];
		return stored && typeof stored === "object" ? stored : {};
	}

	/**
	 * @param {string} id
	 * @param {number | undefined} groupId
	 */
	writeGroup(id, groupId) {
		const write = this.writing.then(async () => {
			const groups = { ...(await this.groups()) };
			if (groupId === undefined) delete groups[id];
			else groups[id] = groupId;
			await this.deps.storage.set({ [GROUPS_KEY]: groups });
		});
		this.writing = write.catch(() => {});
		return write;
	}

	/** The popup's On/Off switch; on by default. */
	async enabled() {
		return (await this.deps.storage.get({ [ENABLED_KEY]: true }))[ENABLED_KEY] !== false;
	}

	/**
	 * Off closes every connection; on takes effect at the next sync.
	 * @param {boolean} on
	 */
	async setEnabled(on) {
		await this.deps.storage.set({ [ENABLED_KEY]: on });
		if (on) return;
		for (const session of this.sessions.values()) {
			session.connection?.close();
			session.connection = undefined;
		}
	}

	/** @param {string} id */
	get(id) {
		return this.sessions.get(id);
	}

	/** @returns {Session[]} */
	live() {
		return [...this.sessions.values()];
	}

	/** What the popup shows. */
	list() {
		return this.live().map(({ id, name, title, connection }) => ({ id, name, title, state: connection?.state ?? "off" }));
	}

	/**
	 * @param {number} tabId
	 * @param {Session} session
	 */
	own(tabId, session) {
		this.owners.set(tabId, session);
	}

	/** @param {number} tabId */
	ownerOf(tabId) {
		const owner = this.owners.get(tabId);
		return owner && this.sessions.get(owner.id) === owner ? owner : undefined;
	}

	/**
	 * Whether the tab is in any live session's group: the debugger may attach to it.
	 * @param {number} tabId
	 */
	async contains(tabId) {
		for (const session of this.live()) if (await session.group.contains(tabId)) return true;
		return false;
	}

	/**
	 * The group that decides tabs `opener` opens: the group of the session
	 * acting on it. An opener no session acted on is only checked against every
	 * live group, and its tabs are only ever taken out of them.
	 * @param {number} opener
	 * @returns {OpenedTabs}
	 */
	openedFor(opener) {
		const owner = this.ownerOf(opener);
		if (owner) return owner.group;
		const evict = async (/** @type {number} */ tabId) => {
			let evicted = false;
			for (const session of this.live()) evicted = (await session.group.evict(tabId).catch(() => false)) || evicted;
			return evicted;
		};
		return {
			contains: (tabId) => this.contains(tabId),
			evict,
			isHeld: () => false,
			hold: async (tabId) => void (await evict(tabId)),
			admit: async () => {
				throw new Error("No Gentle Shell session owns the tab that opened this one.");
			},
			discard: async (tabId) => void (await evict(tabId)),
		};
	}

	/**
	 * Asks the user in `session`'s terminal. Not connected, no answer or
	 * anything but an explicit approval means no. A decision to remember is
	 * passed on only when the request offered one.
	 * @param {Session} session
	 * @param {ApprovalRequest} request
	 * @returns {Promise<{approved: boolean, remember?: "allow" | "deny"}>}
	 */
	async approve(session, request) {
		try {
			const answer = await session.connection?.call("approve", request, { timeoutMs: APPROVAL_TIMEOUT_MS });
			return readAnswer(answer && typeof answer === "object" ? answer : false, request.remember !== undefined);
		} catch {
			return { approved: false };
		}
	}

	/**
	 * The navigation guard asks for a load or new tab in `tabId`: the session acting on it answers.
	 * @param {ApprovalRequest} request
	 * @param {number} tabId
	 */
	approveForTab(request, tabId) {
		const owner = this.ownerOf(tabId);
		return owner ? this.approve(owner, request) : Promise.resolve({ approved: false });
	}

	/**
	 * STOP on a page: halt the actions and abort the run of the session acting
	 * on that tab only. A tab no live session acted on stops every action.
	 * @param {number} tabId
	 */
	async stopFromPage(tabId) {
		const owner = this.ownerOf(tabId);
		await this.deps.stopActions?.(owner?.id);
		await owner?.connection?.call("stop", {}).catch(() => {});
	}

	/** STOP in the popup: halt input and abort every connected session's run. */
	async stopAll() {
		await this.deps.stopActions?.();
		await Promise.all(this.live().map((session) => session.connection?.state === "connected" ? session.connection.call("stop", {}).catch(() => {}) : undefined));
	}
}

/**
 * @typedef {{
 *   actions: {
 *     open: (url: string, createTab: () => Promise<{tabId: number, groupId: number}>, options: object) => Promise<unknown>,
 *     click: (params: any, scope: import("./actions.js").ActionScope) => Promise<unknown>,
 *     type: (params: any, scope: import("./actions.js").ActionScope) => Promise<unknown>,
 *     key: (params: any, scope: import("./actions.js").ActionScope) => Promise<unknown>,
 *     scroll: (params: any, scope: import("./actions.js").ActionScope) => Promise<unknown>,
 *     navigate: (params: any, scope: import("./actions.js").ActionScope) => Promise<unknown>,
 *   },
 *   cdp: {evaluate: (tabId: number, expression: string) => Promise<any>, send: (tabId: number, method: string, params?: object) => Promise<any>},
 *   settings: () => Promise<{level: string, riskyDomains: readonly string[], rules?: unknown}>,
 *   setLevel: (level: unknown) => Promise<unknown>,
 *   clearRules: (site?: string) => Promise<unknown>,
 *   reload: () => Promise<unknown>,
 *   version: string,
 *   tracked?: (session: Session, handler: (params: any) => Promise<any>) => (params: any) => Promise<any>,
 *   screenshotTimeoutMs?: number,
 * }} HandlerDeps
 */

/**
 * The methods `session` may call, every one bound to its own group.
 * @param {SessionManager} manager
 * @param {Session} session
 * @param {HandlerDeps} deps
 * @returns {Record<string, (params: any) => any>}
 */
export function sessionHandlers(manager, session, deps) {
	const { actions, cdp } = deps;
	const tracked = deps.tracked ?? ((_session, handler) => handler);
	/** @type {import("./actions.js").ActionScope} */
	const scope = {
		inGroup: (tabId) => session.group.contains(tabId),
		approve: (request) => manager.approve(session, request),
		owner: session.id,
	};

	/**
	 * Confinement boundary: resolves a tab only if it is in this session's group.
	 * Never activates it: the user may be working in another tab.
	 * @param {any} params
	 */
	async function groupTab(params) {
		const tab = await session.group.requireTab(params?.tabId);
		const tabId = /** @type {number} */ (tab.id);
		manager.own(tabId, session);
		return tabId;
	}

	/** @param {"click" | "type" | "key" | "scroll" | "navigate"} method */
	const act = (method) => tracked(session, async (/** @type {any} */ params) => actions[method]({ ...params, tabId: await groupTab(params) }, scope));

	return {
		info: async () => ({ version: deps.version }),
		tabs: () => session.group.tabs(),
		/** @param {any} params */
		open: tracked(session, async (params) => {
			const url = httpUrl(params?.url);
			// Approval comes first; the tab opens empty so its load goes through the navigation guard.
			const createTab = async () => {
				const opened = await session.group.openTab("about:blank");
				manager.own(opened.tabId, session);
				return opened;
			};
			return actions.open(url, createTab, { risky: params?.risky, ...scope });
		}),
		/** @param {any} params */
		snapshot: async (params) => {
			const tabId = await groupTab(params);
			const snapshot = await cdp.evaluate(tabId, snapshotExpression());
			// Content that cannot be read counts as risky.
			const signals = await cdp.evaluate(tabId, pageRiskExpression()).catch(() => null);
			const { riskyDomains } = await deps.settings();
			return { ...snapshot, risk: isRiskyPage(String(snapshot?.url ?? ""), riskyDomains, signals) };
		},
		/** @param {any} params */
		screenshot: async (params) => {
			const tabId = await groupTab(params);
			// Chrome does not paint background tabs, so a capture there can hang.
			const capture = cdp.send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Tab ${tabId} is in the background, where Chrome does not paint it, so no screenshot could be taken. Use browser_snapshot instead, or ask the user to switch to that tab.`)),
					deps.screenshotTimeoutMs ?? SCREENSHOT_TIMEOUT_MS,
				);
			});
			try {
				const { data } = await Promise.race([capture, timeout]);
				return { data, mimeType: "image/jpeg" };
			} finally {
				clearTimeout(timer);
			}
		},
		click: act("click"),
		type: act("type"),
		key: act("key"),
		scroll: act("scroll"),
		navigate: act("navigate"),
		// For the user's /browser level and /browser rules commands only; no Gentle Shell tool calls these.
		getLevel: async () => ({ level: (await deps.settings()).level }),
		/** @param {any} params */
		setLevel: (params) => deps.setLevel(params?.level),
		getRules: async () => ({ rules: (await deps.settings()).rules ?? {} }),
		/** @param {any} params */
		clearRules: (params) => deps.clearRules(typeof params?.site === "string" ? params.site : undefined),
		reload: () => deps.reload(),
	};
}
