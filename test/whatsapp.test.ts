import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sessionHandlers } from "../extension/lib/sessions.js";
import { chatKey, cleanChatName, parseRows, WhatsAppWatch, watchPopup } from "../extension/lib/whatsapp.js";

const WA = "https://web.whatsapp.com/";

function memoryStorage(initial: Record<string, unknown> = {}) {
	const data: Record<string, unknown> = structuredClone(initial);
	return {
		data,
		async get(keys: Record<string, unknown>) {
			const out: Record<string, unknown> = {};
			for (const [key, fallback] of Object.entries(keys)) out[key] = key in data ? structuredClone(data[key]) : fallback;
			return out;
		},
		async set(items: Record<string, unknown>) {
			Object.assign(data, structuredClone(items));
		},
	};
}

type Tab = { tabId: number; url: string };

function fakeSession(id: string, tabs: Tab[], state = "connected") {
	const calls: { method: string; params: any }[] = [];
	const opened: string[] = [];
	return {
		id,
		name: id,
		calls,
		opened,
		group: {
			tabs: async () => tabs.map((tab) => ({ ...tab, title: "", active: false })),
			contains: async (tabId: number) => tabs.some((tab) => tab.tabId === tabId),
			openTab: async (url: string) => {
				opened.push(url);
				const tabId = 100 + opened.length;
				tabs.push({ tabId, url });
				return { tabId, groupId: 1 };
			},
		},
		connection: {
			state,
			call: async (method: string, params: any) => {
				calls.push({ method, params });
				return { queued: true };
			},
		},
	};
}

function setup(options: { allow?: string[]; tabs?: Tab[]; rows?: unknown[] } = {}) {
	const local = memoryStorage(options.allow ? { whatsappAllow: options.allow } : {});
	const session = memoryStorage();
	const alpha = fakeSession("session-alpha", options.tabs ?? [{ tabId: 7, url: WA }]);
	const beta = fakeSession("session-beta", [{ tabId: 9, url: "https://example.com/" }]);
	const injected: number[] = [];
	let rows = options.rows ?? [];
	const changes: string[] = [];
	const watch = new WhatsAppWatch({
		local,
		session,
		sessions: { live: () => [alpha, beta] as any },
		read: async (tabId: number) => {
			injected.push(tabId);
			return rows;
		},
		changed: () => changes.push("changed"),
	});
	return { watch, local, session, alpha, beta, injected, changes, setRows: (next: unknown[]) => (rows = next) };
}

const row = (name: string, preview: string, badge?: string) => ({ titles: [name, preview], badges: badge === undefined ? [] : [badge] });
const rings = (session: ReturnType<typeof fakeSession>) => session.calls.filter((call) => call.method === "whatsappMessage").map((call) => call.params);

test("parseRows reads name, preview and unread count, and skips rows without a name", () => {
	assert.deepEqual(parseRows([row("Mamá", "hola", "2"), { titles: [], badges: ["1"] }, row("Work", "ok")]), [
		{ name: "Mamá", preview: "hola", unread: 2 },
		{ name: "Work", preview: "ok", unread: 0 },
	]);
});

test("parseRows ignores non-numeric badges, keeps the first row per chat and bounds the text", () => {
	const long = "x".repeat(1000);
	const parsed = parseRows([row("A", long, "muted"), row("A", "second", "5"), "junk", { titles: "no", badges: 3 }]);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].unread, 0);
	assert.equal(parsed[0].preview.length, 300);
});

test("chat names match ignoring case, surrounding and repeated spaces", () => {
	assert.equal(chatKey("  Mamá   Querida "), chatKey("mamá querida"));
	assert.notEqual(chatKey("Mamá"), chatKey("Papá"));
});

test("cleanChatName trims, drops control characters and refuses an empty or too long name", () => {
	assert.equal(cleanChatName("  Mamá\u0007 "), "Mamá");
	assert.throws(() => cleanChatName("   "), /chat name/);
	assert.throws(() => cleanChatName("x".repeat(101)), /chat name/);
	assert.throws(() => cleanChatName(42), /chat name/);
});

