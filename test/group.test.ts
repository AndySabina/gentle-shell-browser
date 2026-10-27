import assert from "node:assert/strict";
import { test } from "node:test";
import { TabGroup } from "../extension/lib/group.js";

interface FakeTab {
	id: number;
	windowId: number;
	groupId: number;
	title: string;
	url: string;
	active: boolean;
}

interface FakeGroup {
	id: number;
	windowId: number;
	title: string;
	color: string;
}

/** A tiny in-memory stand-in for the parts of `chrome` that TabGroup uses. */
function fakeChrome() {
	const tabs: FakeTab[] = [];
	const groups: FakeGroup[] = [];
	const storage: Record<string, unknown> = {};
	let nextTab = 100;
	let nextGroup = 10;
	const api = {
		tabs: {
			async create(props: { url: string; active?: boolean; windowId?: number }) {
				const tab = { id: nextTab++, windowId: props.windowId ?? 1, groupId: -1, title: "", url: props.url, active: Boolean(props.active) };
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
			async group(options: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }) {
				const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
				let groupId = options.groupId;
				if (groupId === undefined) {
					groupId = nextGroup++;
					groups.push({ id: groupId, windowId: options.createProperties?.windowId ?? 1, title: "", color: "grey" });
				}
				for (const id of ids) {
					const tab = tabs.find((t) => t.id === id);
					if (tab) tab.groupId = groupId;
				}
				return groupId;
			},
			async ungroup(id: number) {
				const tab = tabs.find((t) => t.id === id);
				if (!tab) throw new Error(`No tab with id: ${id}.`);
				tab.groupId = -1;
			},
			async remove(id: number) {
				const index = tabs.findIndex((t) => t.id === id);
				if (index < 0) throw new Error(`No tab with id: ${id}.`);
				tabs.splice(index, 1);
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
		storage: {
			local: {
				async get(keys: Record<string, unknown>) {
					const out: Record<string, unknown> = {};
					for (const [key, fallback] of Object.entries(keys)) out[key] = key in storage ? storage[key] : fallback;
					return out;
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storage, items);
				},
			},
		},
	};
	return { api, tabs, groups, storage, addTab: (tab: Partial<FakeTab>) => tabs.push({ id: nextTab++, windowId: 1, groupId: -1, title: "", url: "about:blank", active: false, ...tab }), addGroup: (group: Partial<FakeGroup>) => groups.push({ id: nextGroup++, windowId: 1, title: "", color: "grey", ...group }) };
}

test("openTab creates the Gentle Shell group with its title and color and stores its id", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	assert.equal(await group.current(), undefined);
	const opened = await group.openTab("https://example.com/");
	assert.equal(chrome.groups.length, 1);
	assert.deepEqual({ title: chrome.groups[0].title, color: chrome.groups[0].color }, { title: "Gentle Shell", color: "pink" });
	assert.deepEqual(opened, { tabId: chrome.tabs[0].id, groupId: chrome.groups[0].id });
	assert.equal(chrome.storage.groupId, chrome.groups[0].id);
	assert.equal(chrome.tabs[0].active, false);
	assert.equal(await group.current(), chrome.groups[0].id);
});

test("openTab opens the tab in the background so the user keeps their own tab", async () => {
	const fake = fakeChrome();
	fake.addTab({ title: "Mine", url: "https://mine.test/", active: true });
	const own = fake.tabs.find((tab) => tab.title === "Mine")!;
	const group = new TabGroup(fake.api);
	const { tabId } = await group.openTab("https://example.com/");
	assert.equal(fake.tabs.find((tab) => tab.id === tabId)?.active, false);
	assert.equal(own.active, true);
});

test("openTab reuses the existing group instead of creating another", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	const first = await group.openTab("https://example.com/");
	const second = await group.openTab("https://example.org/");
	assert.equal(chrome.groups.length, 1);
	assert.equal(second.groupId, first.groupId);
	assert.notEqual(second.tabId, first.tabId);
});

test("a group the user titled Gentle Shell is adopted when no stored group exists", async () => {
	const chrome = fakeChrome();
	chrome.addGroup({ title: "Work", color: "blue" });
	chrome.addGroup({ title: "Gentle Shell", color: "green", windowId: 2 });
	const adopted = chrome.groups[1].id;
	chrome.storage.groupId = 999;
	const group = new TabGroup(chrome.api);
	assert.equal(await group.current(), adopted);
	assert.equal(chrome.storage.groupId, adopted);
	const opened = await group.openTab("https://example.com/");
	assert.equal(opened.groupId, adopted);
	assert.equal(chrome.tabs[0].windowId, 2);
	assert.equal(chrome.groups.length, 2);
});

