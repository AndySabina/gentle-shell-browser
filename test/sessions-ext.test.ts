import assert from "node:assert/strict";
import { test } from "node:test";
import { TabGroup } from "../extension/lib/group.js";
import { snapshotExpression } from "../extension/lib/page.js";
import { INVALID_REPLY, parseDiscovery, SessionManager, sessionHandlers } from "../extension/lib/sessions.js";

const TOKEN = "T".repeat(43);
const A = { id: "session-aaaaaaaaaa", name: "alpha", port: 48733 };
const B = { id: "session-bbbbbbbbbb", name: "beta", port: 48734 };

interface FakeTab {
	id: number;
	windowId: number;
	groupId: number;
	title: string;
	url: string;
	active: boolean;
}

/** The parts of `chrome` TabGroup and the session manager use, in memory. */
function fakeChrome(initial: Record<string, unknown> = {}) {
	const tabs: FakeTab[] = [];
	const groups: { id: number; windowId: number; title: string; color: string }[] = [];
	const storage: Record<string, unknown> = { ...initial };
	let nextTab = 100;
	let nextGroup = 10;
	const local = {
		async get(keys: Record<string, unknown>) {
			const out: Record<string, unknown> = {};
			for (const [key, fallback] of Object.entries(keys)) out[key] = key in storage ? structuredClone(storage[key]) : fallback;
			return out;
		},
		async set(items: Record<string, unknown>) {
			Object.assign(storage, structuredClone(items));
		},
	};
	const api = {
		tabs: {
			async create(props: { url: string; windowId?: number }) {
				const tab = { id: nextTab++, windowId: props.windowId ?? 1, groupId: -1, title: "", url: props.url, active: false };
				tabs.push(tab);
				return { ...tab };
			},
			async get(id: number) {
				const tab = tabs.find((t) => t.id === id);
				if (!tab) throw new Error(`No tab with id: ${id}.`);
				return { ...tab };
			},
			async query(query: { groupId?: number }) {
				return tabs.filter((t) => query.groupId === undefined || t.groupId === query.groupId).map((t) => ({ ...t }));
			},
			async group(options: { tabIds: number; groupId?: number; createProperties?: { windowId?: number } }) {
				let groupId = options.groupId;
				if (groupId === undefined) {
					groupId = nextGroup++;
					groups.push({ id: groupId, windowId: options.createProperties?.windowId ?? 1, title: "", color: "grey" });
				}
				const tab = tabs.find((t) => t.id === options.tabIds);
				if (tab) tab.groupId = groupId;
				return groupId;
			},
			async ungroup(id: number) {
				const tab = tabs.find((t) => t.id === id);
				if (tab) tab.groupId = -1;
			},
			async remove(id: number) {
				tabs.splice(tabs.findIndex((t) => t.id === id), 1);
			},
		},
		tabGroups: {
			async get(id: number) {
				const group = groups.find((g) => g.id === id);
				if (!group) throw new Error(`No group with id: ${id}.`);
				return { ...group };
			},
			async query(query: { title?: string }) {
				return groups.filter((g) => query.title === undefined || g.title === query.title).map((g) => ({ ...g }));
			},
			async update(id: number, props: { title?: string; color?: string }) {
				const group = groups.find((g) => g.id === id);
				if (!group) throw new Error(`No group with id: ${id}.`);
				Object.assign(group, props);
				return { ...group };
			},
		},
		windows: {
			async getLastFocused() {
				return { id: 1 };
			},
		},
		storage: { local },
	};
	return { api, tabs, groups, storage };
}

/** A Connection stand-in that records what the manager and the handlers do with it. */
class FakeConnection {
	state = "off";
	opened: unknown[] = [];
	closed = 0;
	calls: { method: string; params: unknown }[] = [];
	handlers: Record<string, (params: any) => any>;
	/** What Gentle Shell answers to "approve"; a function may throw. */
	answer: unknown = { approved: true };
	constructor(handlers: Record<string, (params: any) => any>) {
		this.handlers = handlers;
	}
	open(pairing: unknown) {
		this.opened.push(pairing);
		this.state = "connected";
	}
	close() {
		this.closed++;
		this.state = "off";
	}
	ensure() {}
	async call(method: string, params: unknown) {
		this.calls.push({ method, params });
		if (method !== "approve") return { stopped: true };
		return typeof this.answer === "function" ? this.answer() : this.answer;
	}
}

