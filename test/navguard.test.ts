import assert from "node:assert/strict";
import { test } from "node:test";
import { TabGroup } from "../extension/lib/group.js";
import { NavGuard } from "../extension/lib/navguard.js";
import { DEFAULT_RISKY_DOMAINS, WAITING_LABEL } from "../extension/lib/policy.js";

const TAB = 5;
const NOT_APPROVED = { message: /^The user did not approve: / };

type Listener = (tabId: number, params: any) => unknown;

/** Fake debugger that records commands and lets a test fire CDP events. */
function setup(
	options: { level?: string; rules?: Record<string, Record<string, string>>; approve?: (request: any) => Promise<unknown> | unknown; opened?: any; newTabWaitMs?: number; lateGroupMs?: number } = {},
) {
	const sent: { tabId: number; method: string; params: any }[] = [];
	const rules = options.rules ?? {};
	const saved: string[][] = [];
	const listeners = new Map<string, Set<Listener>>();
	const asked: any[] = [];
	const waiting: number[] = [];
	let attached = true;
	const failing = new Set<string>();
	const cdp = {
		async send(tabId: number, method: string, params: any = {}) {
			sent.push({ tabId, method, params });
			if (failing.delete(method)) throw new Error(`${method} failed`);
			if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN", url: "https://example.com/" } } };
			return {};
		},
		on(method: string, listener: Listener) {
			let set = listeners.get(method);
			if (!set) listeners.set(method, (set = new Set()));
			set.add(listener);
			return () => set.delete(listener);
		},
		waitForEvent: async () => ({ method: "Page.loadEventFired", params: {} }),
		isAttached: () => attached,
	};
	const guard = new NavGuard({
		cdp,
		settings: async () => ({ level: options.level ?? "always", riskyDomains: DEFAULT_RISKY_DOMAINS, rules: structuredClone(rules) }),
		saveRule: async (site: string, category: string, decision: string) => {
			saved.push([site, category, decision]);
			rules[site] = { ...rules[site], [category]: decision };
		},
		approve: async (request: any, tabId: number) => {
			asked.push({ request, tabId });
			return options.approve ? options.approve(request) : true;
		},
		waiting: (tabId: number) => waiting.push(tabId),
		graceMs: 0,
		opened: options.opened,
		newTabWaitMs: options.newTabWaitMs ?? 0,
		lateGroupMs: options.lateGroupMs,
	});
	let nextId = 1;
	const pause = (url: string, extra: Record<string, unknown> = {}) => {
		const params = { requestId: `r${nextId++}`, frameId: "MAIN", resourceType: "Document", request: { url, method: "GET" }, ...extra };
		return Promise.all([...(listeners.get("Fetch.requestPaused") ?? [])].map((listener) => listener(TAB, params))).then(() => params.requestId);
	};
	const fetchCalls = () => sent.filter((entry) => entry.method.startsWith("Fetch.")).map((entry) => [entry.method, entry.params]);
	const fire = (method: string, params: unknown) => {
		for (const listener of listeners.get(method) ?? []) listener(TAB, params);
	};
	return { guard, sent, asked, waiting, pause, fire, fetchCalls, saved, rules, failNext: (method: string) => failing.add(method), detach: () => (attached = false) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const ENABLE = ["Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] }];

test("always: a main-frame document load in an action window asks, then continues on approval", async () => {
	const { guard, asked, waiting, pause, fetchCalls } = setup();
	await guard.begin(TAB);
	const id = await pause("https://example.com/next");
	await guard.drain(TAB);
	assert.equal(asked.length, 1);
	assert.equal(asked[0].tabId, TAB);
	assert.deepEqual(
		{ kind: asked[0].request.kind, url: asked[0].request.url, level: asked[0].request.level },
		{ kind: "navigate", url: "https://example.com/next", level: "always" },
	);
	assert.match(asked[0].request.title, /example\.com\/next/);
	assert.equal(typeof asked[0].request.reason, "string");
	assert.equal(typeof asked[0].request.detail, "string");
	assert.deepEqual(waiting, [TAB]);
	assert.deepEqual(fetchCalls(), [ENABLE, ["Fetch.continueRequest", { requestId: id }]]);
	guard.end(TAB);
});

test("always: a denied load fails with BlockedByClient and drain reports the denial", async () => {
	const { guard, pause, fetchCalls } = setup({ approve: () => false });
	await guard.begin(TAB);
	const id = await pause("https://example.com/next");
	await assert.rejects(guard.drain(TAB), NOT_APPROVED);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }]);
	await guard.drain(TAB);
	guard.end(TAB);
});

