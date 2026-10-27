import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { Peer } from "../extension/lib/rpc.js";
import { BrowserController } from "../src/controller.ts";
import { levelCommand, rulesCommand, USAGE } from "../src/index.ts";
import { listSessions } from "../src/sessions.ts";
import { loadOrCreateToken } from "../src/token.ts";
import { buildId, installExtension } from "../src/update.ts";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** The extension's side of the handshake, with `token`. */
function authenticate(socket: WebSocket, token: string) {
	const clientNonce = randomBytes(32).toString("base64url");
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.kind !== "challenge") return;
		const proof = createHmac("sha256", token).update(`gentle-chrome/client\n${clientNonce}\n${message.serverNonce}\n${message.sessionId}`).digest("base64url");
		socket.send(JSON.stringify({ kind: "auth", proof }));
	});
	socket.send(JSON.stringify({ kind: "hello", version: "0.1.0", clientNonce }));
}

function controller(overrides: Partial<ConstructorParameters<typeof BrowserController>[0]> = {}) {
	const configDir = mkdtempSync(join(tmpdir(), "gentle-chrome-ctl-"));
	const statuses: (string | undefined)[] = [];
	const ctl = new BrowserController({ configDir, port: 0, sessionName: () => "chrome", abort: () => {}, setStatus: (text) => statuses.push(text), ...overrides });
	return { ctl, configDir, statuses };
}

test("there is no pairing code anymore: the native messaging host hands the extension the token", () => {
	const { ctl } = controller();
	assert.equal("pair" in ctl, false);
});

test("status reports listening, then connected with the extension version", async () => {
	const { ctl, configDir, statuses } = controller();
	try {
		await ctl.start();
		assert.deepEqual(ctl.status(), [`Gentle Chrome: session "chrome" (${ctl.sessionId}) listening on 127.0.0.1:${ctl.port()}, Chrome not connected; the browser tools appear when it connects.`]);
		const socket = new WebSocket(`ws://127.0.0.1:${ctl.port()}`, { origin: ORIGIN });
		await new Promise((resolve) => socket.once("open", resolve));
		authenticate(socket, loadOrCreateToken(configDir));
		await waitUntil(() => statuses.includes("Chrome: connected"));
		assert.deepEqual(ctl.status(), [`Gentle Chrome: session "chrome" (${ctl.sessionId}) listening on 127.0.0.1:${ctl.port()}, Chrome connected (extension 0.1.0).`]);
		socket.close();
		await waitUntil(() => statuses.at(-1) === "Chrome: waiting");
	} finally {
		await ctl.stop();
	}
});

test("the browser tools are shown only while Chrome is connected to this session", async () => {
	const active: boolean[] = [];
	const { ctl, configDir, statuses } = controller({ setBrowserToolsActive: (value) => active.push(value) });
	try {
		await ctl.start();
		assert.deepEqual(active, []);
		const token = loadOrCreateToken(configDir);
		for (let i = 0; i < 2; i++) {
			const socket = new WebSocket(`ws://127.0.0.1:${ctl.port()}`, { origin: ORIGIN });
			await new Promise((resolve) => socket.once("open", resolve));
			authenticate(socket, token);
			await waitUntil(() => statuses.at(-1) === "Chrome: connected");
			assert.equal(active.at(-1), true);
			socket.close();
			await waitUntil(() => statuses.at(-1) === "Chrome: waiting");
			assert.equal(active.at(-1), false);
		}
		assert.deepEqual(active, [true, false, true, false]);
	} finally {
		await ctl.stop();
	}
	assert.equal(active.at(-1), false);
});

test("stop hides the browser tools even while Chrome is connected", async () => {
	const active: boolean[] = [];
	const { ctl, configDir, statuses } = controller({ setBrowserToolsActive: (value) => active.push(value) });
	await ctl.start();
	const socket = new WebSocket(`ws://127.0.0.1:${ctl.port()}`, { origin: ORIGIN });
	await new Promise((resolve) => socket.once("open", resolve));
	authenticate(socket, loadOrCreateToken(configDir));
	await waitUntil(() => statuses.at(-1) === "Chrome: connected");
	await ctl.stop();
	assert.equal(active.at(-1), false);
	socket.close();
});