/** Records every action call and the scope it ran with; `click` asks for approval like a risky click would. */
function fakeActions() {
	const calls: { method: string; params: any; scope: any }[] = [];
	const record = (method: string) => async (params: any, scope: any) => {
		calls.push({ method, params, scope });
		if (method === "click") return scope.approve({ kind: "action", title: "click", detail: "", url: "", reason: "test" });
		return {};
	};
	const open = async (url: string, createTab: () => Promise<unknown>, options: any) => {
		calls.push({ method: "open", params: url, scope: { ...options, createTab } });
		return {};
	};
	return { calls, click: record("click"), type: record("type"), key: record("key"), scroll: record("scroll"), navigate: record("navigate"), open };
}

function setup(initial: Record<string, unknown> = {}, policy: { level?: string; rules?: Record<string, Record<string, string>> } = {}) {
	const chrome = fakeChrome(initial);
	const cleared: (string | undefined)[] = [];
	const actions = fakeActions();
	const connections = new Map<string, FakeConnection>();
	const sent: string[] = [];
	const expressions: string[] = [];
	const stops: (string | undefined)[] = [];
	const manager: SessionManager = new SessionManager({
		storage: chrome.api.storage.local,
		createGroup: (options) => new TabGroup(chrome.api, options),
		createConnection: (session) => {
			const connection = new FakeConnection(
				sessionHandlers(manager, session, {
					actions,
					cdp: {
						async evaluate(_tabId: number, expression: string) {
							sent.push("evaluate");
							expressions.push(expression);
						},
						async send(_tabId: number, method: string) {
							sent.push(method);
						},
					},
					settings: async () => ({ level: policy.level ?? "always", riskyDomains: [], rules: policy.rules ?? {} }),
					setLevel: async (level: unknown) => ({ level }),
					clearRules: async (site?: string) => {
						cleared.push(site);
						return { rules: {} };
					},
					reload: async () => ({ reloading: true }),
					version: "0.1.0",
				}),
			);
			connections.set(session.id, connection);
			return connection;
		},
		stopActions: async (owner?: string) => {
			stops.push(owner);
		},
	});
	return { chrome, actions, connections, manager, sent, expressions, stops, cleared };
}

test("parseDiscovery accepts a valid reply and keeps only the known fields", () => {
	const reply = { token: TOKEN, sessions: [{ ...A, pid: 7 }, B], extra: true };
	assert.deepEqual(parseDiscovery(reply), { token: TOKEN, sessions: [A, B] });
	assert.deepEqual(parseDiscovery({ token: TOKEN, sessions: [] }), { token: TOKEN, sessions: [] });
	assert.deepEqual(parseDiscovery({ token: TOKEN, sessions: [{ ...A, name: "x".repeat(60), port: 48832 }] }).sessions[0].port, 48832);
});

test("parseDiscovery rejects a malformed reply with the exact message", () => {
	const bad: unknown[] = [
		undefined,
		null,
		"text",
		{ error: "no config" },
		{ token: "short", sessions: [] },
		{ token: `${"T".repeat(42)}!`, sessions: [] },
		{ token: 42, sessions: [] },
		{ token: TOKEN },
		{ token: TOKEN, sessions: {} },
		{ token: TOKEN, sessions: Array.from({ length: 101 }, (_, i) => ({ ...A, id: `session-${String(i).padStart(10, "0")}` })) },
	];
	for (const reply of bad) assert.throws(() => parseDiscovery(reply), { message: INVALID_REPLY }, JSON.stringify(reply));
	assert.equal(INVALID_REPLY, "Gentle Shell helper sent an invalid reply");
});

