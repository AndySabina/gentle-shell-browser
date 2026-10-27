// Service worker: finds the live Gentle Shell sessions through the native
// messaging host, keeps one connection and one tab group per session, and
// answers the popup.

import { Actions } from "./lib/actions.js";
import { Debugger } from "./lib/cdp.js";
import { Connection } from "./lib/connection.js";
import { TabGroup } from "./lib/group.js";
import { NavGuard } from "./lib/navguard.js";
import { Overlay, STOP_BINDING } from "./lib/overlay.js";
import { MODES, normalizeSettings, WAITING_LABEL, withoutRule, withoutSite, withRule } from "./lib/policy.js";
import { HELPER, HELPER_MISSING, parseDiscovery, SessionManager, sessionHandlers } from "./lib/sessions.js";

const VERSION = chrome.runtime.getManifest().version;
/** Time for the reload reply to reach Gentle Shell before the worker goes away. */
const RELOAD_DELAY_MS = 200;

/** The build id install-extension wrote in build.json; "unknown" for a copy made by hand. */
async function readBuild() {
	try {
		const response = await fetch(chrome.runtime.getURL("build.json"));
		const { build } = await response.json();
		return typeof build === "string" && build ? build : "unknown";
	} catch {
		return "unknown";
	}
}
const BUILD = readBuild();

/**
 * The permission mode (stored as `level`) and saved decisions. Risky pages
 * come from the built-in list and page content only; a list stored by older
 * versions (`riskyDomains`) is ignored.
 * Only the user changes them: the popup, /browser level and /browser rules,
 * or "Always allow"/"Always deny" in an approval prompt.
 */
async function policySettings() {
	return normalizeSettings(await chrome.storage.local.get({ level: null, rules: null }));
}

/** @param {unknown} level */
async function setLevel(level) {
	if (typeof level !== "string" || !MODES.includes(level)) throw new Error(`Unknown mode: ${level}. Use always, remember or never.`);
	await chrome.storage.local.set({ level });
	return { level };
}

/** @type {Promise<unknown>} rule changes run one at a time, so none is lost */
let rulesWriting = Promise.resolve();

/**
 * @param {(rules: import("./lib/policy.js").Rules) => import("./lib/policy.js").Rules} change
 * @returns {Promise<{rules: import("./lib/policy.js").Rules}>}
 */
function updateRules(change) {
	const write = rulesWriting.then(async () => {
		const rules = change((await policySettings()).rules);
		await chrome.storage.local.set({ rules });
		return { rules };
	});
	rulesWriting = write.catch(() => {});
	return write;
}

/**
 * The user chose "Always allow" or "Always deny" in a prompt.
 * @type {import("./lib/navguard.js").SaveRule}
 */
const saveRule = (site, category, decision) => updateRules((rules) => withRule(rules, site, category, decision));

/** @param {string} [site] one site, or every saved decision when missing */
const clearRules = (site) => updateRules((rules) => (site === undefined ? {} : withoutSite(rules, site)));

/** @type {{state: "unknown" | "ok" | "helper-missing" | "invalid", error?: string}} */
let helper = { state: "unknown" };

/** @type {SessionManager} */
const sessions = new SessionManager({
	storage: chrome.storage.local,
	createGroup: (options) => new TabGroup(chrome, options),
	createConnection: (session) => connectionFor(session),
	// Without an owner (popup STOP): every session's actions.
	stopActions: (owner) => actions.stop(owner),
});

// The debugger never attaches, or attaches again, to a tab outside every session's group.
const cdp = new Debugger(chrome, { canAttach: (tabId) => sessions.contains(tabId) });
cdp.bind(STOP_BINDING);
const overlay = new Overlay(cdp);
const guard = new NavGuard({
	cdp,
	settings: policySettings,
	// A load or new tab the guard paused is asked of the session acting on that tab.
	approve: (request, tabId) => sessions.approveForTab(request, tabId),
	saveRule,
	waiting: (tabId) => overlay.move(tabId, null, null, WAITING_LABEL).catch(() => {}),
	// New tabs are held, admitted or evicted by the opener's session group.
	opened: (opener) => sessions.openedFor(opener),
});
// One action at a time across all sessions. Each call brings its session's
// group check and approval route; without one, nothing is a member and nothing is approved.
const actions = new Actions({
	cdp,
	overlay,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	settings: policySettings,
	approve: async () => false,
	guard,
	inGroup: async () => false,
	saveRule,
});

let running = 0;
let reloading = false;

/**
 * Counts the action while it runs, so a reload never cuts one short and a
 * session that disconnects stops its own action.
 * @param {import("./lib/sessions.js").Session} session
 * @param {(params: any) => Promise<any>} handler
 */