test("start is idempotent and stop releases the port", async () => {
	const { ctl } = controller();
	await ctl.start();
	const port = ctl.port();
	await ctl.start();
	assert.equal(ctl.port(), port);
	await ctl.stop();
	assert.deepEqual(ctl.status(), ["Gentle Chrome: not running. Run /browser start."]);
	await ctl.stop();
});

test("a busy port is reported, not thrown", async () => {
	const first = controller();
	await first.ctl.start();
	try {
		const second = controller({ port: first.ctl.port() });
		const lines = await second.ctl.start();
		assert.deepEqual(lines, [`Gentle Chrome: Port ${first.ctl.port()} is already in use (another Gentle Shell session may own the browser).`]);
		assert.deepEqual(second.ctl.status(), ["Gentle Chrome: not running. Run /browser start."]);
	} finally {
		await first.ctl.stop();
	}
});

test("each controller has its own session id", () => {
	const { ctl } = controller();
	const other = controller();
	assert.match(ctl.sessionId, /^[A-Za-z0-9_-]{22}$/);
	assert.notEqual(ctl.sessionId, other.ctl.sessionId);
});

test("without an explicit port two sessions scan to different ports and each registers itself", async () => {
	const first = controller({ port: undefined });
	const second = new BrowserController({ configDir: first.configDir, sessionName: () => ` ${"n".repeat(70)}`, abort: () => {} });
	const exitListeners = process.listenerCount("exit");
	try {
		await Promise.all([first.ctl.start(), second.start()]);
		const [a, b] = [first.ctl.port() as number, second.port() as number];
		assert.notEqual(a, b);
		for (const port of [a, b]) assert.ok(port >= 48733 && port <= 48832, String(port));
		assert.equal(process.listenerCount("exit"), exitListeners + 2);
		const records = listSessions(first.configDir).map(({ id, name, port, pid }) => ({ id, name, port, pid }));
		assert.deepEqual(
			records.sort((x, y) => x.port - y.port),
			[
				{ id: first.ctl.sessionId, name: "chrome", port: a, pid: process.pid },
				{ id: second.sessionId, name: "n".repeat(60), port: b, pid: process.pid },
			].sort((x, y) => x.port - y.port),
		);
		await first.ctl.stop();
		assert.deepEqual(listSessions(first.configDir).map((record) => record.id), [second.sessionId]);
		assert.equal(process.listenerCount("exit"), exitListeners + 1);
	} finally {
		await first.ctl.stop();
		await second.stop();
	}
	assert.deepEqual(listSessions(first.configDir), []);
	assert.equal(process.listenerCount("exit"), exitListeners);
});

test("the session record holds the normalized name, so the host lists it", async () => {
	for (const [raw, expected] of [["", "session"], ["  my\u0007 shell\n ", "my shell"]]) {
		const { ctl, configDir } = controller({ port: undefined, sessionName: () => raw });
		try {
			await ctl.start();
			assert.deepEqual(listSessions(configDir).map((record) => record.name), [expected], JSON.stringify(raw));
		} finally {
			await ctl.stop();
		}
	}
});

test("a busy explicit port writes no session record", async () => {
	const first = controller();
	await first.ctl.start();
	try {
		const second = controller({ port: first.ctl.port() });
		await second.ctl.start();
		assert.deepEqual(listSessions(second.configDir), []);
	} finally {
		await first.ctl.stop();
	}
});

