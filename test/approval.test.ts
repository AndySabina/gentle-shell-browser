import assert from "node:assert/strict";
import { test } from "node:test";
import { askApproval } from "../src/approval.ts";

const REQUEST = {
	kind: "action",
	title: 'click "Pay now" on shop.test',
	detail: "Click on the element e4.",
	url: "https://shop.test/cart",
	reason: 'clicking "Pay now" (pay)',
	level: "always",
};

function fakeContext(answer: string | undefined, hasUI = true) {
	const prompts: { title: string; options: string[]; opts: any }[] = [];
	const context = {
		hasUI,
		ui: {
			async select(title: string, options: string[], opts?: any) {
				prompts.push({ title, options, opts });
				return answer;
			},
		},
	};
	return { context, prompts };
}

test("shows a readable prompt with exactly Deny / Allow once, Deny first", async () => {
	const { context, prompts } = fakeContext("Allow once");
	const signal = new AbortController().signal;
	assert.deepEqual(await askApproval(context, REQUEST, signal), { approved: true });
	assert.equal(prompts.length, 1);
	assert.deepEqual(prompts[0].options, ["Deny", "Allow once"]);
	assert.deepEqual(prompts[0].title.split("\n"), [
		'Gentle Shell wants to click "Pay now" on shop.test',
		"Click on the element e4.",
		"URL: https://shop.test/cart",
		'Why: clicking "Pay now" (pay)',
		"Mode: Always ask",
	]);
	assert.equal(prompts[0].opts.signal, signal);
});

test("an upload lists every file on its own line, whole, however long the paths are", async () => {
	const files = Array.from({ length: 10 }, (_, i) => `report-${i}.pdf (/home/you/${"long-folder-name/".repeat(8)}report-${i}.pdf)`);
	const { context, prompts } = fakeContext("Allow once");
	const upload = { kind: "action", title: "upload 10 local files to example.com", detail: "Upload in tab 7.", url: "https://example.com/", reason: "uploading local files", level: "never", files };
	assert.deepEqual(await askApproval(context, upload), { approved: true });
	assert.deepEqual(prompts[0].title.split("\n"), [
		"Gentle Shell wants to upload 10 local files to example.com",
		"Upload in tab 7.",
		...files.map((file) => `File: ${file}`),
		"URL: https://example.com/",
		"Why: uploading local files",
		"Mode: Never ask",
	]);
});

test("an upload whose file list is malformed or too long is denied without prompting", async () => {
	const base = { kind: "action", title: "upload", detail: "", url: "https://example.com/", reason: "" };
	for (const files of [[], "a.pdf", [3], Array.from({ length: 11 }, () => "a.pdf"), ["x".repeat(4097)]]) {
		const { context, prompts } = fakeContext("Allow once");
		assert.deepEqual(await askApproval(context, { ...base, files }), { approved: false }, JSON.stringify(files).slice(0, 40));
		assert.equal(prompts.length, 0);
	}
});

test("a file line cannot split the prompt or hide text with control characters", async () => {
	const { context, prompts } = fakeContext("Allow once");
	await askApproval(context, { kind: "action", title: "upload", detail: "", url: "", reason: "", files: ["a\nFile: fake.pdf\u202e"] });
	assert.deepEqual(prompts[0].title.split("\n"), ["Gentle Shell wants to upload", "File: a File: fake.pdf"]);
});

const REMEMBER = { ...REQUEST, level: "remember", remember: { site: "shop.test", category: "money" } };
const ALWAYS_ALLOW = "Always allow payments and transfers on shop.test";
const ALWAYS_DENY = "Always deny payments and transfers on shop.test";

test("remember mode adds Always allow and Always deny for that site and category, after Deny and Allow once", async () => {
	const { context, prompts } = fakeContext("Deny");
	assert.deepEqual(await askApproval(context, REMEMBER), { approved: false });
	assert.deepEqual(prompts[0].options, ["Deny", "Allow once", ALWAYS_ALLOW, ALWAYS_DENY]);
	assert.equal(prompts[0].title.split("\n").at(-1), "Mode: Remember my decisions");
	const labels: Record<string, string> = {
		navigate: "opening pages",
		click: "clicks",
		type: "typing",
		key: "key presses",
		scroll: "scrolling",
		money: "payments and transfers",
		irreversible: "deleting, passwords and security changes",
	};
	for (const [category, label] of Object.entries(labels)) {
		const each = fakeContext("Deny");
		await askApproval(each.context, { ...REMEMBER, remember: { site: "example.com", category } });
		assert.deepEqual(each.prompts[0].options, ["Deny", "Allow once", `Always allow ${label} on example.com`, `Always deny ${label} on example.com`], category);
	}
});

