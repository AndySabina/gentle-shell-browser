import assert from "node:assert/strict";
import { test } from "node:test";
import { Actions, elementFactsExpression, focusedValueExpression, hitTestExpression } from "../extension/lib/actions.js";
import { Debugger } from "../extension/lib/cdp.js";
import { pageInfoExpression, pageRiskExpression, resolveRefExpression } from "../extension/lib/page.js";
import { DEFAULT_RISKY_DOMAINS } from "../extension/lib/policy.js";

const STOPPED = "Stopped by the user in Chrome.";
const TAB = 5;

interface Target {
	x: number;
	y: number;
	left: number;
	top: number;
	width: number;
	height: number;
	name: string;
}

/** Fake debugger and overlay that record every step into one ordered log. */
interface SetupOptions {
	move?: (tabId: number) => Promise<unknown>;
	onSend?: (method: string, params: any) => void;
	level?: string;
	approve?: (request: any) => Promise<unknown> | unknown;
	facts?: Record<string, unknown>;
	newTabs?: { tabId: number; url: string; added: boolean }[];
	inGroup?: (tabId: number) => boolean | Promise<boolean>;
	/** Answers of the hit test before each press, in order; true when missing. */
	hits?: boolean[];
	unguarded?: { url: string };
	/** What the page risk probe reports, or a function of the page URL; a harmless page when missing. */
	signals?: unknown;
	/** Saved decisions; saving one updates this object. */
	rules?: Record<string, Record<string, string>>;
	/** Answers of the focused field probe, in order; null (unreadable) when missing; an Error makes the probe throw. */
	values?: unknown[];
}

const harmlessPage = { fields: [], submits: ["Next"], frames: [], headings: ["Results"] };
const harmless = { tag: "button", name: "Save", autocomplete: "", fieldName: "", id: "", role: "", editable: false, isSubmit: false, formFields: [] };

function setup(options: SetupOptions = {}) {
	const log: string[] = [];
	const sent: { tabId: number; method: string; params: any }[] = [];
	const moves: { tabId: number; x: number | null; y: number | null; label: string; rect: unknown }[] = [];
	const page = { url: "https://example.com/", title: "Example", width: 1000, height: 800, scrollX: 0, scrollY: 0 };
	const refs = new Map<string, Target | null>([
		["e1", { x: 120, y: 340, left: 100, top: 330, width: 40, height: 20, name: "Save" }],
		["e2", { x: 300, y: 150, left: 200, top: 140, width: 200, height: 20, name: "Email" }],
		["e99", null],
	]);
	const probes: string[] = [];
	const cdp = {
		async send(tabId: number, method: string, params: any = {}) {
			log.push(params.type ? `${method} ${params.type}` : method);
			sent.push({ tabId, method, params });
			options.onSend?.(method, params);
			if (method === "Page.navigate") page.url = params.url;
			return {};
		},
		async evaluate(_tabId: number, expression: string) {
			if (expression === pageInfoExpression()) {
				log.push("info");
				return { ...page };
			}
			// Not logged: the exact step order of the other tests stays as it was.
			if (expression === focusedValueExpression()) {
				const found = options.values?.shift() ?? null;
				if (found instanceof Error) throw found;
				return found;
			}
			if (expression === pageRiskExpression()) {
				probes.push(page.url);
				const found = "signals" in options ? options.signals : harmlessPage;
				return typeof found === "function" ? found(page.url) : found;
			}
			for (const [ref, target] of refs) {
				if (expression === resolveRefExpression(ref)) {
					log.push(`resolve ${ref}`);
					return target;
				}
			}
			const args = /\)\((\{.*\})\)$/.exec(expression)?.[1];
			if (args && expression === elementFactsExpression(JSON.parse(args))) {
				log.push(`facts ${args}`);
				return { ...harmless, ...options.facts };
			}
			if (args && expression === hitTestExpression(JSON.parse(args))) {
				log.push(`hit ${args}`);
				return options.hits?.shift() ?? true;
			}
			throw new Error(`unexpected expression: ${expression.slice(0, 40)}`);
		},
		waitForEvent(_tabId: number, methods: string[], timeoutMs: number) {
			log.push(`wait ${methods.join(",")} ${timeoutMs}`);
			return Promise.resolve({ method: methods[0], params: {} });
		},
		tabs: () => [TAB],
		async detachAll() {
			log.push("detachAll");
		},
	};
	const overlay = {
		move(tabId: number, x: number | null, y: number | null, label: string, rect?: unknown) {
			log.push(`move ${x},${y} ${label}`);
			moves.push({ tabId, x, y, label, rect });
			return options.move ? options.move(tabId) : Promise.resolve(true);
		},
		async clear(tabId: number) {
			log.push(`clear ${tabId}`);
		},
	};
	const sleep = async (ms: number) => {
		log.push(`sleep ${ms}`);
	};
	const requests: any[] = [];
	const approve = async (request: any) => {
		log.push(`approve ${request.kind}`);
		requests.push(request);
		return options.approve ? options.approve(request) : true;
	};
	const guarded: string[] = [];
	const guard = {
		async begin(tabId: number, opts: { allowedUrl?: string } = {}) {
			guarded.push(`begin ${tabId}${opts.allowedUrl ? ` ${opts.allowedUrl}` : ""}`);
			log.push("guard on");
		},
		end(tabId: number) {
			guarded.push(`end ${tabId}`);
			log.push("guard off");
		},
		async drain(tabId: number) {
			guarded.push(`drain ${tabId}`);
			return options.newTabs?.splice(0) ?? [];
		},
		async stop() {
			log.push("guard stop");
		},
		unguarded() {
			const found = options.unguarded;
			options.unguarded = undefined;
			return found;
		},
	};
	const rules = options.rules ?? {};
	const saved: string[][] = [];
	const settings = async () => ({ level: options.level ?? "always", riskyDomains: DEFAULT_RISKY_DOMAINS, rules: structuredClone(rules) });
	const saveRule = async (site: string, category: string, decision: string) => {
		saved.push([site, category, decision]);
		rules[site] = { ...rules[site], [category]: decision };
	};
	const inGroup = async (tabId: number) => (options.inGroup ? options.inGroup(tabId) : true);
	const actions = new Actions({ cdp, overlay, sleep, settings, approve, guard, inGroup, saveRule });
	const input = () => sent.filter((entry) => entry.method.startsWith("Input."));
	return { actions, log, sent, moves, page, input, requests, guarded, probes, saved, rules };
}