test("the extension's STOP aborts the agent run", async () => {
	let aborted = 0;
	const { ctl, configDir } = controller({ abort: () => aborted++ });
	try {
		await ctl.start();
		const socket = new WebSocket(`ws://127.0.0.1:${ctl.port()}`, { origin: ORIGIN });
		await new Promise((resolve) => socket.once("open", resolve));
		authenticate(socket, loadOrCreateToken(configDir));
		await waitUntil(() => ctl.status()[0].includes("Chrome connected"));
		socket.send(JSON.stringify({ kind: "req", id: 1, method: "stop", params: {} }));
		await waitUntil(() => aborted === 1);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

/** A small extension folder shaped like extension/. */
function extensionSource(): string {
	const dir = join(mkdtempSync(join(tmpdir(), "gentle-chrome-src-")), "extension");
	mkdirSync(dir);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Gentle Shell Browser", version: "0.1.0" }));
	writeFileSync(join(dir, "background.js"), "// v1\n");
	return dir;
}

/** A Chrome extension over a real socket: says hello with `build` and serves `handlers`. */
async function fakeExtension(port: number, token: string, build: string | undefined, handlers: Record<string, (params: any) => any> = {}) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
	const peer = new Peer((text: string) => socket.send(text));
	for (const [method, handler] of Object.entries(handlers)) peer.handle(method, handler);
	const clientNonce = randomBytes(32).toString("base64url");
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.kind === "challenge") {
			const proof = createHmac("sha256", token).update(`gentle-chrome/client\n${clientNonce}\n${message.serverNonce}\n${message.sessionId}`).digest("base64url");
			socket.send(JSON.stringify({ kind: "auth", proof }));
		} else if (message.kind === "req") peer.receive(data.toString());
	});
	await new Promise((resolve) => socket.once("open", resolve));
	socket.send(JSON.stringify({ kind: "hello", version: "0.1.0", build, clientNonce }));
	return socket;
}

/** A controller whose repo extension is `extensionSource()` and whose recorded target holds a copy of it. */
function updater(options: { record?: boolean } = {}) {
	const extensionDir = extensionSource();
	const notices: string[] = [];
	const parts = controller({ extensionDir, notify: (text: string) => notices.push(text), updateRetryMs: 10 });
	const targetDir = join(mkdtempSync(join(tmpdir(), "gentle-chrome-target-")), "gentle-shell-chrome");
	if (options.record !== false) installExtension({ sourceDir: extensionDir, targetDir, configDir: parts.configDir });
	// The repo moves ahead of the copy Chrome has.
	writeFileSync(join(extensionDir, "background.js"), "// v2\n");
	return { ...parts, extensionDir, targetDir, notices, build: buildId(extensionDir) };
}

const OLD = "0000000000000000";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an outdated extension gets the new files in its folder, then is asked to reload", async () => {
	const { ctl, configDir, targetDir, notices, build } = updater();
	let reloads = 0;
	try {
		await ctl.start();
		const token = loadOrCreateToken(configDir);
		const old = await fakeExtension(ctl.port() as number, token, OLD, { reload: () => ({ reloading: ++reloads > 0 }) });
		await waitUntil(() => reloads === 1);
		assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// v2\n");
		assert.deepEqual(JSON.parse(readFileSync(join(targetDir, "build.json"), "utf8")), { build });
		assert.deepEqual(notices, [`Gentle Chrome: updating the Chrome extension (${OLD} -> ${build})…`]);
		// Chrome reloads the extension, which comes back with the new build.
		old.close();
		const reloaded = await fakeExtension(ctl.port() as number, token, build, { reload: () => ++reloads });
		await waitUntil(() => notices.length === 2);
		assert.equal(notices[1], `Gentle Chrome: the Chrome extension updated itself to ${build}.`);
		await sleep(50);
		assert.equal(reloads, 1);
		reloaded.close();
	} finally {
		await ctl.stop();
	}
});