test("sub-frame documents continue without asking", async () => {
	const { guard, asked, pause, fetchCalls } = setup();
	await guard.begin(TAB);
	const id = await pause("https://ads.test/frame", { frameId: "CHILD" });
	await guard.drain(TAB);
	assert.deepEqual(asked, []);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: id }]);
	guard.end(TAB);
});

test("never and remember with a saved allow continue without asking; remember without one asks, offering to save", async () => {
	const never = setup({ level: "never", approve: () => false });
	await never.guard.begin(TAB);
	const risky = await never.pause("https://www.paypal.com/signin");
	await never.guard.drain(TAB);
	assert.deepEqual(never.asked, []);
	assert.deepEqual(never.fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: risky }]);
	never.guard.end(TAB);

	const { guard, asked, pause, fetchCalls } = setup({ level: "remember", rules: { "example.com": { navigate: "allow" } } });
	await guard.begin(TAB);
	const safe = await pause("https://www.example.com/next");
	await guard.drain(TAB);
	assert.equal(asked.length, 0);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: safe }]);
	await pause("https://www.paypal.com/signin");
	await guard.drain(TAB);
	assert.equal(asked.length, 1);
	assert.match(asked[0].request.reason, /paypal\.com/);
	assert.deepEqual({ level: asked[0].request.level, remember: asked[0].request.remember }, { level: "remember", remember: { site: "paypal.com", category: "navigate" } });
	guard.end(TAB);
});

test("an approved load covers its redirect chain in always; remember still asks for a risky redirect", async () => {
	const always = setup();
	await always.guard.begin(TAB);
	await always.pause("https://short.test/x");
	const redirect = await always.pause("https://example.com/landing", { redirectedRequestId: "r1" });
	await always.guard.drain(TAB);
	assert.equal(always.asked.length, 1);
	assert.deepEqual(always.fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: redirect }]);
	always.guard.end(TAB);

	const remember = setup({ level: "remember" });
	await remember.guard.begin(TAB, { allowedUrl: "https://short.test/x" });
	await remember.pause("https://short.test/x");
	await remember.pause("https://www.paypal.com/checkout", { redirectedRequestId: "r1" });
	await remember.guard.drain(TAB);
	assert.equal(remember.asked.length, 1);
	assert.equal(remember.asked[0].request.url, "https://www.paypal.com/checkout");
	remember.guard.end(TAB);
});

test("a pre-approved navigation is not asked again", async () => {
	const { guard, asked, pause, fetchCalls } = setup();
	await guard.begin(TAB, { allowedUrl: "https://example.org/docs" });
	const id = await pause("https://example.org/docs");
	await guard.drain(TAB);
	assert.deepEqual(asked, []);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: id }]);
	guard.end(TAB);
});

test("approve throwing fails the request closed", async () => {
	const { guard, pause, fetchCalls } = setup({
		approve: () => {
			throw new Error("Timed out waiting for approve");
		},
	});
	await guard.begin(TAB);
	const id = await pause("https://example.com/next");
	await assert.rejects(guard.drain(TAB), NOT_APPROVED);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }]);
	guard.end(TAB);
});

test("Fetch is enabled only inside the window: disabled after it, and later loads are not paused", async () => {
	const { guard, asked, pause, fetchCalls } = setup();
	await guard.begin(TAB);
	guard.end(TAB);
	await tick();
	assert.deepEqual(fetchCalls(), [ENABLE, ["Fetch.disable", {}]]);
	const id = await pause("https://example.com/user-click");
	assert.deepEqual(asked, []);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: id }]);
	await guard.drain(TAB);
});

test("a detached tab is not re-attached just to disable Fetch", async () => {
	const { guard, fetchCalls, detach } = setup();
	await guard.begin(TAB);
	detach();
	guard.end(TAB);
	await tick();
	assert.deepEqual(fetchCalls(), [ENABLE]);
});