test("tabs lists only the tabs inside the group", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	assert.deepEqual(await group.tabs(), []);
	chrome.addTab({ title: "Outside", url: "https://outside.test/" });
	const { tabId } = await group.openTab("https://inside.test/");
	const inside = chrome.tabs.find((t) => t.id === tabId)!;
	inside.title = "Inside";
	assert.deepEqual(await group.tabs(), [{ tabId, title: "Inside", url: "https://inside.test/", active: false }]);
});

test("requireTab refuses a tab outside the group with the exact message", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	const { tabId } = await group.openTab("https://inside.test/");
	chrome.addTab({ url: "https://outside.test/" });
	const outside = chrome.tabs.at(-1)!.id;
	const tab = await group.requireTab(tabId);
	assert.equal(tab.id, tabId);
	await assert.rejects(group.requireTab(outside), { message: `Tab ${outside} is not in the Gentle Shell group. Ask the user to drag it into the group.` });
});

test("requireTab refuses a tab the user dragged out of the group", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	const { tabId } = await group.openTab("https://inside.test/");
	chrome.tabs.find((t) => t.id === tabId)!.groupId = -1;
	await assert.rejects(group.requireTab(tabId), { message: `Tab ${tabId} is not in the Gentle Shell group. Ask the user to drag it into the group.` });
});

test("requireTab explains when no group exists yet", async () => {
	const chrome = fakeChrome();
	chrome.addTab({ url: "https://outside.test/" });
	const group = new TabGroup(chrome.api);
	await assert.rejects(group.requireTab(chrome.tabs[0].id), { message: "There is no Gentle Shell group yet. Use browser_open to create it." });
});

test("a held tab leaves the group, is refused and hidden, and comes back only when admitted", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	const { groupId } = await group.openTab("https://inside.test/");
	chrome.addTab({ url: "https://opened.test/", groupId });
	const opened = chrome.tabs.at(-1)!.id;
	await group.hold(opened);
	assert.equal(group.isHeld(opened), true);
	assert.equal(chrome.tabs.find((t) => t.id === opened)!.groupId, -1);
	await assert.rejects(group.requireTab(opened), { message: `Tab ${opened} is not in the Gentle Shell group. Ask the user to drag it into the group.` });
	// Even when Chrome puts it back before hold runs again.
	chrome.tabs.find((t) => t.id === opened)!.groupId = groupId;
	await assert.rejects(group.requireTab(opened), { message: /is not in the Gentle Shell group/ });
	assert.deepEqual((await group.tabs()).map((tab) => tab.tabId), [chrome.tabs[0].id]);
	await group.admit(opened);
	assert.equal(group.isHeld(opened), false);
	assert.equal((await group.requireTab(opened)).groupId, groupId);
});

test("hold leaves a tab in another group alone; discard closes the held tab", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	await group.openTab("https://inside.test/");
	chrome.addGroup({ title: "Work" });
	chrome.addTab({ url: "https://opened.test/", groupId: chrome.groups[1].id });
	const opened = chrome.tabs.at(-1)!.id;
	await group.hold(opened);
	assert.equal(chrome.tabs.find((t) => t.id === opened)!.groupId, chrome.groups[1].id);
	await group.discard(opened);
	assert.equal(group.isHeld(opened), false);
	assert.equal(chrome.tabs.some((t) => t.id === opened), false);
});

test("contains answers the group check without throwing; held tabs are not contained", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	assert.equal(await group.contains(1), false);
	const { tabId, groupId } = await group.openTab("https://inside.test/");
	chrome.addTab({ url: "https://outside.test/" });
	assert.equal(await group.contains(tabId), true);
	assert.equal(await group.contains(chrome.tabs.at(-1)!.id), false);
	assert.equal(await group.contains("5"), false);
	chrome.addTab({ url: "https://opened.test/", groupId });
	const opened = chrome.tabs.at(-1)!.id;
	await group.hold(opened);
	chrome.tabs.find((t) => t.id === opened)!.groupId = groupId;
	assert.equal(await group.contains(opened), false);
});