const mouse = (x: number, y: number) => [
	{ type: "mouseMoved", x, y, button: "none" },
	{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
	{ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
];

test("click by ref resolves the ref, glides the cursor, then dispatches the three mouse events", async () => {
	const { actions, log, moves, input } = setup({ level: "never" });
	const result = await actions.click({ tabId: TAB, ref: "e1" });
	assert.deepEqual(log, [
		"info",
		"resolve e1",
		'facts {"ref":"e1"}',
		'move 120,340 Click · "Save"',
		"guard on",
		'hit {"ref":"e1","x":120,"y":340}',
		"Input.dispatchMouseEvent mouseMoved",
		"Input.dispatchMouseEvent mousePressed",
		"Input.dispatchMouseEvent mouseReleased",
		"sleep 600",
		"info",
		"guard off",
	]);
	assert.deepEqual(moves[0].rect, { left: 100, top: 330, width: 40, height: 20 });
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
	assert.ok(input().every((entry) => entry.tabId === TAB));
	assert.deepEqual(result, { url: "https://example.com/", title: "Example", urlChanged: false });
});

test("click by a stale or unknown ref throws the exact message and sends no input", async () => {
	const { actions, input, moves } = setup();
	await assert.rejects(actions.click({ tabId: TAB, ref: "e99" }), { message: "Element reference e99 is stale or unknown. Take a new browser_snapshot." });
	assert.deepEqual(input(), []);
	assert.deepEqual(moves, []);
});

test("click by coordinates glides there and clicks without a highlight", async () => {
	const { actions, log, moves, input } = setup();
	await actions.click({ tabId: TAB, x: 10, y: 20 });
	assert.equal(log[1], 'facts {"x":10,"y":20}');
	assert.equal(log[2], "move 10,20 Click · (10, 20)");
	assert.equal(moves[0].rect, undefined);
	assert.deepEqual(input().map((entry) => entry.params), mouse(10, 20));
});

test("click needs exactly one of ref or x,y", async () => {
	const { actions, input } = setup();
	const message = "Pass either ref (from browser_snapshot) or both x and y.";
	await assert.rejects(actions.click({ tabId: TAB }), { message });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1", x: 1, y: 2 }), { message });
	await assert.rejects(actions.click({ tabId: TAB, x: 1 }), { message });
	assert.deepEqual(input(), []);
});

test("a click that changes the URL is reported and the cursor label says so", async () => {
	const { actions, moves, page } = setup({
		onSend: (_method, params) => {
			if (params.type === "mouseReleased") page.url = "https://example.com/settings";
		},
	});
	const result = await actions.click({ tabId: TAB, ref: "e1" });
	// The new page's address looks risky, so the result says so (S11).
	assert.deepEqual(result, { url: "https://example.com/settings", title: "Example", urlChanged: true, risk: { risky: true, reason: 'the page path has "/settings"' } });
	assert.deepEqual({ x: moves.at(-1)!.x, y: moves.at(-1)!.y, label: moves.at(-1)!.label }, { x: null, y: null, label: "URL changed → example.com/settings" });
});

test("type with clear and submit clicks the field, then select-all, insertText and Enter in order", async () => {
	const { actions, log, input } = setup();
	const result = await actions.type({ tabId: TAB, ref: "e2", text: "hello", clear: true, submit: true });
	assert.equal(log[2], 'facts {"ref":"e2"}');
	assert.equal(log[3], 'move 300,150 Type · "Email"');
	assert.deepEqual(input().map((entry) => [entry.method, entry.params]), [
		...mouse(300, 150).map((params) => ["Input.dispatchMouseEvent", params]),
		["Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] }],
		["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }],
		["Input.insertText", { text: "hello" }],
		["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" }],
		["Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 }],
	]);
	assert.deepEqual(result, { url: "https://example.com/", title: "Example", urlChanged: false, unverified: "the focused element is not a text field the page can read" });
});

test("typing that leaves the focused field's value unchanged fails with the exact message and does not press Enter", async () => {
	const { actions, input } = setup({ values: [{ value: "old" }, { value: "old" }] });
	await assert.rejects(actions.type({ tabId: TAB, ref: "e2", text: "hello", submit: true }), {
		message: 'The text did not reach "Save": the field\'s value did not change. Take a new browser_snapshot and pass the field\'s ref.',
	});
	assert.deepEqual(input().map((entry) => entry.method).filter((method) => method !== "Input.dispatchMouseEvent"), ["Input.insertText"]);
});

test("typing with no field focused fails with the exact message", async () => {
	const { actions } = setup({ values: [{ none: true }, { none: true }] });
	await assert.rejects(actions.type({ tabId: TAB, text: "hello" }), {
		message: "No field has the focus, so nothing was typed. Pass the field's ref from a new browser_snapshot.",
	});
});

test("typing that changes the field's value reports it as verified", async () => {
	const { actions } = setup({ values: [{ value: "" }, { value: "hello" }] });
	assert.deepEqual(await actions.type({ tabId: TAB, ref: "e2", text: "hello" }), { url: "https://example.com/", title: "Example", urlChanged: false, verified: true });
});

test("typing into a field that cannot be read goes ahead and says why it could not be verified", async () => {
	const NOT_TEXT = "the focused element is not a text field the page can read";
	const cases: [unknown[], string][] = [
		[[null, null], NOT_TEXT],
		[[{ value: "x" }, null], NOT_TEXT],
		[[new Error("Right-hand side of 'instanceof' is not an object"), new Error("Right-hand side of 'instanceof' is not an object")], "the page check failed: Right-hand side of 'instanceof' is not an object"],
	];
	for (const [values, reason] of cases) {
		const { actions } = setup({ values });
		assert.deepEqual(await actions.type({ tabId: TAB, ref: "e2", text: "hello" }), { url: "https://example.com/", title: "Example", urlChanged: false, unverified: reason }, reason);
	}
});

test("clearing a field with empty text is not checked", async () => {
	const { actions } = setup({ values: [{ value: "" }, { value: "" }] });
	assert.deepEqual(await actions.type({ tabId: TAB, ref: "e2", text: "", clear: true }), { url: "https://example.com/", title: "Example", urlChanged: false });
});

test("key presses the mapped key with a label", async () => {
	const { actions, log, input } = setup();
	await actions.key({ tabId: TAB, key: "Shift+Tab" });
	assert.equal(log[1], "facts {}");
	assert.equal(log[2], "move null,null Key · Shift+Tab");
	assert.deepEqual(input().map((entry) => entry.params), [
		{ type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
		{ type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
	]);
	await assert.rejects(actions.key({ tabId: TAB, key: "Hyper+x" }), { message: "Unknown key: Hyper+x" });
});

test("scroll dispatches mouseWheel with the deltas at the viewport center by default", async () => {
	const { actions, log, input } = setup();
	await actions.scroll({ tabId: TAB, deltaY: 400 });
	assert.equal(log[1], "move 500,400 Scroll ↓");
	assert.deepEqual(input().map((entry) => entry.params), [{ type: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 400 }]);
	await actions.scroll({ tabId: TAB, ref: "e1", deltaX: -50, deltaY: 0 });
	assert.deepEqual(input().at(-1)!.params, { type: "mouseWheel", x: 120, y: 340, deltaX: -50, deltaY: 0 });
	await assert.rejects(actions.scroll({ tabId: TAB, deltaY: 0 }), { message: "Pass a non-zero deltaX or deltaY." });
});

test("navigate rejects non-http(s) URLs with the exact message and sends nothing", async () => {
	const { actions, sent, moves } = setup();
	await assert.rejects(actions.navigate({ tabId: TAB, url: "javascript:alert(1)" }), { message: "Only http and https URLs can be opened, got: javascript:" });
	await assert.rejects(actions.navigate({ tabId: TAB, url: "file:///etc/passwd" }), { message: "Only http and https URLs can be opened, got: file:" });
	await assert.rejects(actions.navigate({ tabId: TAB }), { message: 'Pass either url or action ("back", "forward" or "reload").' });
	assert.deepEqual(sent, []);
	assert.deepEqual(moves, []);
});

test("navigate labels the cursor, waits for the load and reports the page", async () => {
	const { actions, log } = setup();
	const result = await actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	assert.deepEqual(log, [
		"move null,null Navigate · example.org",
		"move null,null Waiting for your approval in Gentle Shell…",
		"approve navigate",
		"move null,null Navigate · example.org",
		"guard on",
		"Page.enable",
		"wait Page.loadEventFired,Page.navigatedWithinDocument 15000",
		"Page.navigate",
		"info",
		"guard off",
	]);
	assert.deepEqual(result, { url: "https://example.org/docs", title: "Example" });
});

test("stop rejects the in-flight action before any input, cleans up, and the next action works", async () => {
	let release: (value: unknown) => void = () => {};
	let gated = true;
	const { actions, log, input } = setup({ move: () => (gated ? new Promise((resolve) => (release = resolve)) : Promise.resolve(true)) });
	const inFlight = actions.click({ tabId: TAB, ref: "e1" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(log.at(-1), 'move 120,340 Click · "Save"');
	await actions.stop();
	await assert.rejects(inFlight, { message: STOPPED });
	release(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(input(), []);
	assert.deepEqual(log.slice(-2), [`clear ${TAB}`, "detachAll"]);

	gated = false;
	await actions.click({ tabId: TAB, x: 1, y: 2 });
	assert.deepEqual(input().map((entry) => entry.params), mouse(1, 2));
});

const NOT_APPROVED = { message: /^The user did not approve: / };
const PAY = { tag: "button", name: "Pay now" };

test("a risky click asks before any mouse input and a denial throws with no input dispatched", async () => {
	for (const level of ["always", "remember"]) {
		const { actions, log, input, requests } = setup({ level, facts: PAY, approve: () => false });
		await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), NOT_APPROVED);
		assert.deepEqual(input(), [], level);
		assert.deepEqual(log.slice(-3), ['move 120,340 Click · "Save"', "move 120,340 Waiting for your approval in Gentle Shell…", "approve action"], level);
		assert.equal(requests.length, 1);
		assert.deepEqual({ kind: requests[0].kind, url: requests[0].url, level: requests[0].level }, { kind: "action", url: "https://example.com/", level });
		assert.match(requests[0].title, /Pay now/);
		assert.match(requests[0].reason, /Pay now/);
	}
});

test("an approved risky click goes ahead inside a navigation guard window", async () => {
	const { actions, input, requests, guarded } = setup({ facts: PAY });
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.equal(requests.length, 1);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
	assert.deepEqual(guarded, [`begin ${TAB}`, `drain ${TAB}`, `end ${TAB}`]);
});

test("always mode asks before every plain click, typing, key, scroll and navigation; never mode asks for none", async () => {
	const { actions, requests, input } = setup({ approve: () => false });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), { message: 'The user did not approve: click "Save" on example.com. Do not retry this step unless the user asks.' });
	await assert.rejects(actions.type({ tabId: TAB, ref: "e2", text: "hello" }), NOT_APPROVED);
	await assert.rejects(actions.key({ tabId: TAB, key: "Tab" }), NOT_APPROVED);
	await assert.rejects(actions.scroll({ tabId: TAB, deltaY: 100 }), NOT_APPROVED);
	await assert.rejects(actions.navigate({ tabId: TAB, url: "https://example.org/docs" }), NOT_APPROVED);
	assert.deepEqual(requests.map((request) => [request.kind, request.level, request.reason, "remember" in request]), [
		["action", "always", "Always ask mode asks before every step", false],
		["action", "always", "Always ask mode asks before every step", false],
		["action", "always", "Always ask mode asks before every step", false],
		["action", "always", "Always ask mode asks before every step", false],
		["navigate", "always", "Always ask mode asks before every step", false],
	]);
	assert.deepEqual(input(), []);

	const never = setup({ level: "never", approve: () => false });
	await never.actions.click({ tabId: TAB, ref: "e1" });
	await never.actions.type({ tabId: TAB, ref: "e2", text: "hello" });
	await never.actions.key({ tabId: TAB, key: "Tab" });
	await never.actions.scroll({ tabId: TAB, deltaY: 100 });
	await never.actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	assert.deepEqual(never.requests, []);
});

test("typing into a password field asks and the request never contains the text", async () => {
	const { actions, requests, input } = setup({ facts: { tag: "input", type: "password", name: "Password" }, approve: () => false });
	await assert.rejects(actions.type({ tabId: TAB, ref: "e2", text: "hunter2" }), NOT_APPROVED);
	assert.equal(requests.length, 1);
	assert.equal(JSON.stringify(requests).includes("hunter2"), false);
	assert.deepEqual(input(), []);
});

test("any action on a risky page asks, scroll included", async () => {
	const { actions, page, requests, input } = setup({ level: "remember", approve: () => false });
	page.url = "https://mail.google.com/mail/u/0/";
	await assert.rejects(actions.scroll({ tabId: TAB, deltaY: 100 }), NOT_APPROVED);
	assert.match(requests[0].reason, /mail\.google\.com/);
	assert.deepEqual(input(), []);
});

test("always mode navigate asks first and a denial sends no navigation", async () => {
	const { actions, sent, requests } = setup({ approve: () => false });
	await assert.rejects(actions.navigate({ tabId: TAB, url: "https://example.org/docs" }), NOT_APPROVED);
	assert.deepEqual({ kind: requests[0].kind, url: requests[0].url }, { kind: "navigate", url: "https://example.org/docs" });
	assert.deepEqual(sent, []);
	const back = setup({ approve: () => false });
	back.actions.cdp.send = async (_tabId: number, method: string) => (method === "Page.getNavigationHistory" ? { currentIndex: 1, entries: [{ id: 7, url: "https://example.com/prev" }, { id: 8, url: "https://example.com/" }] } : {});
	await assert.rejects(back.actions.navigate({ tabId: TAB, action: "back" }), NOT_APPROVED);
	assert.equal(back.requests[0].url, "https://example.com/prev");
});

test("never mode navigate does not ask; remember asks for a site without a saved decision", async () => {
	const { actions, requests, guarded } = setup({ level: "never" });
	await actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	await actions.navigate({ tabId: TAB, url: "https://www.paypal.com/signin" });
	assert.equal(requests.length, 0);
	assert.deepEqual(guarded.slice(0, 3), [`begin ${TAB} https://example.org/docs`, `drain ${TAB}`, `end ${TAB}`]);
	const remember = setup({ level: "remember", rules: { "example.org": { navigate: "allow" } } });
	await remember.actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	assert.equal(remember.requests.length, 0);
	await remember.actions.navigate({ tabId: TAB, url: "https://www.paypal.com/signin" });
	assert.equal(remember.requests.length, 1);
	assert.match(remember.requests[0].reason, /paypal\.com/);
	assert.deepEqual(remember.requests[0].remember, { site: "paypal.com", category: "navigate" });
});

test("open asks before creating the tab, then loads the URL in it", async () => {
	const denied = setup({ approve: () => false });
	let created = 0;
	const createTab = async () => {
		created++;
		return { tabId: TAB, groupId: 3 };
	};
	await assert.rejects(denied.actions.open("https://example.org/", createTab), NOT_APPROVED);
	assert.equal(created, 0);
	assert.equal(denied.requests[0].kind, "open");

	const { actions, sent } = setup();
	assert.deepEqual(await actions.open("https://example.org/", createTab), { tabId: TAB, groupId: 3 });
	assert.equal(created, 1);
	assert.deepEqual(sent.find((entry) => entry.method === "Page.navigate")?.params, { url: "https://example.org/" });
});

test("STOP while waiting for approval rejects and sends no input", async () => {
	let answer: (value: boolean) => void = () => {};
	const { actions, input, log } = setup({ facts: PAY, approve: () => new Promise((resolve) => (answer = resolve)) });
	const inFlight = actions.click({ tabId: TAB, ref: "e1" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(log.at(-1), "approve action");
	await actions.stop();
	await assert.rejects(inFlight, { message: STOPPED });
	answer(true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(input(), []);
	assert.deepEqual(log.slice(-3), ["guard stop", `clear ${TAB}`, "detachAll"]);
});

test("an action that opened tabs reports them in newTabs", async () => {
	const newTabs = [
		{ tabId: 200, url: "https://example.com/new", added: true },
		{ tabId: 201, url: "https://www.paypal.com/checkout", added: false },
	];
	const { actions } = setup({ newTabs: [...newTabs] });
	const result = await actions.click({ tabId: TAB, ref: "e1" });
	assert.deepEqual(result, { url: "https://example.com/", title: "Example", urlChanged: false, newTabs });
});

test("navigate reports tabs its load opened; without any there is no newTabs field", async () => {
	const opened = [{ tabId: 200, url: "https://example.com/new", added: true }];
	const { actions } = setup({ newTabs: [...opened] });
	const result = await actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	assert.deepEqual(result, { url: "https://example.org/docs", title: "Example", newTabs: opened });
	const plain = await setup().actions.navigate({ tabId: TAB, url: "https://example.org/docs" });
	assert.deepEqual(plain, { url: "https://example.org/docs", title: "Example" });
});

// B3: the group is checked again right before every input.

const LEFT = { message: `Tab ${TAB} left the Gentle Shell group; the action was cancelled.` };

test("a tab that leaves the group during the approval wait gets no input and the exact error", async () => {
	let answer: (value: boolean) => void = () => {};
	let member = true;
	const { actions, input, log, guarded } = setup({ facts: PAY, approve: () => new Promise((resolve) => (answer = resolve)), inGroup: () => member });
	const inFlight = actions.click({ tabId: TAB, ref: "e1" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(log.at(-1), "approve action");
	member = false;
	answer(true);
	await assert.rejects(inFlight, LEFT);
	assert.deepEqual(input(), []);
	// Not even the navigation guard touches the tab: it would attach the debugger again.
	assert.deepEqual(guarded, []);
});

test("a tab that leaves the group during the glide gets no input from any action", async () => {
	const runs: [string, (actions: any) => Promise<unknown>][] = [
		["click", (actions) => actions.click({ tabId: TAB, ref: "e1" })],
		["type", (actions) => actions.type({ tabId: TAB, ref: "e2", text: "hello" })],
		["key", (actions) => actions.key({ tabId: TAB, key: "Enter" })],
		["scroll", (actions) => actions.scroll({ tabId: TAB, deltaY: 100 })],
		["navigate", (actions) => actions.navigate({ tabId: TAB, url: "https://example.org/docs" })],
	];
	for (const [name, run] of runs) {
		let member = true;
		const { actions, sent } = setup({
			level: "never",
			inGroup: () => member,
			move: async () => {
				member = false;
				return true;
			},
		});
		await assert.rejects(run(actions), LEFT, name);
		assert.deepEqual(sent.filter((entry) => entry.method.startsWith("Input.") || entry.method.startsWith("Page.navigate")), [], name);
	}
});

test("the debugger refuses to attach, or attach again, a tab outside the group", async () => {
	const attached: number[] = [];
	const detachListeners: ((source: { tabId?: number }) => void)[] = [];
	const api: any = {
		debugger: {
			attach: async ({ tabId }: { tabId: number }) => {
				attached.push(tabId);
			},
			detach: async () => {},
			sendCommand: async () => ({}),
			onDetach: { addListener: (listener: (source: { tabId?: number }) => void) => detachListeners.push(listener) },
			onEvent: { addListener: () => {} },
		},
		tabs: { onRemoved: { addListener: () => {} } },
	};
	const members = new Set([1]);
	const cdp = new Debugger(api, { canAttach: async (tabId: number) => members.has(tabId) });
	await assert.rejects(cdp.send(2, "Input.dispatchMouseEvent", {}), { message: "Tab 2 is not in the Gentle Shell group; the debugger was not attached." });
	assert.equal(cdp.isAttached(2), false);
	await cdp.send(1, "Page.enable");
	assert.deepEqual(attached, [1]);
	members.delete(1);
	for (const listener of detachListeners) listener({ tabId: 1 });
	await assert.rejects(cdp.send(1, "Input.dispatchMouseEvent", {}), { message: "Tab 1 is not in the Gentle Shell group; the debugger was not attached." });
	assert.deepEqual(attached, [1]);
});

test("attaching makes the page behave as focused, so clicks focus fields while Chrome is in the background", async () => {
	const commands: [number, string, unknown][] = [];
	const api: any = {
		debugger: {
			attach: async () => {},
			detach: async () => {},
			sendCommand: async ({ tabId }: { tabId: number }, method: string, params?: unknown) => {
				commands.push([tabId, method, params]);
				return {};
			},
			onDetach: { addListener: () => {} },
			onEvent: { addListener: () => {} },
		},
		tabs: { onRemoved: { addListener: () => {} } },
	};
	const cdp = new Debugger(api, { canAttach: async () => true });
	await cdp.send(1, "Page.enable");
	await cdp.send(1, "Page.reload");
	assert.deepEqual(commands, [
		[1, "Emulation.setFocusEmulationEnabled", { enabled: true }],
		[1, "Page.enable", undefined],
		[1, "Page.reload", undefined],
	]);
});

// F4: the element under the cursor must still be the target right before pressing.

const MOVED = { message: "The page moved under the cursor; take a new browser_snapshot." };

test("when the target moved, the ref is resolved again once and the click lands there", async () => {
	const { actions, log, input } = setup({ hits: [false, true] });
	await actions.click({ tabId: TAB, ref: "e1" });
	const from = log.indexOf("guard on");
	assert.deepEqual(log.slice(from, from + 5), ["guard on", 'hit {"ref":"e1","x":120,"y":340}', "resolve e1", 'move 120,340 Click · "Save"', 'hit {"ref":"e1","x":120,"y":340}']);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
});

test("a target that is still covered after resolving again sends no input", async () => {
	for (const run of [(actions: any) => actions.click({ tabId: TAB, ref: "e1" }), (actions: any) => actions.type({ tabId: TAB, ref: "e2", text: "x" })]) {
		const { actions, input } = setup({ hits: [false, false] });
		await assert.rejects(run(actions), MOVED);
		assert.deepEqual(input(), []);
	}
});

// F2: a page change that skipped the guard is reported.

test("a page change that skipped the approval check is reported and the label warns", async () => {
	const cached = "https://example.com/cached";
	const { actions, moves, page } = setup({
		unguarded: { url: cached },
		onSend: (_method, params) => {
			if (params.type === "mouseReleased") page.url = cached;
		},
	});
	const result = await actions.click({ tabId: TAB, ref: "e1" });
	assert.deepEqual(result, { url: cached, title: "Example", urlChanged: true, unguardedNavigation: { url: cached } });
	assert.equal(moves.at(-1)!.label, "Page changed without approval → example.com/cached");

	const back = setup({ level: "never", unguarded: { url: "https://example.com/prev" } });
	back.actions.cdp.send = async (_tabId: number, method: string) => (method === "Page.getNavigationHistory" ? { currentIndex: 1, entries: [{ id: 7, url: "https://example.com/prev" }, { id: 8, url: "https://example.com/" }] } : {});
	const went = await back.actions.navigate({ tabId: TAB, action: "back" });
	assert.deepEqual(went.unguardedNavigation, { url: "https://example.com/prev" });
	assert.equal(back.moves.at(-1)!.label, "Page changed without approval → example.com/prev");
});

// Nit: one action at a time, across all tabs.

test("actions run one at a time across tabs, in order", async () => {
	let release: (value: unknown) => void = () => {};
	let gated = true;
	const { actions, log } = setup({
		move: () => {
			if (!gated) return Promise.resolve(true);
			gated = false;
			return new Promise((resolve) => (release = resolve));
		},
	});
	const first = actions.click({ tabId: TAB, ref: "e1" });
	const second = actions.scroll({ tabId: 6, deltaY: 100 });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(log.at(-1), 'move 120,340 Click · "Save"');
	release(true);
	await Promise.all([first, second]);
	assert.ok(log.indexOf("Input.dispatchMouseEvent mouseReleased") < log.indexOf("Input.dispatchMouseEvent mouseWheel"));
});

test("STOP also fails the actions waiting their turn, with no input", async () => {
	const { actions, input } = setup({ move: () => new Promise(() => {}) });
	const first = actions.click({ tabId: TAB, ref: "e1" });
	const second = actions.key({ tabId: 6, key: "Enter" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop();
	await assert.rejects(first, { message: STOPPED });
	await assert.rejects(second, { message: STOPPED });
	assert.deepEqual(input(), []);
});

// S11: risky pages are detected from their content; the agent can only raise risk.

const PASSWORD_PAGE = { fields: [{ type: "password", autocomplete: "", name: "pw", id: "", label: "" }], submits: [], frames: [], headings: [] };
const AGENT = "the agent marked this step as sensitive";

test("a page whose content looks risky makes a harmless click ask in always and remember", async () => {
	for (const level of ["always", "remember"]) {
		const { actions, requests, input } = setup({ level, signals: PASSWORD_PAGE, approve: () => false });
		await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), NOT_APPROVED, level);
		assert.equal(requests.length, 1, level);
		assert.equal(requests[0].reason, "acting on a risky page: the page has a password field", level);
		assert.deepEqual(input(), [], level);
	}
});

test("typing, keys and scrolling on a page whose content looks risky ask too", async () => {
	const runs: [string, (actions: any) => Promise<unknown>][] = [
		["type", (actions) => actions.type({ tabId: TAB, ref: "e2", text: "hello" })],
		["key", (actions) => actions.key({ tabId: TAB, key: "ArrowDown" })],
		["scroll", (actions) => actions.scroll({ tabId: TAB, deltaY: 100 })],
	];
	for (const [name, run] of runs) {
		const { actions, requests, input } = setup({ level: "remember", signals: PASSWORD_PAGE, approve: () => false });
		await assert.rejects(run(actions), NOT_APPROVED, name);
		assert.equal(requests[0].reason, "acting on a risky page: the page has a password field", name);
		assert.deepEqual(input(), [], name);
	}
});

test("a page whose content could not be read asks", async () => {
	const { actions, requests } = setup({ level: "remember", signals: null, approve: () => false });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), NOT_APPROVED);
	assert.equal(requests[0].reason, "acting on a risky page: the page content could not be inspected");
});

test("risky:true on a harmless step asks with the agent's reason, and goes ahead when allowed", async () => {
	const steps: [string, (actions: any) => Promise<unknown>][] = [
		["click", (actions) => actions.click({ tabId: TAB, ref: "e1", risky: true })],
		["type", (actions) => actions.type({ tabId: TAB, ref: "e2", text: "hello", risky: true })],
		["key", (actions) => actions.key({ tabId: TAB, key: "ArrowDown", risky: true })],
	];
	for (const [name, run] of steps) {
		const denied = setup({ level: "remember", approve: () => false });
		await assert.rejects(run(denied.actions), NOT_APPROVED, name);
		assert.deepEqual({ kind: denied.requests[0].kind, reason: denied.requests[0].reason }, { kind: "action", reason: AGENT }, name);
		assert.deepEqual(denied.input(), [], name);
	}
	const { actions, requests, input } = setup({ level: "remember", rules: { "example.com": { click: "allow" } } });
	await actions.click({ tabId: TAB, ref: "e1", risky: true });
	assert.equal(requests.length, 1);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
});

test("risky:false on a step the extension finds risky still asks with the extension's reason", async () => {
	const { actions, requests, input } = setup({ level: "remember", rules: { "example.com": { click: "allow" } }, facts: PAY, approve: () => false });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1", risky: false }), NOT_APPROVED);
	assert.equal(requests[0].reason, 'clicking "Pay now" (pay)');
	assert.deepEqual(input(), []);
	const page = setup({ level: "remember", rules: { "example.com": { click: "allow" } }, signals: PASSWORD_PAGE, approve: () => false });
	await assert.rejects(page.actions.click({ tabId: TAB, ref: "e1", risky: false }), NOT_APPROVED);
});

test("with a saved allow, a harmless page with no flag, risky:false or a non-boolean flag does not ask", async () => {
	for (const risky of [undefined, false, "true", 1, null]) {
		const { actions, requests, input, probes } = setup({ level: "remember", rules: { "example.com": { click: "allow", key: "allow" } } });
		await actions.click({ tabId: TAB, ref: "e1", risky });
		await actions.key({ tabId: TAB, key: "ArrowDown", risky });
		assert.deepEqual(requests, [], String(risky));
		assert.equal(input().length, 5, String(risky));
		assert.equal(probes.length, 2, String(risky));
	}
});

test("risky:true on navigate and open asks even over a saved allow; false or absent changes nothing", async () => {
	const allowed = { "example.org": { navigate: "allow" } };
	const denied = setup({ level: "remember", rules: allowed, approve: () => false });
	await assert.rejects(denied.actions.navigate({ tabId: TAB, url: "https://example.org/docs", risky: true }), NOT_APPROVED);
	assert.deepEqual({ kind: denied.requests[0].kind, reason: denied.requests[0].reason }, { kind: "navigate", reason: AGENT });
	let created = 0;
	const createTab = async () => {
		created++;
		return { tabId: TAB, groupId: 3 };
	};
	await assert.rejects(denied.actions.open("https://example.org/", createTab, { risky: true }), NOT_APPROVED);
	assert.deepEqual({ kind: denied.requests[1].kind, reason: denied.requests[1].reason }, { kind: "open", reason: AGENT });
	assert.equal(created, 0);

	const { actions, requests } = setup({ level: "remember", rules: allowed });
	await actions.navigate({ tabId: TAB, url: "https://example.org/docs", risky: false });
	await actions.navigate({ tabId: TAB, url: "https://example.org/docs", risky: "yes" });
	await actions.open("https://example.org/", createTab, { risky: false });
	await actions.open("https://example.org/", createTab);
	assert.deepEqual(requests, []);
});

test("after a load the page content is probed and reported, without pausing; the next action on it asks", async () => {
	const { actions, requests, probes } = setup({ level: "remember", rules: { "example.org": { navigate: "allow", click: "allow" } }, signals: PASSWORD_PAGE, approve: () => false });
	const result = await actions.navigate({ tabId: TAB, url: "https://example.org/login" });
	assert.deepEqual(result, { url: "https://example.org/login", title: "Example", risk: { risky: true, reason: "the page has a password field" } });
	assert.equal(requests.length, 0);
	assert.deepEqual(probes, ["https://example.org/login"]);
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), NOT_APPROVED);
	assert.equal(requests[0].reason, "acting on a risky page: the page has a password field");
});

test("a click that loads a risky-looking page reports the risk; a harmless one does not", async () => {
	for (const [to, risk] of [
		["https://example.com/login", { risky: true, reason: "the page has a password field" }],
		["https://example.com/next", undefined],
	] as const) {
		const { actions, page, requests } = setup({
			level: "never",
			signals: (url: string) => (url.endsWith("/login") ? PASSWORD_PAGE : harmlessPage),
			onSend: (_method, params) => {
				if (params.type === "mouseReleased") page.url = to;
			},
		});
		const result = await actions.click({ tabId: TAB, ref: "e1" });
		assert.deepEqual(result, { url: to, title: "Example", urlChanged: true, ...(risk ? { risk } : {}) }, to);
		assert.deepEqual(requests, [], to);
	}
});

// S12: one shared, serialized Actions; each call checks membership and asks approval for the session that made it.

test("a per-call scope replaces the group check and the approval route for that action only", async () => {
	const { actions, input, requests } = setup({ facts: PAY, inGroup: () => true });
	const asked: string[] = [];
	const scoped = { inGroup: async (tabId: number) => tabId !== TAB, approve: async () => (asked.push("scoped"), true) };
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }, scoped), LEFT);
	assert.deepEqual(asked, ["scoped"]);
	assert.deepEqual(requests, []);
	assert.deepEqual(input(), []);
	// The next call without a scope uses the defaults again.
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.equal(requests.length, 1);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
});

test("open asks through the scope's approval route and checks the new tab with the scope's group", async () => {
	const { actions, requests, input } = setup();
	const asked: string[] = [];
	const members: number[] = [];
	const opened = await actions.open("https://example.org/", async () => ({ tabId: 77, groupId: 3 }), {
		inGroup: async (tabId: number) => (members.push(tabId), true),
		approve: async (request: any) => (asked.push(request.kind), true),
	});
	assert.deepEqual(opened, { tabId: 77, groupId: 3 });
	assert.deepEqual(asked, ["open"]);
	assert.deepEqual(requests, []);
	assert.ok(members.length > 0 && members.every((tabId) => tabId === 77));
	assert.deepEqual(input(), []);
});

// F1: STOP from one session's page, or its disconnect, stops only that session's actions.

/** Holds every cursor move on `tabId` until `release`; other tabs move at once. */
function gate(tabId: number) {
	let release: () => void = () => {};
	const held = new Promise<unknown>((resolve) => (release = () => resolve(true)));
	return { move: (tab: number) => (tab === tabId ? held : Promise.resolve(true)), release: () => release() };
}

test("stop(owner) fails only that owner's queued action; another session's running action goes on untouched", async () => {
	const B_TAB = 6;
	const { move, release } = gate(B_TAB);
	const { actions, input, log } = setup({ move });
	const running = actions.click({ tabId: B_TAB, ref: "e1" }, { owner: "B" });
	const queued = actions.key({ tabId: TAB, key: "Enter" }, { owner: "A" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop("A");
	await assert.rejects(queued, { message: STOPPED });
	release();
	await running;
	assert.deepEqual(input().map((entry) => [entry.tabId, entry.params.type]), [[B_TAB, "mouseMoved"], [B_TAB, "mousePressed"], [B_TAB, "mouseReleased"]]);
	for (const entry of ["guard stop", "detachAll", `clear ${B_TAB}`, `clear ${TAB}`]) assert.equal(log.includes(entry), false, entry);
});

test("stopping a queued action in the middle of the queue does not let the one behind it start early", async () => {
	const B_TAB = 6;
	const C_TAB = 7;
	const { move, release } = gate(B_TAB);
	const { actions, input } = setup({ move });
	const running = actions.click({ tabId: B_TAB, ref: "e1" }, { owner: "B" });
	const middle = actions.key({ tabId: TAB, key: "Enter" }, { owner: "A" });
	const last = actions.scroll({ tabId: C_TAB, deltaY: 100 }, { owner: "C" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop("A");
	await assert.rejects(middle, { message: STOPPED });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(input(), [], "nothing runs while B's action still holds its turn");
	release();
	await running;
	await last;
	assert.deepEqual(
		input().map((entry) => [entry.tabId, entry.params.type]),
		[[B_TAB, "mouseMoved"], [B_TAB, "mousePressed"], [B_TAB, "mouseReleased"], [C_TAB, "mouseWheel"]],
	);
});

test("stop(owner) rejects that owner's running action, clears only its tab, and the other session's queued action runs", async () => {
	const { move, release } = gate(TAB);
	const { actions, input, log } = setup({ move });
	const running = actions.click({ tabId: TAB, ref: "e1" }, { owner: "A" });
	const queued = actions.scroll({ tabId: 6, deltaY: 100 }, { owner: "B" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop("A");
	await assert.rejects(running, { message: STOPPED });
	assert.equal((await queued).url, "https://example.com/");
	release();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(input().map((entry) => [entry.tabId, entry.params.type]), [[6, "mouseWheel"]]);
	assert.ok(log.includes(`clear ${TAB}`));
	for (const entry of ["guard stop", "detachAll", "clear 6"]) assert.equal(log.includes(entry), false, entry);
});

test("stop() with no owner still fails every session's running and queued actions", async () => {
	const { actions, input, log } = setup({ move: () => new Promise(() => {}) });
	const first = actions.click({ tabId: TAB, ref: "e1" }, { owner: "A" });
	const second = actions.key({ tabId: 6, key: "Enter" }, { owner: "B" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop();
	await assert.rejects(first, { message: STOPPED });
	await assert.rejects(second, { message: STOPPED });
	assert.deepEqual(input(), []);
	assert.deepEqual(log.slice(-3), ["guard stop", `clear ${TAB}`, "detachAll"]);
});

test("stop(owner) with no other action left cleans up everything, like STOP in the popup", async () => {
	const { actions, log } = setup({ move: () => new Promise(() => {}) });
	const running = actions.click({ tabId: TAB, ref: "e1" }, { owner: "A" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await actions.stop("A");
	await assert.rejects(running, { message: STOPPED });
	assert.deepEqual(log.slice(-3), ["guard stop", `clear ${TAB}`, "detachAll"]);
});

// S14: three permission modes; remember mode saves decisions per site and action type.

test("remember mode: a saved allow for clicks on the site dispatches without asking, but a payment click there asks", async () => {
	const { actions, requests, input } = setup({ level: "remember", rules: { "example.com": { click: "allow" } }, approve: () => false });
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.deepEqual(requests, []);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));

	const pay = setup({ level: "remember", rules: { "example.com": { click: "allow" } }, facts: PAY, approve: () => false });
	await assert.rejects(pay.actions.click({ tabId: TAB, ref: "e1" }), NOT_APPROVED);
	assert.deepEqual(
		{ reason: pay.requests[0].reason, level: pay.requests[0].level, remember: pay.requests[0].remember },
		{ reason: 'clicking "Pay now" (pay)', level: "remember", remember: { site: "example.com", category: "money" } },
	);
	assert.deepEqual(pay.input(), []);
});

test("remember mode: a saved deny refuses without asking, with the exact error and no input", async () => {
	const { actions, requests, input } = setup({ level: "remember", rules: { "example.com": { click: "deny" } } });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), {
		message: 'The user did not approve: click "Save" on example.com (saved rule: deny click on example.com). Do not retry this step unless the user asks.',
	});
	assert.deepEqual(requests, []);
	assert.deepEqual(input(), []);
	const nav = setup({ level: "remember", rules: { "example.org": { navigate: "deny" } } });
	await assert.rejects(nav.actions.navigate({ tabId: TAB, url: "https://www.example.org/docs" }), {
		message: `The user did not approve: open https://www.example.org/docs in tab ${TAB} (saved rule: deny navigate on example.org). Do not retry this step unless the user asks.`,
	});
	assert.deepEqual(nav.sent, []);
});

test("remember mode: Always allow saves the rule, the step goes ahead, and the next identical step does not ask", async () => {
	const { actions, requests, input, saved, rules } = setup({ level: "remember", approve: () => ({ approved: true, remember: "allow" }) });
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.deepEqual(requests.map((request) => request.remember), [{ site: "example.com", category: "click" }]);
	assert.deepEqual(saved, [["example.com", "click", "allow"]]);
	assert.deepEqual(rules, { "example.com": { click: "allow" } });
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.equal(requests.length, 1);
	assert.deepEqual(input().map((entry) => entry.params), [...mouse(120, 340), ...mouse(120, 340)]);
});

test("remember mode: Always deny saves the rule and refuses this step and the next without asking", async () => {
	const { actions, requests, input, saved } = setup({ level: "remember", approve: () => ({ approved: false, remember: "deny" }) });
	await assert.rejects(actions.scroll({ tabId: TAB, deltaY: 100 }), { message: "The user did not approve: scroll on example.com. Do not retry this step unless the user asks." });
	assert.deepEqual(saved, [["example.com", "scroll", "deny"]]);
	await assert.rejects(actions.scroll({ tabId: TAB, deltaY: 100 }), { message: "The user did not approve: scroll on example.com (saved rule: deny scroll on example.com). Do not retry this step unless the user asks." });
	assert.equal(requests.length, 1);
	assert.deepEqual(input(), []);
});

test("a remember answer to a request that did not offer it is ignored", async () => {
	const { actions, requests, saved } = setup({ level: "always", approve: () => ({ approved: true, remember: "allow" }) });
	await actions.click({ tabId: TAB, ref: "e1" });
	await actions.click({ tabId: TAB, ref: "e1" });
	assert.equal(requests.length, 2);
	assert.equal("remember" in requests[0], false);
	assert.deepEqual(saved, []);
	// A page without a site is never offered a saved decision.
	const blank = setup({ level: "remember", approve: () => ({ approved: true, remember: "allow" }) });
	blank.page.url = "about:blank";
	await blank.actions.click({ tabId: TAB, ref: "e1" });
	assert.equal("remember" in blank.requests[0], false);
	assert.deepEqual(blank.saved, []);
});

test("never mode dispatches a payment click with no request, even when the agent marks it risky", async () => {
	const { actions, requests, input } = setup({ level: "never", facts: PAY, approve: () => false });
	await actions.click({ tabId: TAB, ref: "e1", risky: true });
	assert.deepEqual(requests, []);
	assert.deepEqual(input().map((entry) => entry.params), mouse(120, 340));
	let created = 0;
	await actions.open("https://www.paypal.com/checkout", async () => (created++, { tabId: TAB, groupId: 3 }), { risky: true });
	assert.equal(created, 1);
	assert.deepEqual(requests, []);
});

test("never mode keeps the group check and STOP", async () => {
	const { actions, input } = setup({ level: "never", facts: PAY, inGroup: () => false });
	await assert.rejects(actions.click({ tabId: TAB, ref: "e1" }), LEFT);
	assert.deepEqual(input(), []);
	const stopped = setup({ level: "never", move: () => new Promise(() => {}) });
	const inFlight = stopped.actions.click({ tabId: TAB, ref: "e1" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await stopped.actions.stop();
	await assert.rejects(inFlight, { message: STOPPED });
	assert.deepEqual(stopped.input(), []);
});