test("the allow list adds once per chat, keeps the given spelling and removes by any spelling", async () => {
	const { watch, local } = setup();
	assert.deepEqual(await watch.allowList(), []);
	assert.deepEqual(await watch.allow("Mamá"), { allowed: ["Mamá"] });
	assert.deepEqual(await watch.allow(" mamá "), { allowed: ["Mamá"] });
	await watch.allow("Work");
	assert.deepEqual(await watch.remove("MAMÁ"), { allowed: ["Work"] });
	assert.deepEqual(local.data.whatsappAllow, ["Work"]);
	await assert.rejects(watch.remove("Nobody"), /not on the allow list/);
	assert.deepEqual(local.data.whatsappAllow, ["Work"]);
});

test("the watch is off for a session until switched on, and only for that session", async () => {
	const { watch, alpha, beta } = setup({ allow: ["Mamá"] });
	assert.equal((await watch.state(alpha as any)).on, false);
	const state = await watch.setWatch(alpha as any, true);
	const { lastRead, ...rest } = state as any;
	assert.deepEqual(rest, { on: true, allowed: ["Mamá"], whatsappTabs: 1 });
	assert.equal(lastRead.chats, 0);
	assert.equal((await watch.state(beta as any)).on, false);
	assert.deepEqual(alpha.calls.at(-1), { method: "watchChanged", params: { on: true } });
});

test("a new message from an allowed chat rings the session whose group holds the tab, once", async () => {
	const { watch, alpha, beta, setRows } = setup({ allow: ["Mamá"], rows: [row("Mamá", "viejo", "1"), row("Spam", "x", "4")] });
	await watch.setWatch(alpha as any, true);
	// Already unread when switched on: no ring.
	await watch.report(7, [row("Mamá", "viejo", "1"), row("Spam", "x", "4")]);
	assert.deepEqual(rings(alpha), []);
	setRows([]);
	await watch.report(7, [row("Mamá", "¿venís?", "2"), row("Spam", "y", "5")]);
	assert.deepEqual(rings(alpha), [{ chat: "Mamá", unread: 2, preview: "¿venís?", tabId: 7 }]);
	await watch.report(7, [row("Mamá", "¿venís?", "2")]);
	assert.equal(rings(alpha).length, 1);
	assert.deepEqual(rings(beta), []);
});

test("a chat that was read rings again on its next message", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"], rows: [row("Mamá", "antes")] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "hola", "1")]);
	await watch.report(7, [row("Mamá", "respuesta del agente")]);
	await watch.report(7, [row("Mamá", "gracias", "1")]);
	assert.deepEqual(
		rings(alpha).map((ring) => ring.preview),
		["hola", "gracias"],
	);
});

test("messages already rung never ring again after the agent replied, even when WhatsApp shows them unread again", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "hola")]);
	await watch.report(7, [row("Mamá", "uno", "1")]);
	await watch.report(7, [row("Mamá", "dos", "2")]);
	await watch.report(7, [row("Mamá", "tres", "3")]);
	await watch.report(7, [row("Mamá", "respuesta del agente")]);
	await watch.report(7, [row("Mamá", "uno", "1")]);
	await watch.report(7, [row("Mamá", "respuesta del agente")]);
	await watch.report(7, [row("Mamá", "tres", "3")]);
	await watch.report(7, [row("Mamá", "dos", "1")]);
	assert.deepEqual(
		rings(alpha).map((ring) => ring.preview),
		["uno", "dos", "tres"],
	);
	await watch.report(7, [row("Mamá", "respuesta del agente")]);
	await watch.report(7, [row("Mamá", "nuevo", "1")]);
	assert.deepEqual(rings(alpha).at(-1), { chat: "Mamá", unread: 1, preview: "nuevo", tabId: 7 });
	assert.equal(rings(alpha).length, 4);
});