test("evict takes a tab out of the group without holding it; a tab elsewhere is left alone", async () => {
	const chrome = fakeChrome();
	const group = new TabGroup(chrome.api);
	const { groupId } = await group.openTab("https://inside.test/");
	chrome.addTab({ url: "https://late.test/", groupId });
	const late = chrome.tabs.at(-1)!.id;
	assert.equal(await group.evict(late), true);
	assert.equal(chrome.tabs.find((t) => t.id === late)!.groupId, -1);
	assert.equal(group.isHeld(late), false);
	assert.equal(await group.evict(late), false);
	chrome.tabs.find((t) => t.id === late)!.groupId = groupId;
	assert.equal(await group.contains(late), true);
	assert.equal(await group.evict(999), false);
});

// S12: one TabGroup per session, with its own title and stored id.

function sessionGroup(chrome: ReturnType<typeof fakeChrome>, title: string, id: string, adoptable: (groupId: number) => boolean | Promise<boolean> = () => true) {
	const load = async () => ((chrome.storage.groups as Record<string, number> | undefined) ?? {})[id];
	const save = async (groupId: number | undefined) => {
		const groups = { ...((chrome.storage.groups as Record<string, number> | undefined) ?? {}) };
		if (groupId === undefined) delete groups[id];
		else groups[id] = groupId;
		chrome.storage.groups = groups;
	};
	return new TabGroup(chrome.api, { title, load, save, adoptable });
}

test("a session group uses its own title and stored id and leaves the single-group key alone", async () => {
	const chrome = fakeChrome();
	const alpha = sessionGroup(chrome, "Gentle · alpha", "a");
	const beta = sessionGroup(chrome, "Gentle · beta", "b");
	const one = await alpha.openTab("https://a.test/");
	const two = await beta.openTab("https://b.test/");
	assert.notEqual(one.groupId, two.groupId);
	assert.deepEqual(chrome.groups.map((g) => [g.title, g.color]), [["Gentle · alpha", "pink"], ["Gentle · beta", "pink"]]);
	assert.deepEqual(chrome.storage.groups, { a: one.groupId, b: two.groupId });
	assert.equal(chrome.storage.groupId, undefined);
	await assert.rejects(alpha.requireTab(two.tabId), { message: `Tab ${two.tabId} is not in the Gentle Shell group. Ask the user to drag it into the group.` });
	assert.equal(await beta.contains(two.tabId), true);
});

test("a session group adopts only a group with its own title that no other session owns", async () => {
	const chrome = fakeChrome();
	chrome.addGroup({ title: "Gentle Shell" });
	chrome.addGroup({ title: "Gentle · beta" });
	const owned = chrome.groups[1].id;
	assert.equal(await sessionGroup(chrome, "Gentle · alpha", "a").current(), undefined);
	assert.equal(await sessionGroup(chrome, "Gentle · beta", "b", (groupId) => groupId !== owned).current(), undefined);
	assert.equal(await sessionGroup(chrome, "Gentle · beta", "b").current(), owned);
	assert.deepEqual(chrome.storage.groups, { b: owned });
});

test("end renames the group as ended and forgets it, so it is never adopted again", async () => {
	const chrome = fakeChrome();
	const beta = sessionGroup(chrome, "Gentle · beta", "b");
	const { groupId } = await beta.openTab("https://b.test/");
	await beta.end();
	assert.equal(chrome.groups.find((g) => g.id === groupId)!.title, "Gentle · beta (ended)");
	assert.deepEqual(chrome.storage.groups, {});
	assert.equal(await sessionGroup(chrome, "Gentle · beta", "c").current(), undefined);
	// Nothing stored: nothing to rename.
	await sessionGroup(chrome, "Gentle · gamma", "g").end();
	assert.equal(chrome.groups.length, 1);
});

test("adoption takes only a group with exactly this title, never an ended one, even if the query matches more", async () => {
	const chrome = fakeChrome();
	// A query that returns every group, as if the title were a pattern.
	chrome.api.tabGroups.query = async () => chrome.groups.map((g) => ({ ...g }));
	chrome.addGroup({ title: "Gentle · alpha" });
	chrome.addGroup({ title: "Gentle · alpha (ended)" });
	chrome.addTab({ url: "https://secret.test/", groupId: chrome.groups[1].id });
	assert.equal(await sessionGroup(chrome, "*", "x").current(), undefined);
	assert.deepEqual(await sessionGroup(chrome, "Gentle · alpha (ended)", "y").tabs(), []);
	assert.equal(await sessionGroup(chrome, "Gentle · alpha", "z").current(), chrome.groups[0].id);
	assert.deepEqual(chrome.storage.groups, { z: chrome.groups[0].id });
});