test("parseDiscovery skips each invalid session entry and keeps the valid ones", () => {
	const entries: unknown[] = [
		null,
		"text",
		{ ...B, id: "short" },
		{ ...B, id: "x".repeat(65) },
		{ ...B, id: "bad id with spaces" },
		{ ...B, id: 5 },
		{ ...B, name: "" },
		{ ...B, name: "x".repeat(61) },
		{ ...B, name: 7 },
		{ ...B, port: 48732 },
		{ ...B, port: 48833 },
		{ ...B, port: 48733.5 },
		{ ...B, port: "48733" },
	];
	for (const entry of entries) {
		assert.deepEqual(parseDiscovery({ token: TOKEN, sessions: [A, entry] }), { token: TOKEN, sessions: [A] }, JSON.stringify(entry));
		assert.deepEqual(parseDiscovery({ token: TOKEN, sessions: [entry, A] }), { token: TOKEN, sessions: [A] }, JSON.stringify(entry));
	}
	// A repeated id keeps the first entry only.
	assert.deepEqual(parseDiscovery({ token: TOKEN, sessions: [A, { ...B, id: A.id }, B] }), { token: TOKEN, sessions: [A, B] });
});

test("sync opens one connection per session with its port, the token and its id, and is idempotent", async () => {
	const { connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	assert.deepEqual([...connections.keys()], [A.id, B.id]);
	assert.deepEqual(connections.get(A.id)!.opened, [{ port: A.port, token: TOKEN, sessionId: A.id }]);
	assert.deepEqual(connections.get(B.id)!.opened, [{ port: B.port, token: TOKEN, sessionId: B.id }]);
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	assert.equal(connections.size, 2);
	assert.equal(connections.get(A.id)!.opened.length, 1);
	assert.equal(connections.get(B.id)!.opened.length, 1);
	assert.deepEqual(manager.list(), [
		{ id: A.id, name: "alpha", title: "Gentle · alpha", state: "connected" },
		{ id: B.id, name: "beta", title: "Gentle · beta", state: "connected" },
	]);
});

test("a session that disappears is closed and its group renamed as ended, never reused", async () => {
	const { chrome, connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	const { groupId } = await manager.get(B.id)!.group.openTab("https://example.com/");
	assert.equal(chrome.groups.find((g) => g.id === groupId)!.title, "Gentle · beta");
	assert.deepEqual(chrome.storage.groups, { [B.id]: groupId });
	await manager.sync({ token: TOKEN, sessions: [A] });
	assert.equal(connections.get(B.id)!.closed, 1);
	assert.equal(connections.get(A.id)!.closed, 0);
	assert.equal(chrome.groups.find((g) => g.id === groupId)!.title, "Gentle · beta (ended)");
	assert.deepEqual(chrome.storage.groups, {});
	assert.equal(manager.get(B.id), undefined);
	// A new session with the same name gets a new group, not the ended one.
	const again = { id: "session-cccccccccc", name: "beta", port: 48735 };
	await manager.sync({ token: TOKEN, sessions: [A, again] });
	const opened = await manager.get(again.id)!.group.openTab("https://example.org/");
	assert.notEqual(opened.groupId, groupId);
	assert.equal(chrome.groups.find((g) => g.id === opened.groupId)!.title, "Gentle · beta");
});

test("live sessions that share a name are numbered by discovery order", async () => {
	const { chrome, manager } = setup();
	const twin = { id: "session-dddddddddd", name: "alpha", port: 48736 };
	const third = { id: "session-eeeeeeeeee", name: "alpha", port: 48737 };
	await manager.sync({ token: TOKEN, sessions: [A, B, twin, third] });
	assert.deepEqual(manager.list().map((s) => s.title), ["Gentle · alpha", "Gentle · beta", "Gentle · alpha · 2", "Gentle · alpha · 3"]);
	await manager.get(twin.id)!.group.openTab("https://example.com/");
	assert.equal(chrome.groups[0].title, "Gentle · alpha · 2");
});

test("with the enabled flag off nothing connects; turning it on connects", async () => {
	const { connections, manager } = setup({ enabled: false });
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	assert.equal(connections.size, 0);
	assert.deepEqual(manager.list().map((s) => s.state), ["off", "off"]);
	await manager.setEnabled(true);
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	assert.equal(connections.size, 2);
	await manager.setEnabled(false);
	assert.deepEqual([...connections.values()].map((c) => c.closed), [1, 1]);
	assert.deepEqual(manager.list().map((s) => s.state), ["off", "off"]);
});

test("session A acting on session B's tab gets the exact error and no input is dispatched", async () => {
	const { actions, connections, manager, sent } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	await manager.get(A.id)!.group.openTab("https://a.test/");
	const { tabId } = await manager.get(B.id)!.group.openTab("https://b.test/");
	const handlers = connections.get(A.id)!.handlers;
	for (const method of ["click", "type", "key", "scroll", "navigate", "snapshot", "screenshot"]) {
		await assert.rejects(handlers[method]({ tabId, x: 1, y: 2, text: "x", key: "Enter", deltaY: 10, url: "https://x.test/" }), {
			message: `Tab ${tabId} is not in the Gentle Shell group. Ask the user to drag it into the group.`,
		}, method);
	}
	assert.deepEqual(actions.calls, []);
	assert.deepEqual(sent, []);
	assert.deepEqual((await handlers.tabs({})).map((tab: { url: string }) => tab.url), ["https://a.test/"]);
	assert.equal(await manager.contains(tabId), true);
});

test("approval for an action session A started is asked on A's connection only", async () => {
	const { actions, connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	const { tabId } = await manager.get(A.id)!.group.openTab("https://a.test/");
	const other = await manager.get(B.id)!.group.openTab("https://b.test/");
	assert.deepEqual(await connections.get(A.id)!.handlers.click({ tabId, x: 1, y: 2 }), { approved: true });
	assert.deepEqual(connections.get(A.id)!.calls.map((c) => c.method), ["approve"]);
	assert.deepEqual(connections.get(B.id)!.calls, []);
	// The action runs with A's group: B's tab is not a member for it.
	const { scope } = actions.calls[0];
	assert.equal(await scope.inGroup(tabId), true);
	assert.equal(await scope.inGroup(other.tabId), false);
	// A load the guard pauses in that tab later is asked on A's connection too.
	assert.deepEqual(await manager.approveForTab({ kind: "navigate", title: "load", detail: "", url: "", reason: "" }, tabId), { approved: true });
	assert.deepEqual(connections.get(A.id)!.calls.map((c) => c.method), ["approve", "approve"]);
	assert.deepEqual(connections.get(B.id)!.calls, []);
	// A tab no session acted on is never approved.
	assert.deepEqual(await manager.approveForTab({ kind: "navigate", title: "load", detail: "", url: "", reason: "" }, 999), { approved: false });
});

test("open creates the tab in the calling session's group", async () => {
	const { chrome, actions, connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	await connections.get(B.id)!.handlers.open({ url: "https://b.test/" });
	const [{ params: url, scope }] = actions.calls;
	assert.equal(url, "https://b.test/");
	const opened = await (scope as { createTab: () => Promise<{ tabId: number; groupId: number }> }).createTab();
	assert.equal(chrome.groups.find((g) => g.id === opened.groupId)!.title, "Gentle · beta");
	assert.equal(manager.ownerOf(opened.tabId)?.id, B.id);
});

test("STOP on a page notifies only the session that owns the tab; popup STOP notifies every connected session", async () => {
	const { connections, manager, stops } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	const { tabId } = await manager.get(A.id)!.group.openTab("https://a.test/");
	await connections.get(A.id)!.handlers.click({ tabId, x: 1, y: 2 });
	connections.get(A.id)!.calls.length = 0;
	await manager.stopFromPage(tabId);
	assert.deepEqual(stops, [A.id]);
	assert.deepEqual(connections.get(A.id)!.calls.map((c) => c.method), ["stop"]);
	assert.deepEqual(connections.get(B.id)!.calls, []);
	connections.get(A.id)!.calls.length = 0;
	await manager.stopAll();
	assert.deepEqual(stops, [A.id, undefined]);
	assert.deepEqual(connections.get(A.id)!.calls.map((c) => c.method), ["stop"]);
	assert.deepEqual(connections.get(B.id)!.calls.map((c) => c.method), ["stop"]);
});

test("new tabs an action opens are decided by the opener's session group", async () => {
	const { manager, connections } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	const { tabId } = await manager.get(B.id)!.group.openTab("https://b.test/");
	await connections.get(B.id)!.handlers.click({ tabId, x: 1, y: 2 });
	assert.equal(manager.openedFor(tabId), manager.get(B.id)!.group);
	// An opener no session acted on: only membership in some live group counts.
	const any = manager.openedFor(4242);
	assert.equal(await any.contains(tabId), true);
	assert.equal(await any.contains(4242), false);
});

test("STOP on a tab no live session acted on stops every action and notifies nobody", async () => {
	const { connections, manager, stops } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	await manager.stopFromPage(4242);
	assert.deepEqual(stops, [undefined]);
	assert.deepEqual(connections.get(A.id)!.calls, []);
	assert.deepEqual(connections.get(B.id)!.calls, []);
});

test("a session named like an ended group gets another title and sees none of the ended group's tabs", async () => {
	const { chrome, manager, connections } = setup();
	await manager.sync({ token: TOKEN, sessions: [A] });
	const { groupId } = await manager.get(A.id)!.group.openTab("https://a.test/");
	await manager.sync({ token: TOKEN, sessions: [] });
	assert.equal(chrome.groups.find((g) => g.id === groupId)!.title, "Gentle · alpha (ended)");
	const impostor = { id: "session-ffffffffff", name: "alpha (ended)", port: 48738 };
	await manager.sync({ token: TOKEN, sessions: [impostor] });
	assert.equal(manager.get(impostor.id)!.title, "Gentle · alpha (ended session)");
	assert.deepEqual(await connections.get(impostor.id)!.handlers.tabs({}), []);
	assert.deepEqual(chrome.storage.groups, {});
	assert.equal(chrome.groups.find((g) => g.id === groupId)!.title, "Gentle · alpha (ended)");
});

test("a known session that comes back on another port is redialed there", async () => {
	const { connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	await manager.sync({ token: TOKEN, sessions: [{ ...A, port: 48740 }, B] });
	const connection = connections.get(A.id)!;
	assert.equal(connection.closed, 1);
	assert.deepEqual(connection.opened, [
		{ port: A.port, token: TOKEN, sessionId: A.id },
		{ port: 48740, token: TOKEN, sessionId: A.id },
	]);
	assert.equal(manager.get(A.id)!.port, 48740);
	assert.equal(connections.get(B.id)!.opened.length, 1);
	assert.equal(connections.get(B.id)!.closed, 0);
});

test("the live sessions are stored, and ones that ended while the worker was down get their groups ended after the first discovery", async () => {
	const before = [
		{ id: A.id, name: "alpha", groupTitle: "Gentle · alpha" },
		{ id: B.id, name: "beta", groupTitle: "Gentle · beta" },
	];
	const { chrome, manager } = setup({ liveSessions: before, groups: { [A.id]: 10, [B.id]: 11 } });
	chrome.groups.push({ id: 10, windowId: 1, title: "Gentle · alpha", color: "pink" }, { id: 11, windowId: 1, title: "Gentle · beta", color: "pink" });
	await manager.sync({ token: TOKEN, sessions: [A] });
	assert.deepEqual(chrome.groups.map((g) => g.title), ["Gentle · alpha", "Gentle · beta (ended)"]);
	assert.deepEqual(chrome.storage.groups, { [A.id]: 10 });
	assert.deepEqual(chrome.storage.liveSessions, [{ id: A.id, name: "alpha", groupTitle: "Gentle · alpha" }]);
	// Only once: a group titled like the ended one later is left alone.
	chrome.groups[1].title = "Gentle · beta";
	await manager.sync({ token: TOKEN, sessions: [A] });
	assert.equal(chrome.groups[1].title, "Gentle · beta");
	await manager.sync({ token: TOKEN, sessions: [] });
	assert.deepEqual(chrome.storage.liveSessions, []);
	assert.equal(chrome.groups[0].title, "Gentle · alpha (ended)");
});

test("every action a session runs carries that session's id as its owner", async () => {
	const { actions, connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	const { tabId } = await manager.get(B.id)!.group.openTab("https://b.test/");
	await connections.get(B.id)!.handlers.scroll({ tabId, deltaY: 10 });
	await connections.get(A.id)!.handlers.open({ url: "https://a.test/" });
	assert.deepEqual(actions.calls.map((call) => call.scope.owner), [B.id, A.id]);
});

// S14: permission modes and saved decisions.

const LOAD = { kind: "navigate", title: "load", detail: "", url: "https://a.test/", reason: "" };

test("a saved decision in the answer is passed on only when the request offered one; anything malformed is a denial", async () => {
	const { connections, manager } = setup();
	await manager.sync({ token: TOKEN, sessions: [A] });
	const session = manager.get(A.id)!;
	const connection = connections.get(A.id)!;
	const offered = { ...LOAD, remember: { site: "a.test", category: "navigate" } };
	connection.answer = { approved: true, remember: "allow" };
	assert.deepEqual(await manager.approve(session, offered as any), { approved: true, remember: "allow" });
	assert.deepEqual(await manager.approve(session, LOAD as any), { approved: true });
	connection.answer = { approved: false, remember: "deny" };
	assert.deepEqual(await manager.approve(session, offered as any), { approved: false, remember: "deny" });
	connection.answer = { approved: false, remember: "allow" };
	assert.deepEqual(await manager.approve(session, offered as any), { approved: false });
	for (const bad of [undefined, null, true, "yes", { approved: "true" }]) {
		connection.answer = bad;
		assert.deepEqual(await manager.approve(session, offered as any), { approved: false }, JSON.stringify(bad));
	}
	connection.answer = () => {
		throw new Error("Timed out waiting for approve");
	};
	assert.deepEqual(await manager.approve(session, offered as any), { approved: false });
});

test("getLevel, getRules and clearRules answer the user's commands with the normalized mode and rules", async () => {
	const rules = { "example.com": { click: "allow" } };
	const { connections, manager, cleared } = setup({}, { level: "never", rules });
	await manager.sync({ token: TOKEN, sessions: [A] });
	const handlers = connections.get(A.id)!.handlers;
	assert.deepEqual(await handlers.getLevel({}), { level: "never" });
	assert.deepEqual(await handlers.getRules({}), { rules });
	assert.deepEqual(await handlers.clearRules({ site: "example.com" }), { rules: {} });
	assert.deepEqual(await handlers.clearRules({}), { rules: {} });
	assert.deepEqual(cleared, ["example.com", undefined]);
});

test("never mode still confines each session to its own group, with the exact error", async () => {
	const { actions, connections, manager, sent } = setup({}, { level: "never" });
	await manager.sync({ token: TOKEN, sessions: [A, B] });
	await manager.get(A.id)!.group.openTab("https://a.test/");
	const { tabId } = await manager.get(B.id)!.group.openTab("https://b.test/");
	const handlers = connections.get(A.id)!.handlers;
	for (const method of ["click", "type", "key", "scroll", "navigate", "snapshot", "screenshot"]) {
		await assert.rejects(handlers[method]({ tabId, x: 1, y: 2, text: "x", key: "Enter", deltaY: 10, url: "https://x.test/" }), {
			message: `Tab ${tabId} is not in the Gentle Shell group. Ask the user to drag it into the group.`,
		}, method);
	}
	assert.deepEqual(actions.calls, []);
	assert.deepEqual(sent, []);
});

test("snapshot reads the viewport by default and the whole page only with full: true", async () => {
	const { connections, manager, expressions } = setup();
	await manager.sync({ token: TOKEN, sessions: [A] });
	const { tabId } = await manager.get(A.id)!.group.openTab("https://a.test/");
	const handlers = connections.get(A.id)!.handlers;
	for (const params of [{ tabId }, { tabId, full: false }, { tabId, full: "yes" }, { tabId, full: true }]) await handlers.snapshot(params);
	const snapshots = expressions.filter((expression) => expression.includes("__gentleRefs"));
	assert.deepEqual(snapshots, [
		snapshotExpression({ full: false }),
		snapshotExpression({ full: false }),
		snapshotExpression({ full: false }),
		snapshotExpression({ full: true }),
	]);
	assert.notEqual(snapshotExpression({ full: true }), snapshotExpression({ full: false }));
});