test("each chat remembers its last 20 rung messages: the same text again does not ring, an older one does", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	const ringOnce = async (preview: string) => {
		await watch.report(7, [row("Mamá", "respuesta del agente")]);
		await watch.report(7, [row("Mamá", preview, "1")]);
	};
	await watch.report(7, [row("Mamá", "hola")]);
	await ringOnce("ok");
	await ringOnce("ok");
	assert.deepEqual(rings(alpha).map((ring) => ring.preview), ["ok"]);
	for (let i = 1; i <= 20; i++) await ringOnce(`mensaje ${i}`);
	assert.equal(rings(alpha).length, 21);
	await ringOnce("ok");
	assert.equal(rings(alpha).length, 22);
	await ringOnce("mensaje 20");
	assert.equal(rings(alpha).length, 22);
});

test("more unread messages always ring, even when the newest has the same text as an older one", async () => {
	const { watch, alpha } = setup({ allow: ["Andy"], rows: [row("Andy", "3", "3")] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Andy", "3", "3")]);
	await watch.report(7, [row("Andy", "3", "6")]);
	assert.deepEqual(rings(alpha), [{ chat: "Andy", unread: 6, preview: "3", tabId: 7 }]);
	await watch.report(7, [row("Andy", "ok", "7")]);
	await watch.report(7, [row("Andy", "ok", "8")]);
	assert.deepEqual(rings(alpha).map((ring) => ring.unread), [6, 7, 8]);
});

test("a message unread when the watch started does not ring when WhatsApp shows it unread again", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"], rows: [row("Mamá", "viejo", "1")] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "viejo", "1")]);
	await watch.report(7, [row("Mamá", "respuesta del agente")]);
	await watch.report(7, [row("Mamá", "viejo", "1")]);
	assert.deepEqual(rings(alpha), []);
});

test("a message that failed to ring rings when it shows unread again", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "hola")]);
	const call = alpha.connection.call;
	alpha.connection.call = async () => {
		throw new Error("Session is busy");
	};
	await watch.report(7, [row("Mamá", "uno", "1")]);
	alpha.connection.call = call;
	await watch.report(7, [row("Mamá", "hola")]);
	await watch.report(7, [row("Mamá", "uno", "1")]);
	assert.deepEqual(rings(alpha).map((ring) => ring.preview), ["uno"]);
});

test("nothing rings while the watch is off, for a chat off the list, or for a tab outside every group", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.report(7, [row("Mamá", "hola", "1")]);
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Otro", "hola", "1")]);
	await watch.report(99, [row("Mamá", "hola", "3")]);
	await watch.setWatch(alpha as any, false);
	await watch.report(7, [row("Mamá", "chau", "4")]);
	assert.deepEqual(rings(alpha), []);
	assert.deepEqual(alpha.calls.at(-1), { method: "watchChanged", params: { on: false } });
});

test("a tab without a baseline (worker restarted) takes its first report as the baseline", async () => {
	const { watch, alpha, session } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	const restarted = new WhatsAppWatch({ local: memoryStorage({ whatsappAllow: ["Mamá"] }), session, sessions: { live: () => [alpha] as any }, read: async () => undefined });
	await restarted.report(7, [row("Mamá", "hola", "1")]);
	assert.deepEqual(rings(alpha), []);
	await restarted.report(7, [row("Mamá", "otra", "2")]);
	assert.equal(rings(alpha).length, 1);
	// What was unread in that first report counts as handled too.
	await restarted.report(7, [row("Mamá", "respuesta del agente")]);
	await restarted.report(7, [row("Mamá", "hola", "1")]);
	assert.equal(rings(alpha).length, 1);
});