test("each answer maps to the exact response", async () => {
	const answers: [string | undefined, unknown][] = [
		["Deny", { approved: false }],
		["Allow once", { approved: true }],
		[ALWAYS_ALLOW, { approved: true, remember: "allow" }],
		[ALWAYS_DENY, { approved: false, remember: "deny" }],
		[undefined, { approved: false }],
		["Something else", { approved: false }],
	];
	for (const [answer, expected] of answers) assert.deepEqual(await askApproval(fakeContext(answer).context, REMEMBER), expected, String(answer));
	// Without remember the Always answers do not exist, so they cannot be picked.
	assert.deepEqual(await askApproval(fakeContext(ALWAYS_ALLOW).context, REQUEST), { approved: false });
});

test("a malformed remember makes the request malformed: denied without prompting", async () => {
	const { context, prompts } = fakeContext("Allow once");
	for (const remember of [null, "shop.test", { site: "", category: "money" }, { site: "shop.test", category: "bogus" }, { site: 3, category: "money" }, { site: "shop.test" }, ["shop.test", "money"]]) {
		assert.deepEqual(await askApproval(context, { ...REQUEST, remember }), { approved: false }, JSON.stringify(remember));
	}
	assert.deepEqual(prompts, []);
	assert.deepEqual(await askApproval(undefined, REMEMBER), { approved: false });
	assert.deepEqual(await askApproval(fakeContext(ALWAYS_ALLOW, false).context, REMEMBER), { approved: false });
});

test("Deny, a dismissed prompt or no UI do not approve", async () => {
	assert.deepEqual(await askApproval(fakeContext("Deny").context, REQUEST), { approved: false });
	assert.deepEqual(await askApproval(fakeContext(undefined).context, REQUEST), { approved: false });
	const noUi = fakeContext("Allow once", false);
	assert.deepEqual(await askApproval(noUi.context, REQUEST), { approved: false });
	assert.deepEqual(noUi.prompts, []);
	assert.deepEqual(await askApproval(undefined, REQUEST), { approved: false });
});

test("a failing prompt does not approve", async () => {
	const context = {
		hasUI: true,
		ui: {
			select: async () => {
				throw new Error("dialog closed");
			},
		},
	};
	assert.deepEqual(await askApproval(context, REQUEST), { approved: false });
});

test("a malformed request is denied without prompting", async () => {
	const { context, prompts } = fakeContext("Allow once");
	for (const bad of [null, "open", [], { ...REQUEST, kind: "format-disk" }, { ...REQUEST, title: "" }, { ...REQUEST, title: 3 }, { ...REQUEST, url: undefined }, { ...REQUEST, reason: {} }, { ...REQUEST, detail: null }]) {
		assert.deepEqual(await askApproval(context, bad), { approved: false }, JSON.stringify(bad));
	}
	assert.deepEqual(prompts, []);
});

test("control characters from the page cannot reach the terminal", async () => {
	const { context, prompts } = fakeContext("Deny");
	await askApproval(context, { ...REQUEST, title: 'click "\u001b[2JPay\u0007" on shop.test', level: undefined });
	assert.equal(prompts[0].title.split("\n")[0], 'Gentle Shell wants to click " [2JPay " on shop.test');
	assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(prompts[0].title), false);
	assert.equal(prompts[0].title.split("\n").length, 4);
});

test("bidi controls and line separators from the page cannot reorder or split the prompt", async () => {
	const { context, prompts } = fakeContext("Deny");
	const tricky = "click \u202eyaP\u202c \u2066x\u2069\u200e\u200f\u202a\u202b\u202d\u2067\u2068 on shop.test\u2028Why: harmless\u2029";
	await askApproval(context, { ...REQUEST, title: tricky, detail: "a\u2028b", level: undefined });
	assert.equal(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u2028\u2029]/.test(prompts[0].title), false);
	assert.equal(prompts[0].title.split("\n").length, 4);
	assert.equal(prompts[0].title.split("\n")[0], "Gentle Shell wants to click  yaP   x         on shop.test Why: harmless");
});