function tracked(session, handler) {
	/** @param {any} params */
	return async (params) => {
		if (reloading) throw new Error("The extension is reloading to update itself; try again in a moment.");
		running++;
		session.running++;
		try {
			return await handler(params);
		} finally {
			running--;
			session.running--;
		}
	};
}

/** Gentle Shell copied a new build into this folder: reload into it when no action runs. */
async function reload() {
	if (running > 0 || reloading) throw new Error("Busy: an action is running");
	reloading = true;
	// Clears the cursor, fails paused loads and detaches the debugger before the worker goes away.
	await actions.stop().catch(() => {});
	setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS);
	return { reloading: true };
}

/**
 * One connection per session; every method it serves is bound to that session.
 * @param {import("./lib/sessions.js").Session} session
 */
function connectionFor(session) {
	let previous = "off";
	return new Connection({
		createSocket: (url) => new WebSocket(url),
		version: VERSION,
		build: () => BUILD,
		handlers: sessionHandlers(sessions, session, { actions, cdp, settings: policySettings, setLevel, clearRules, reload, version: VERSION, tracked }),
		onState: (state) => {
			// Without its Gentle Shell nobody controls this session's tabs: stop its
			// actions (other sessions' go on), or just remove the cursor and the debugger from them.
			if (previous === "connected" && state !== "connected") {
				if (session.running > 0) void actions.stop(session.id);
				else for (const tabId of cdp.tabs()) if (sessions.ownerOf(tabId) === session) void overlay.clear(tabId).finally(() => cdp.detach(tabId));
			}
			previous = state;
			showState();
		},
	});
}

let shown = "";

/** Toolbar badge and open popups follow the connections; only a change is announced. */
function showState() {
	const list = sessions.list();
	const now = JSON.stringify([helper.state, list.map((session) => [session.id, session.state])]);
	if (now === shown) return;
	shown = now;
	const connected = list.filter((session) => session.state === "connected").length;
	void chrome.action.setBadgeText({ text: connected === 0 ? "" : connected === 1 ? "ON" : String(connected) });
	void chrome.action.setBadgeBackgroundColor({ color: "#ff76c3" });
	void chrome.runtime.sendMessage({ type: "state-changed" }).catch(() => {});
}

cdp.on("Runtime.bindingCalled", (tabId, params) => {
	// STOP on a page: only the session acting on that tab is aborted.
	if (params?.name === STOP_BINDING) void sessions.stopFromPage(tabId);
});

// A tab an agent action opened stays out of the group until the policy admits it;
// one a group tab opens later is taken out of the group.
chrome.tabs.onCreated.addListener((tab) => void guard.created(tab));

// A tab dragged out of every session group loses access at once: drop our overlay and debugger session.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
	guard.tabUpdated(tabId, change);
	if (change.groupId === undefined || !cdp.isAttached(tabId)) return;
	if (await sessions.contains(tabId)) return;
	await overlay.clear(tabId);
	await cdp.detach(tabId);
});

/** Asks the native messaging host for the token and the live sessions, then connects to them. */
async function discover() {
	let reply;
	try {
		reply = await chrome.runtime.sendNativeMessage(HELPER, { type: "discover" });
	} catch {
		reply = undefined;
	}
	if (!reply || typeof reply !== "object" || "error" in reply) {
		helper = { state: "helper-missing", error: HELPER_MISSING };
		showState();
		return;
	}
	try {
		await sessions.sync(parseDiscovery(reply));
		helper = { state: "ok" };
	} catch (error) {
		helper = { state: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
	showState();
}

chrome.runtime.onStartup.addListener(() => void discover());
// After a reload (an update) the worker starts fresh and finds the sessions again.
chrome.runtime.onInstalled.addListener(() => void discover());
chrome.alarms.create("gentle-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "gentle-reconnect") void discover();
});
void discover();

/** Popup requests. */
const popup = {
	async state() {
		await discover();
		return { helper, enabled: await sessions.enabled(), sessions: sessions.list() };
	},
	/** @param {{enabled: unknown}} message */
	async setEnabled(message) {
		await sessions.setEnabled(message.enabled === true);
		return popup.state();
	},
	async stop() {
		await sessions.stopAll();
		return popup.state();
	},
	async settings() {
		return policySettings();
	},
	/** @param {{level: unknown}} message */
	async setLevel(message) {
		await setLevel(message.level);
		return popup.settings();
	},
	/** @param {{site: unknown, category: unknown}} message */
	async removeRule(message) {
		await updateRules((rules) => withoutRule(rules, String(message.site), String(message.category)));
		return popup.settings();
	},
	async clearRules() {
		await clearRules();
		return popup.settings();
	},
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
	const action = popup[message.type];
	if (!action) return false;
	Promise.resolve(action(message)).then(
		(result) => reply({ ok: true, result }),
		(error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
	return true;
});