test("switching on reads only the session's WhatsApp Web tabs", async () => {
	const { watch, alpha, injected } = setup({ tabs: [{ tabId: 7, url: WA }, { tabId: 8, url: "https://web.whatsapp.com.evil.test/" }, { tabId: 6, url: "https://example.com/" }] });
	const state = await watch.setWatch(alpha as any, true);
	assert.deepEqual(injected, [7]);
	assert.equal(state.whatsappTabs, 1);
});

test("watchSessions lists the sessions whose group holds a WhatsApp Web tab", async () => {
	const { watch, alpha } = setup();
	await watch.setWatch(alpha as any, true);
	assert.deepEqual(await watch.watchSessions(), [{ id: "session-alpha", name: "session-alpha", on: true }]);
});

test("a reloaded WhatsApp tab of a watching session gets the reader again and its unread count as seen", async () => {
	const { watch, alpha, injected, setRows } = setup({ allow: ["Mamá"] });
	await watch.tabLoaded(7, WA);
	assert.deepEqual(injected, [], "watch off: nothing is injected");
	await watch.setWatch(alpha as any, true);
	setRows([row("Mamá", "de antes", "3")]);
	await watch.tabLoaded(7, WA);
	await watch.tabLoaded(9, "https://example.com/");
	assert.deepEqual(injected, [7, 7]);
	await watch.report(7, [row("Mamá", "de antes", "3")]);
	assert.deepEqual(rings(alpha), []);
});

test("the session methods for the user's commands act on that session's watch only", async () => {
	const { watch, alpha, beta } = setup();
	const handlers = sessionHandlers({} as any, alpha as any, { watch } as any);
	assert.deepEqual(await handlers.allowChat({ chat: "Mamá" }), { allowed: ["Mamá"] });
	const pick = ({ on, allowed, whatsappTabs }: any) => ({ on, allowed, whatsappTabs });
	assert.deepEqual(pick(await handlers.setWatch({ on: true })), { on: true, allowed: ["Mamá"], whatsappTabs: 1 });
	assert.deepEqual(pick(await handlers.getWatch({})), { on: true, allowed: ["Mamá"], whatsappTabs: 1 });
	assert.equal((await watch.state(beta as any)).on, false);
	// Only a literal true switches it on.
	assert.equal((await handlers.setWatch({ on: "yes" })).on, false);
	assert.deepEqual(await handlers.removeChat({ chat: "mamá" }), { allowed: [] });
	await assert.rejects(handlers.allowChat({ chat: "" }), /chat name/);
});

test("the manifest may inject only into WhatsApp Web, and declares no content script that runs on its own", () => {
	const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
	assert.ok(manifest.permissions.includes("scripting"));
	assert.deepEqual(manifest.host_permissions, ["https://web.whatsapp.com/*"]);
	assert.equal(manifest.content_scripts, undefined);
});

test("the WhatsApp reader only reads: no network, no page edits, messages only to the extension", () => {
	const reader = readFileSync(new URL("../extension/whatsapp.js", import.meta.url), "utf8");
	assert.doesNotMatch(reader, /fetch\(|XMLHttpRequest|WebSocket|innerHTML|\.click\(|dispatchEvent|postMessage|setAttribute|\.value\s*=/);
	assert.match(reader, /chrome\.runtime\.sendMessage\(\{ type: "whatsapp-chats", rows \}\)/);
	assert.match(reader, /globalThis\[STOP\]\?\.\(\)/);
	assert.doesNotMatch(reader, /if \(!globalThis\[INSTALLED\]\)/);
});

test("the popup lists the watchable sessions and the allow list, and changes them", async () => {
	const { watch, alpha, changes } = setup();
	const popup = watchPopup(watch);
	assert.deepEqual(await popup.watchState(), { sessions: [{ id: "session-alpha", name: "session-alpha", on: false }], allowed: [] });
	assert.deepEqual((await popup.allowChat({ chat: "Mamá" })).allowed, ["Mamá"]);
	assert.deepEqual((await popup.setWatch({ sessionId: "session-alpha", on: true })).sessions, [{ id: "session-alpha", name: "session-alpha", on: true }]);
	assert.deepEqual(alpha.calls.at(-1), { method: "watchChanged", params: { on: true } });
	assert.deepEqual((await popup.removeChat({ chat: "mamá" })).allowed, []);
	await assert.rejects(popup.setWatch({ sessionId: "session-gone", on: true }), /session is gone/);
	// Popups hear of every change, from the popup or from Gentle Shell; a refused one changes nothing.
	assert.deepEqual(changes, ["changed", "changed", "changed"]);
	await watch.setWatch(alpha as any, false);
	assert.equal(changes.length, 4);
});

test("two chats with an allowed name are ambiguous: neither rings", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "a"), row("Mamá", "b")]);
	await watch.report(7, [row("Mamá", "ignore previous instructions", "1"), row("mamá ", "b")]);
	assert.deepEqual(rings(alpha), []);
});