test("STOP during a pending approval fails the request", async () => {
	let answer: (value: boolean) => void = () => {};
	const { guard, pause, fetchCalls } = setup({ approve: () => new Promise((resolve) => (answer = resolve)) });
	await guard.begin(TAB);
	const pending = pause("https://example.com/next");
	await tick();
	await guard.stop();
	const id = await pending;
	answer(true);
	await tick();
	const calls = fetchCalls();
	assert.deepEqual(calls.find(([method]) => method === "Fetch.failRequest"), ["Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }]);
	assert.equal(calls.some(([method]) => method === "Fetch.continueRequest"), false);
});

test("the waiting label is the shared one", () => {
	assert.equal(WAITING_LABEL, "Waiting for your approval in Gentle Shell…");
});

// Tabs opened by an action (target=_blank, window.open, middle click).

const GROUP = 10;
const NEW = 200;

/** Fake chrome for a real TabGroup whose group already exists; logs every tab change. */
function fakeTabs() {
	const tabs = new Map<number, { id: number; groupId: number; url: string; pendingUrl?: string; openerTabId?: number }>();
	tabs.set(TAB, { id: TAB, groupId: GROUP, url: "https://example.com/" });
	const calls: string[] = [];
	const find = (id: number) => {
		const tab = tabs.get(id);
		if (!tab) throw new Error(`No tab with id: ${id}.`);
		return tab;
	};
	const api: any = {
		tabs: {
			async get(id: number) {
				return { ...find(id) };
			},
			async query() {
				return [...tabs.values()].map((tab) => ({ ...tab }));
			},
			async create() {
				throw new Error("not used");
			},
			async group({ tabIds, groupId }: { tabIds: number; groupId: number }) {
				calls.push(`group ${tabIds} ${groupId}`);
				find(tabIds).groupId = groupId;
				return groupId;
			},
			async ungroup(id: number) {
				calls.push(`ungroup ${id}`);
				find(id).groupId = -1;
			},
			async remove(id: number) {
				calls.push(`remove ${id}`);
				find(id);
				tabs.delete(id);
			},
		},
		tabGroups: {
			async get(id: number) {
				if (id !== GROUP) throw new Error(`No group with id: ${id}.`);
				return { id, windowId: 1, title: "Gentle Shell", color: "pink" };
			},
			async query() {
				return [];
			},
			async update() {},
		},
		windows: { getLastFocused: async () => ({ id: 1 }) },
		storage: { local: { get: async () => ({ groupId: GROUP }), set: async () => {} } },
	};
	const group = new TabGroup(api);
	/** Chrome creating a tab; by default it joins the opener's group, as Chrome does. */
	const open = (opener: number | undefined, url: string, extra: { groupId?: number; url?: string } = {}) => {
		const tab = { id: NEW, openerTabId: opener, groupId: extra.groupId ?? GROUP, url: extra.url ?? "", pendingUrl: url };
		tabs.set(NEW, tab);
		return { ...tab };
	};
	return { group, tabs, calls, open };
}

const NEW_URL = "https://example.com/new";

test("a tab opened by an action leaves the group before anything else, and the agent cannot use it while undecided", async () => {
	const chrome = fakeTabs();
	let answer: (value: boolean) => void = () => {};
	let callsWhenAsked: string[] = [];
	const { guard, asked, waiting } = setup({
		opened: chrome.group,
		approve: () => {
			callsWhenAsked = [...chrome.calls];
			return new Promise((resolve) => (answer = resolve));
		},
	});
	await guard.begin(TAB);
	const decided = guard.created(chrome.open(TAB, NEW_URL));
	await tick();
	assert.deepEqual(callsWhenAsked, [`ungroup ${NEW}`]);
	assert.equal(chrome.tabs.get(NEW)!.groupId, -1);
	await assert.rejects(chrome.group.requireTab(NEW), { message: `Tab ${NEW} is not in the Gentle Shell group. Ask the user to drag it into the group.` });
	assert.deepEqual(await chrome.group.tabs(), [{ tabId: TAB, title: "", url: "https://example.com/", active: false }]);
	assert.deepEqual(waiting, [TAB]);
	assert.equal(asked.length, 1);
	answer(true);
	await decided;
	guard.end(TAB);
});

test("always: a new tab asks with kind open and joins the group when approved", async () => {
	const chrome = fakeTabs();
	const { guard, asked } = setup({ opened: chrome.group });
	await guard.begin(TAB);
	await guard.created(chrome.open(TAB, NEW_URL));
	assert.equal(asked.length, 1);
	assert.equal(asked[0].tabId, TAB);
	assert.deepEqual(
		{ kind: asked[0].request.kind, title: asked[0].request.title, url: asked[0].request.url, level: asked[0].request.level },
		{ kind: "open", title: `open a new tab from this action: ${NEW_URL}`, url: NEW_URL, level: "always" },
	);
	assert.equal(typeof asked[0].request.reason, "string");
	assert.match(asked[0].request.detail, new RegExp(`tab ${NEW}`));
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `group ${NEW} ${GROUP}`]);
	assert.equal((await chrome.group.requireTab(NEW)).id, NEW);
	assert.deepEqual(await guard.drain(TAB), [{ tabId: NEW, url: NEW_URL, added: true }]);
	assert.deepEqual(await guard.drain(TAB), []);
	guard.end(TAB);
});