test("an extension with the current build is left alone", async () => {
	const { ctl, configDir, targetDir, notices, build } = updater();
	let reloads = 0;
	try {
		await ctl.start();
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), build, { reload: () => ++reloads });
		await waitUntil(() => ctl.status()[0].includes("Chrome connected"));
		await sleep(50);
		assert.equal(reloads, 0);
		assert.deepEqual(notices, []);
		assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// v1\n");
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("a busy extension is asked again until it reloads", async () => {
	const { ctl, configDir, notices, build } = updater();
	let reloads = 0;
	try {
		await ctl.start();
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), OLD, {
			reload: () => {
				if (++reloads < 3) throw new Error("Busy: an action is running");
				return { reloading: true };
			},
		});
		await waitUntil(() => reloads === 3);
		await sleep(50);
		assert.equal(reloads, 3);
		assert.deepEqual(notices, [`Gentle Chrome: updating the Chrome extension (${OLD} -> ${build})…`]);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("an extension that stays busy is asked 10 times, then the update gives up", async () => {
	const { ctl, configDir, notices, build } = updater();
	let reloads = 0;
	try {
		await ctl.start();
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), OLD, {
			reload: () => {
				reloads++;
				throw new Error("Busy: an action is running");
			},
		});
		await waitUntil(() => notices.length === 2);
		assert.equal(reloads, 10);
		assert.deepEqual(notices, [
			`Gentle Chrome: updating the Chrome extension (${OLD} -> ${build})…`,
			"Gentle Chrome: could not update the Chrome extension: an action kept running; run /browser update when it is idle.",
		]);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("an extension without reload gets the files and one request to reload it by hand", async () => {
	const { ctl, configDir, targetDir, notices, build } = updater();
	try {
		await ctl.start();
		const token = loadOrCreateToken(configDir);
		const first = await fakeExtension(ctl.port() as number, token, undefined);
		await waitUntil(() => notices.length === 2);
		assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// v2\n");
		assert.deepEqual(notices, [
			`Gentle Chrome: updating the Chrome extension (unknown -> ${build})…`,
			"Gentle Chrome: copied the new extension; reload it once in chrome://extensions (Gentle Shell Browser card) — after that it updates itself.",
		]);
		// The same old extension reconnecting is not told again.
		first.close();
		const second = await fakeExtension(ctl.port() as number, token, undefined);
		await waitUntil(() => ctl.status()[0].includes("Chrome connected"));
		await sleep(50);
		assert.equal(notices.length, 2);
		second.close();
	} finally {
		await ctl.stop();
	}
});

test("a copy that fails is reported and Chrome is not asked to reload", async () => {
	const { ctl, configDir, targetDir, notices } = updater();
	let reloads = 0;
	try {
		// The recorded folder now belongs to something else.
		writeFileSync(join(targetDir, "manifest.json"), JSON.stringify({ name: "Other" }));
		await ctl.start();
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), OLD, { reload: () => ++reloads });
		await waitUntil(() => notices.length === 2);
		assert.equal(notices[1], `Gentle Chrome: could not update the Chrome extension: ${targetDir} is not empty and is not a previous copy of Gentle Shell Browser. Choose an empty or new folder.`);
		assert.equal(reloads, 0);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("without a recorded folder an outdated extension is reported once per session", async () => {
	const { ctl, configDir, notices } = updater({ record: false });
	let reloads = 0;
	try {
		await ctl.start();
		const token = loadOrCreateToken(configDir);
		for (let i = 0; i < 2; i++) {
			const socket = await fakeExtension(ctl.port() as number, token, OLD, { reload: () => ++reloads });
			await waitUntil(() => ctl.status()[0].includes("Chrome connected"));
			await sleep(30);
			socket.close();
			await waitUntil(() => !ctl.status()[0].includes("Chrome connected"));
		}
		assert.equal(reloads, 0);
		assert.deepEqual(notices, ["Gentle Chrome: the Chrome extension is outdated; run scripts/install-extension.sh once to enable automatic updates."]);
	} finally {
		await ctl.stop();
	}
});

test("/browser update copies now and reports what Chrome runs", async () => {
	const { ctl, configDir, targetDir, build } = updater();
	try {
		assert.deepEqual(await ctl.update(), ["Gentle Chrome: not running. Run /browser start."]);
		await ctl.start();
		// Not connected: the files are copied; Chrome picks them up when it connects.
		assert.deepEqual(await ctl.update(), [`Gentle Chrome: copied build ${build} to ${targetDir}; Chrome is not connected, so it updates when it connects.`]);
		assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// v2\n");
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), build, { reload: () => ({ reloading: true }) });
		await waitUntil(() => ctl.status()[0].includes("Chrome connected"));
		assert.deepEqual(await ctl.update(), [`Gentle Chrome: the Chrome extension is up to date (${build}).`]);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("/browser update asks an outdated extension to reload once it is idle", async () => {
	const { ctl, configDir, notices, build, targetDir } = updater();
	let busy = true;
	let reloads = 0;
	try {
		await ctl.start();
		const socket = await fakeExtension(ctl.port() as number, loadOrCreateToken(configDir), OLD, {
			reload: () => {
				reloads++;
				if (busy) throw new Error("Busy: an action is running");
				return { reloading: true };
			},
		});
		await waitUntil(() => notices.length === 2);
		busy = false;
		assert.deepEqual(await ctl.update(), [`Gentle Chrome: copied build ${build} to ${targetDir}; Chrome is reloading the extension.`]);
		assert.equal(reloads, 11);
		assert.equal(notices.at(-1), `Gentle Chrome: updating the Chrome extension (${OLD} -> ${build})…`);
		socket.close();
	} finally {
		await ctl.stop();
	}
});

test("/browser update without a recorded folder says how to record one", async () => {
	const { ctl } = updater({ record: false });
	try {
		await ctl.start();
		assert.deepEqual(await ctl.update(), ["Gentle Chrome: no extension folder recorded; run scripts/install-extension.sh once to enable automatic updates."]);
	} finally {
		await ctl.stop();
	}
});

// S14: only the user changes the mode or the saved decisions, through /browser.

/** A running controller stand-in that records what the commands ask the extension. */
function commandSetup(options: { running?: boolean; confirm?: boolean; hasUI?: boolean; rules?: unknown; level?: string } = {}) {
	const calls: { method: string; params: unknown }[] = [];
	const confirms: { title: string; message: string }[] = [];
	const fake = {
		port: () => (options.running === false ? undefined : 48733),
		status: () => ["Gentle Chrome: not running. Run /browser start."],
		async call(method: string, params: unknown) {
			calls.push({ method, params });
			if (method === "getLevel") return { level: options.level ?? "always" };
			if (method === "setLevel") return { level: (params as { level: string }).level };
			if (method === "getRules") return { rules: options.rules ?? {} };
			if (method === "clearRules") return { rules: {} };
			throw new Error(`unexpected ${method}`);
		},
	};
	const context = {
		hasUI: options.hasUI ?? true,
		ui: {
			async confirm(title: string, message: string) {
				confirms.push({ title, message });
				return options.confirm ?? true;
			},
		},
	};
	return { fake, context, calls, confirms };
}

const NEVER_CONFIRM = {
	title: "Switch Gentle Chrome to Never ask?",
	message: "Nothing will ask for your approval anymore: the agent does whatever it is told, payments and deletions included. Only the session's tab group and STOP limit it.",
};

test("/browser level shows the permission mode", async () => {
	const expected: Record<string, string> = {
		always: "Gentle Chrome: permission mode is Always ask — asks before every step.",
		remember: "Gentle Chrome: permission mode is Remember my decisions — asks, and you can save allow or deny per site and action type.",
		never: "Gentle Chrome: permission mode is Never ask — does whatever you tell it; only the session group and STOP limit it.",
	};
	for (const [level, line] of Object.entries(expected)) {
		const { fake, context, calls } = commandSetup({ level });
		assert.deepEqual(await levelCommand(fake, undefined, context), [line], level);
		assert.deepEqual(calls, [{ method: "getLevel", params: {} }]);
	}
});

test("/browser level always and remember set the mode at once, without confirming", async () => {
	for (const level of ["always", "remember"]) {
		const { fake, context, calls, confirms } = commandSetup();
		const lines = await levelCommand(fake, level, context);
		assert.deepEqual(calls, [{ method: "setLevel", params: { level } }]);
		assert.deepEqual(confirms, []);
		assert.match(lines[0], new RegExp(`^Gentle Chrome: permission mode set to ${level === "always" ? "Always ask" : "Remember my decisions"} — `));
	}
});

test("/browser level never asks the user to confirm and only then sets it; declined or no UI changes nothing", async () => {
	const confirmed = commandSetup({ confirm: true });
	assert.deepEqual(await levelCommand(confirmed.fake, "never", confirmed.context), ["Gentle Chrome: permission mode set to Never ask — does whatever you tell it; only the session group and STOP limit it."]);
	assert.deepEqual(confirmed.confirms, [NEVER_CONFIRM]);
	assert.deepEqual(confirmed.calls, [{ method: "setLevel", params: { level: "never" } }]);
	for (const options of [{ confirm: false }, { hasUI: false }]) {
		const { fake, context, calls } = commandSetup(options);
		assert.deepEqual(await levelCommand(fake, "never", context), ["Gentle Chrome: mode unchanged."], JSON.stringify(options));
		assert.deepEqual(calls, [], JSON.stringify(options));
	}
});

test("/browser level with an unknown or old name shows the usage; without a bridge it shows the status", async () => {
	for (const name of ["supervised", "autonomous", "bogus"]) {
		const { fake, context, calls } = commandSetup();
		assert.deepEqual(await levelCommand(fake, name, context), [USAGE], name);
		assert.deepEqual(calls, []);
	}
	assert.equal(USAGE, "Usage: /browser [status | start | stop | update | level [always | remember | never] | rules [clear [site]]]");
	const stopped = commandSetup({ running: false });
	assert.deepEqual(await levelCommand(stopped.fake, "never", stopped.context), ["Gentle Chrome: not running. Run /browser start."]);
	assert.deepEqual(await rulesCommand(stopped.fake, [], stopped.context), ["Gentle Chrome: not running. Run /browser start."]);
	assert.deepEqual(stopped.calls, []);
	assert.deepEqual(stopped.confirms, []);
});

test("/browser rules lists the saved decisions by site", async () => {
	const rules = { "mercadopago.com": { money: "deny", click: "allow" }, "google.com": { type: "allow" } };
	const { fake, context, calls } = commandSetup({ rules });
	assert.deepEqual(await rulesCommand(fake, [], context), ["Gentle Chrome: saved decisions:", "google.com — type: allow", "mercadopago.com — click: allow", "mercadopago.com — money: deny"]);
	assert.deepEqual(calls, [{ method: "getRules", params: {} }]);
	const empty = commandSetup();
	assert.deepEqual(await rulesCommand(empty.fake, [], empty.context), ["Gentle Chrome: no saved decisions."]);
});

test("/browser rules clear asks to confirm, then clears all; /browser rules clear <site> clears one site", async () => {
	const confirmed = commandSetup();
	assert.deepEqual(await rulesCommand(confirmed.fake, ["clear"], confirmed.context), ["Gentle Chrome: cleared every saved decision."]);
	assert.deepEqual(confirmed.confirms, [{ title: "Clear every saved decision?", message: "Remember mode will ask again for every site and action type." }]);
	assert.deepEqual(confirmed.calls, [{ method: "clearRules", params: {} }]);
	for (const options of [{ confirm: false }, { hasUI: false }]) {
		const { fake, context, calls } = commandSetup(options);
		assert.deepEqual(await rulesCommand(fake, ["clear"], context), ["Gentle Chrome: saved decisions unchanged."]);
		assert.deepEqual(calls, []);
	}
	const one = commandSetup();
	assert.deepEqual(await rulesCommand(one.fake, ["clear", "mercadopago.com"], one.context), ["Gentle Chrome: cleared the saved decisions for mercadopago.com."]);
	assert.deepEqual(one.calls, [{ method: "clearRules", params: { site: "mercadopago.com" } }]);
	assert.deepEqual(one.confirms, []);
	for (const args of [["bogus"], ["clear", "a.test", "b.test"]]) {
		const bad = commandSetup();
		assert.deepEqual(await rulesCommand(bad.fake, args, bad.context), [USAGE], args.join(" "));
		assert.deepEqual(bad.calls, []);
	}
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