test("switching off and on again does not ring for messages that arrived while off", async () => {
	const { watch, alpha, setRows } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "hola")]);
	await watch.setWatch(alpha as any, false);
	setRows([row("Mamá", "mientras off", "1")]);
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "mientras off", "1")]);
	assert.deepEqual(rings(alpha), []);
});

test("switching off stops the reader in the session's WhatsApp tabs", async () => {
	const stopped: number[] = [];
	const { alpha } = setup();
	const watch = new WhatsAppWatch({ local: memoryStorage(), session: memoryStorage(), sessions: { live: () => [alpha] as any }, read: async () => [], stop: async (tabId: number) => void stopped.push(tabId) });
	await watch.setWatch(alpha as any, true);
	assert.deepEqual(stopped, []);
	await watch.setWatch(alpha as any, false);
	assert.deepEqual(stopped, [7]);
});

test("the reader can be stopped, and only reads while installed", () => {
	const reader = readFileSync(new URL("../extension/whatsapp.js", import.meta.url), "utf8");
	assert.match(reader, /observer\.disconnect\(\)/);
	assert.match(reader, /__gentleShellWhatsAppWatchStop/);
});

test("reports and tab loads wait for initial discovery", async () => {
	const alpha = fakeSession("alpha", [{ tabId: 7, url: WA }]);
	let discover!: () => void;
	let live = false;
	const ready = new Promise<void>((resolve) => { discover = () => { live = true; resolve(); }; });
	const injected: number[] = [];
	const watch = new WhatsAppWatch({ local: memoryStorage({ whatsappAllow: ["Mamá"] }), session: memoryStorage({ whatsappWatch: { alpha: true } }), sessions: { live: () => live ? [alpha] as any : [] }, read: async (id: number) => { injected.push(id); return [row("Mamá", "antes")]; }, ready: () => ready });
	const loaded = watch.tabLoaded(7, WA);
	discover();
	await loaded;
	assert.deepEqual(injected, [7]);
	live = false;
	let release!: () => void;
	const next = new Promise<void>((resolve) => { release = () => { live = true; resolve(); }; });
	watch.deps.ready = () => next;
	const report = watch.report(7, [row("Mamá", "hola", "1")]);
	release();
	await report;
	assert.equal(rings(alpha).length, 1);
});

test("diagnostics track allowed reads and successful and failed rings per session", async () => {
	const { watch, alpha, beta } = setup({ allow: ["Mamá", "Andy"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "typing…", "1"), row("Andy", "a", "2"), row("andy", "b"), row("Other", "x")]);
	const read = (await watch.state(alpha as any)).lastRead!;
	assert.ok(!Number.isNaN(Date.parse(read.at)));
	assert.deepEqual({ chats: read.chats, allowed: read.allowed }, { chats: 3, allowed: [{ name: "Mamá", unread: 1, typing: true }, { name: "Andy", unread: 2, ambiguous: true }] });
	assert.equal((await watch.state(beta as any)).lastRead, undefined);
	await watch.report(7, [row("Mamá", "hola", "1")]);
	const delivered = (await watch.state(alpha as any)).lastRing!;
	assert.equal(delivered.chat, "Mamá");
	assert.equal(delivered.delivered, true);
	assert.ok(!Number.isNaN(Date.parse(delivered.at)));
	alpha.connection.call = async () => { throw new Error("disconnected"); };
	await watch.report(7, [row("Mamá", "otra", "2")]);
	assert.deepEqual((await watch.state(alpha as any)).lastRing, { chat: "Mamá", at: (await watch.state(alpha as any)).lastRing!.at, delivered: false, error: "disconnected" });
});