test("always: a denied new tab is closed and reported as not added", async () => {
	const chrome = fakeTabs();
	const { guard } = setup({ opened: chrome.group, approve: () => false });
	await guard.begin(TAB);
	guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(await guard.drain(TAB), [{ tabId: NEW, url: NEW_URL, added: false }]);
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	assert.equal(chrome.tabs.has(NEW), false);
	guard.end(TAB);
});

test("approve throwing closes the new tab", async () => {
	const chrome = fakeTabs();
	const { guard } = setup({
		opened: chrome.group,
		approve: () => {
			throw new Error("Timed out waiting for approve");
		},
	});
	await guard.begin(TAB);
	await guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	guard.end(TAB);
});

test("never and remember with a saved allow admit a new tab without asking; remember without one asks", async () => {
	for (const options of [{ level: "never" }, { level: "remember", rules: { "example.com": { navigate: "allow" } } }]) {
		const safe = fakeTabs();
		const quiet = setup({ ...options, opened: safe.group, approve: () => false });
		await quiet.guard.begin(TAB);
		await quiet.guard.created(safe.open(TAB, NEW_URL));
		assert.deepEqual(quiet.asked, [], options.level);
		assert.deepEqual(safe.calls, [`ungroup ${NEW}`, `group ${NEW} ${GROUP}`], options.level);
		quiet.guard.end(TAB);
	}
	const blank = fakeTabs();
	const never = setup({ level: "never", opened: blank.group, approve: () => false });
	await never.guard.begin(TAB);
	await never.guard.created(blank.open(TAB, "", { url: "about:blank" }));
	assert.deepEqual(never.asked, []);
	assert.deepEqual(blank.calls, [`ungroup ${NEW}`, `group ${NEW} ${GROUP}`]);
	never.guard.end(TAB);

	const risky = fakeTabs();
	const asking = setup({ level: "remember", opened: risky.group, approve: () => false });
	await asking.guard.begin(TAB);
	await asking.guard.created(risky.open(TAB, "https://www.paypal.com/checkout"));
	assert.equal(asking.asked.length, 1);
	assert.match(asking.asked[0].request.reason, /paypal\.com/);
	assert.deepEqual(risky.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	asking.guard.end(TAB);
});

test("tabs opened from outside the group are never touched", async () => {
	const chrome = fakeTabs();
	const { guard, asked } = setup({ opened: chrome.group });
	await guard.begin(TAB);
	await guard.created(chrome.open(7, NEW_URL));
	await guard.created(chrome.open(undefined, NEW_URL));
	guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(asked, []);
	assert.deepEqual(chrome.calls, []);
	assert.equal(chrome.tabs.get(NEW)!.groupId, GROUP);
	guard.end(TAB);
});

test("Chrome adding the undecided tab to the group later is undone", async () => {
	const chrome = fakeTabs();
	let answer: (value: boolean) => void = () => {};
	const { guard } = setup({ opened: chrome.group, approve: () => new Promise((resolve) => (answer = resolve)) });
	await guard.begin(TAB);
	const decided = guard.created(chrome.open(TAB, NEW_URL, { groupId: -1 }));
	await tick();
	assert.deepEqual(chrome.calls, []);
	chrome.tabs.get(NEW)!.groupId = GROUP;
	guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`]);
	answer(false);
	await decided;
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	guard.end(TAB);
});

test("a new tab without a web address yet waits for one; without it, remember asks even with saved allows", async () => {
	const later = fakeTabs();
	const waits = setup({ level: "remember", rules: { "example.com": { navigate: "allow" } }, opened: later.group, newTabWaitMs: 1000 });
	await waits.guard.begin(TAB);
	const decided = waits.guard.created(later.open(TAB, "", { url: "about:blank" }));
	await tick();
	waits.guard.tabUpdated(NEW, { url: NEW_URL });
	await decided;
	assert.deepEqual(waits.asked, []);
	assert.deepEqual(await waits.guard.drain(TAB), [{ tabId: NEW, url: NEW_URL, added: true }]);
	waits.guard.end(TAB);

	const never = fakeTabs();
	const asks = setup({ level: "remember", rules: { "example.com": { navigate: "allow" } }, opened: never.group, approve: () => false });
	await asks.guard.begin(TAB);
	await asks.guard.created(never.open(TAB, "", { url: "about:blank" }));
	assert.equal(asks.asked.length, 1);
	assert.deepEqual(never.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	asks.guard.end(TAB);
});

test("STOP while a new tab waits for approval closes it", async () => {
	const chrome = fakeTabs();
	let answer: (value: boolean) => void = () => {};
	const { guard } = setup({ opened: chrome.group, approve: () => new Promise((resolve) => (answer = resolve)) });
	await guard.begin(TAB);
	const decided = guard.created(chrome.open(TAB, NEW_URL));
	await tick();
	await guard.stop();
	await decided;
	answer(true);
	await tick();
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
});

// B1: in always mode only the exact approved URL, or a redirect of an approved request, is covered.

test("always: approving one page does not cover a different page later in the same action", async () => {
	const { guard, asked, pause, fetchCalls } = setup();
	await guard.begin(TAB);
	await pause("https://attacker.example/");
	const mail = await pause("https://mail.google.com/mail/u/0/");
	await guard.drain(TAB);
	assert.deepEqual(asked.map((entry) => entry.request.url), ["https://attacker.example/", "https://mail.google.com/mail/u/0/"]);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: mail }]);
	guard.end(TAB);
});

test("always: a harmless second load the page starts on its own asks too", async () => {
	const { guard, asked, pause, fetchCalls } = setup({ approve: () => false });
	await guard.begin(TAB, { allowedUrl: "https://example.org/docs" });
	await pause("https://example.org/docs");
	const second = await pause("https://example.org/next");
	await assert.rejects(guard.drain(TAB), NOT_APPROVED);
	assert.deepEqual(asked.map((entry) => entry.request.url), ["https://example.org/next"]);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.failRequest", { requestId: second, errorReason: "BlockedByClient" }]);
	guard.end(TAB);
});

test("always: a redirect is covered through its network id, but a redirect to a risky page asks unless that URL was approved", async () => {
	const { guard, asked, pause } = setup();
	await guard.begin(TAB);
	await pause("https://short.test/x", { networkId: "n1" });
	await pause("https://example.com/landing", { networkId: "n1" });
	assert.equal(asked.length, 1);
	await pause("https://www.paypal.com/checkout", { networkId: "n1" });
	await guard.drain(TAB);
	assert.deepEqual(asked.map((entry) => entry.request.url), ["https://short.test/x", "https://www.paypal.com/checkout"]);
	guard.end(TAB);

	const exact = setup();
	await exact.guard.begin(TAB, { allowedUrl: "https://www.paypal.com/checkout" });
	await exact.pause("https://www.paypal.com/checkout");
	await exact.guard.drain(TAB);
	assert.deepEqual(exact.asked, []);
	exact.guard.end(TAB);
});

// F5: a failed begin leaves nothing behind.

test("a failed begin leaves no state: the next action turns interception on again", async () => {
	for (const method of ["Page.getFrameTree", "Fetch.enable"]) {
		const { guard, asked, pause, fetchCalls, failNext } = setup();
		failNext(method);
		await assert.rejects(guard.begin(TAB), { message: `${method} failed` });
		await guard.begin(TAB);
		assert.deepEqual(fetchCalls().filter(([name]) => name === "Fetch.enable").length, method === "Fetch.enable" ? 2 : 1, method);
		await pause("https://example.com/next");
		await guard.drain(TAB);
		assert.equal(asked.length, 1, method);
		guard.end(TAB);
		await tick();
		assert.deepEqual(fetchCalls().at(-1), ["Fetch.disable", {}], method);
	}
});

// F2: service workers are bypassed during the window; navigations that skip Fetch are reported.

test("service workers are bypassed only during the action window", async () => {
	const { guard, sent } = setup();
	const network = () => sent.filter((entry) => entry.method.startsWith("Network.")).map((entry) => [entry.method, entry.params]);
	await guard.begin(TAB);
	assert.deepEqual(network(), [["Network.enable", {}], ["Network.setBypassServiceWorker", { bypass: true }]]);
	guard.end(TAB);
	await tick();
	assert.deepEqual(network().slice(2), [["Network.setBypassServiceWorker", { bypass: false }], ["Network.disable", {}]]);
});

test("a main-frame change that did not pass the guard is reported once", async () => {
	const { guard, fire } = setup();
	await guard.begin(TAB);
	fire("Page.frameNavigated", { frame: { id: "MAIN", url: "https://example.com/cached" }, type: "BackForwardCacheRestore" });
	assert.deepEqual(guard.unguarded(TAB), { url: "https://example.com/cached" });
	assert.equal(guard.unguarded(TAB), undefined);
	fire("Page.frameNavigated", { frame: { id: "MAIN", url: "https://example.com/from-worker" }, type: "Navigation" });
	assert.deepEqual(guard.unguarded(TAB), { url: "https://example.com/from-worker" });
	fire("Page.navigatedWithinDocument", { frameId: "MAIN", url: "https://example.com/route" });
	assert.deepEqual(guard.unguarded(TAB), { url: "https://example.com/route" });
	guard.end(TAB);
});

test("guarded loads, hash jumps, sub-frames, error pages and changes outside a window are not reported", async () => {
	const { guard, fire, pause } = setup();
	fire("Page.frameNavigated", { frame: { id: "MAIN", url: "https://example.com/user" }, type: "Navigation" });
	await guard.begin(TAB);
	await pause("https://example.com/next");
	await guard.drain(TAB);
	fire("Page.frameNavigated", { frame: { id: "MAIN", url: "https://example.com/next" }, type: "Navigation" });
	fire("Page.navigatedWithinDocument", { frameId: "MAIN", url: "https://example.com/next#section" });
	fire("Page.frameNavigated", { frame: { id: "CHILD", parentId: "MAIN", url: "https://ads.test/" }, type: "Navigation" });
	fire("Page.navigatedWithinDocument", { frameId: "CHILD", url: "https://ads.test/route" });
	fire("Page.frameNavigated", { frame: { id: "MAIN", url: "chrome-error://chromewebdata/", unreachableUrl: "https://blocked.test/" }, type: "Navigation" });
	assert.equal(guard.unguarded(TAB), undefined);
	guard.end(TAB);
});

// F6: a tab a group tab opens later, outside any action window, is taken out of the group silently.

test("a tab opened from a group tab with no action running is ungrouped without asking; dragging it back grants it", async () => {
	const chrome = fakeTabs();
	const { guard, asked } = setup({ opened: chrome.group });
	await guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`]);
	assert.deepEqual(asked, []);
	assert.equal(chrome.group.isHeld(NEW), false);
	chrome.tabs.get(NEW)!.groupId = GROUP;
	guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`]);
	assert.equal((await chrome.group.requireTab(NEW)).id, NEW);
});

test("Chrome grouping a late tab within the grace is undone; after it, a grouping is left alone", async () => {
	const soon = fakeTabs();
	const early = setup({ opened: soon.group, lateGroupMs: 1000 });
	await early.guard.created(soon.open(TAB, NEW_URL, { groupId: -1 }));
	assert.deepEqual(soon.calls, []);
	soon.tabs.get(NEW)!.groupId = GROUP;
	early.guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(soon.calls, [`ungroup ${NEW}`]);
	assert.deepEqual(early.asked, []);

	const later = fakeTabs();
	const late = setup({ opened: later.group, lateGroupMs: 1 });
	await late.guard.created(later.open(TAB, NEW_URL, { groupId: -1 }));
	await tick();
	later.tabs.get(NEW)!.groupId = GROUP;
	late.guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(later.calls, []);
});

// S12: a new tab is held, admitted or evicted by the opener's session group.

test("opened may be a lookup by opener: the new tab is decided by the opener's group", async () => {
	const chrome = fakeTabs();
	const openers: number[] = [];
	const { guard, asked } = setup({ opened: (opener: number) => (openers.push(opener), chrome.group), approve: () => false });
	await guard.begin(TAB);
	await guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(openers, [TAB]);
	assert.equal(asked.length, 1);
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	guard.end(TAB);
	// A late tab too.
	const late = fakeTabs();
	const lookups: number[] = [];
	const quiet = setup({ opened: (opener: number) => (lookups.push(opener), late.group) });
	await quiet.guard.created(late.open(TAB, NEW_URL));
	assert.deepEqual(lookups, [TAB]);
	assert.deepEqual(late.calls, [`ungroup ${NEW}`]);
});

test("Chrome regrouping a held tab is undone through the group that holds it", async () => {
	const chrome = fakeTabs();
	let answer: (value: boolean) => void = () => {};
	const { guard } = setup({ opened: () => chrome.group, approve: () => new Promise((resolve) => (answer = resolve)) });
	await guard.begin(TAB);
	const decided = guard.created(chrome.open(TAB, NEW_URL));
	await tick();
	chrome.tabs.get(NEW)!.groupId = GROUP;
	guard.tabUpdated(NEW, { groupId: GROUP });
	await tick();
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `ungroup ${NEW}`]);
	answer(false);
	await decided;
	guard.end(TAB);
});

// S14: saved decisions in remember mode.

test("remember: a saved deny fails the load without asking, with the saved rule in the error", async () => {
	const { guard, asked, pause, fetchCalls } = setup({ level: "remember", rules: { "example.com": { navigate: "deny" } } });
	await guard.begin(TAB);
	const id = await pause("https://example.com/next");
	await assert.rejects(guard.drain(TAB), { message: "The user did not approve: load https://example.com/next (saved rule: deny navigate on example.com). The page was not opened." });
	assert.deepEqual(asked, []);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }]);
	guard.end(TAB);
	// A new tab to a denied site is closed without asking.
	const chrome = fakeTabs();
	const tabs = setup({ level: "remember", rules: { "example.com": { navigate: "deny" } }, opened: chrome.group });
	await tabs.guard.begin(TAB);
	await tabs.guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(tabs.asked, []);
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	tabs.guard.end(TAB);
});

test("remember: Always allow on a paused load saves the rule and the next load to that site does not ask", async () => {
	const { guard, asked, pause, saved, fetchCalls } = setup({ level: "remember", approve: () => ({ approved: true, remember: "allow" }) });
	await guard.begin(TAB);
	await pause("https://example.com/next");
	await guard.drain(TAB);
	assert.deepEqual(saved, [["example.com", "navigate", "allow"]]);
	const second = await pause("https://example.com/other");
	await guard.drain(TAB);
	assert.equal(asked.length, 1);
	assert.deepEqual(fetchCalls().at(-1), ["Fetch.continueRequest", { requestId: second }]);
	guard.end(TAB);
	// Always deny on a new tab saves the rule and closes the tab.
	const chrome = fakeTabs();
	const tabs = setup({ level: "remember", opened: chrome.group, approve: () => ({ approved: false, remember: "deny" }) });
	await tabs.guard.begin(TAB);
	await tabs.guard.created(chrome.open(TAB, NEW_URL));
	assert.deepEqual(tabs.saved, [["example.com", "navigate", "deny"]]);
	assert.deepEqual(chrome.calls, [`ungroup ${NEW}`, `remove ${NEW}`]);
	tabs.guard.end(TAB);
});

test("a remember answer to a load in always mode is ignored", async () => {
	const { guard, asked, pause, saved } = setup({ level: "always", approve: () => ({ approved: true, remember: "allow" }) });
	await guard.begin(TAB);
	await pause("https://example.com/next");
	await pause("https://example.com/other");
	await guard.drain(TAB);
	assert.equal(asked.length, 2);
	assert.equal("remember" in asked[0].request, false);
	assert.deepEqual(saved, []);
	guard.end(TAB);
});