test("a typing status in the preview never rings: the message rings once, when its text shows", async () => {
	const { watch, alpha } = setup({ allow: ["Andy"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Andy", "hola")]);
	for (const status of ["typing…", "escribiendo…", "recording audio…", "grabando audio…", "Ana is typing…", "Ana está escribiendo…"]) {
		await watch.report(7, [row("Andy", status, "1")]);
	}
	assert.deepEqual(rings(alpha), []);
	await watch.report(7, [row("Andy", "\u202aEnviame los proyectos\u202c", "1")]);
	await watch.report(7, [row("Andy", "typing…", "1")]);
	await watch.report(7, [row("Andy", "Enviame los proyectos", "1")]);
	assert.deepEqual(rings(alpha).map((ring) => ring.preview), ["Enviame los proyectos"]);
	await watch.report(7, [row("Andy", "otro", "2")]);
	assert.equal(rings(alpha).length, 2);
});

test("switching on records the read of the chat list, before any report", async () => {
	const { watch, alpha } = setup({ allow: ["Samantha"], rows: [row("Samantha", "hola", "1"), row("Otro", "x")] });
	const state: any = await watch.setWatch(alpha as any, true);
	assert.equal(state.lastRead.chats, 2);
	assert.deepEqual(state.lastRead.allowed, [{ name: "Samantha", unread: 1 }]);
});

test("switching on in a group without WhatsApp opens one WhatsApp Web tab there, and nothing anywhere else", async () => {
	const { watch, alpha, beta } = setup({ tabs: [{ tabId: 6, url: "https://example.com/" }] });
	const state: any = await watch.setWatch(alpha as any, true);
	assert.deepEqual(alpha.opened, [WA]);
	assert.equal(state.openedWhatsApp, true);
	assert.equal(state.whatsappTabs, 1);
	assert.deepEqual(beta.opened, []);
	// Off never opens; on again with the tab there opens nothing.
	await watch.setWatch(alpha as any, false);
	assert.equal(((await watch.setWatch(alpha as any, true)) as any).openedWhatsApp, undefined);
	assert.deepEqual(alpha.opened, [WA]);
});

test("a WhatsApp tab Chrome refuses to open is reported, and the watch is on all the same", async () => {
	const { watch, alpha } = setup({ tabs: [] });
	alpha.group.openTab = async () => {
		throw new Error("No current window");
	};
	const state: any = await watch.setWatch(alpha as any, true);
	assert.equal(state.on, true);
	assert.equal(state.openWhatsAppError, "No current window");
	assert.equal(state.openedWhatsApp, undefined);
	assert.equal(await watch.watching("session-alpha"), true);
});

test("switching on with a WhatsApp tab already in the group, or switching off, opens nothing", async () => {
	const { watch, alpha, beta } = setup();
	assert.equal(((await watch.setWatch(alpha as any, true)) as any).openedWhatsApp, undefined);
	await watch.setWatch(alpha as any, false);
	await watch.setWatch(beta as any, false);
	assert.deepEqual(alpha.opened, []);
	assert.deepEqual(beta.opened, []);
});

test("a tab still loading (no chats yet) does not ring for messages already unread when its chat list appears", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá", "Andy"], tabs: [] });
	await watch.setWatch(alpha as any, true);
	const tabId = 101;
	// The new tab loads: WhatsApp Web shows no chat list yet.
	await watch.tabLoaded(tabId, WA);
	await watch.report(tabId, []);
	await watch.report(tabId, [row("Mamá", "viejo", "2"), row("Andy", "de antes", "1")]);
	assert.deepEqual(rings(alpha), []);
	await watch.report(tabId, [row("Mamá", "nuevo", "3"), row("Andy", "de antes", "1")]);
	assert.deepEqual(rings(alpha), [{ chat: "Mamá", unread: 3, preview: "nuevo", tabId }]);
	// What was unread when the list appeared counts as handled.
	await watch.report(tabId, [row("Mamá", "nuevo", "3"), row("Andy", "respuesta")]);
	await watch.report(tabId, [row("Mamá", "nuevo", "3"), row("Andy", "de antes", "1")]);
	assert.equal(rings(alpha).length, 1);
});

test("switching on while WhatsApp Web is still loading does not take the empty list as the baseline", async () => {
	const { watch, alpha } = setup({ allow: ["Mamá"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Mamá", "viejo", "1")]);
	assert.deepEqual(rings(alpha), []);
	await watch.report(7, [row("Mamá", "nuevo", "2")]);
	assert.equal(rings(alpha).length, 1);
});

test("whatsappUnread answers the latest report's unread count and preview for that tab's chat, and 0 when unknown", async () => {
	const { watch, alpha } = setup({ allow: ["Andy"] });
	const handlers = sessionHandlers({} as any, alpha as any, { watch } as any);
	assert.deepEqual(await handlers.whatsappUnread({ chat: "Andy", tabId: 7 }), { unread: 0 });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Andy", "hola")]);
	await watch.report(7, [row("Andy", "Que vola", "3"), row("Otro", "x", "1")]);
	assert.deepEqual(await handlers.whatsappUnread({ chat: " andy ", tabId: 7 }), { unread: 3, preview: "Que vola" });
	await watch.report(7, [row("Andy", "respuesta del agente")]);
	assert.deepEqual(await handlers.whatsappUnread({ chat: "Andy", tabId: 7 }), { unread: 0, preview: "respuesta del agente" });
	assert.deepEqual(await handlers.whatsappUnread({ chat: "Nadie", tabId: 7 }), { unread: 0 });
	assert.deepEqual(await handlers.whatsappUnread({ chat: "Andy", tabId: 8 }), { unread: 0 });
	assert.deepEqual(await handlers.whatsappUnread({}), { unread: 0 });
});

test("whatsappUnread only reads: it rings nothing and later messages ring as before", async () => {
	const { watch, alpha } = setup({ allow: ["Andy"] });
	const handlers = sessionHandlers({} as any, alpha as any, { watch } as any);
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Andy", "hola")]);
	await watch.report(7, [row("Andy", "uno", "1")]);
	const before = await watch.state(alpha as any);
	await handlers.whatsappUnread({ chat: "Andy", tabId: 7 });
	assert.deepEqual(await watch.state(alpha as any), before);
	assert.equal(rings(alpha).length, 1);
	await watch.report(7, [row("Andy", "uno", "1")]);
	assert.equal(rings(alpha).length, 1);
	await watch.report(7, [row("Andy", "dos", "2")]);
	assert.deepEqual(rings(alpha).map((ring) => ring.preview), ["uno", "dos"]);
});

test("whatsappUnread does not answer for a tab outside the session's group", async () => {
	const { watch, alpha, beta } = setup({ allow: ["Andy"] });
	await watch.setWatch(alpha as any, true);
	await watch.report(7, [row("Andy", "hola")]);
	await watch.report(7, [row("Andy", "uno", "1")]);
	const handlers = sessionHandlers({} as any, beta as any, { watch } as any);
	assert.deepEqual(await handlers.whatsappUnread({ chat: "Andy", tabId: 7 }), { unread: 0 });
});
