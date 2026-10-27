import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotExpression } from "../extension/lib/page.js";

const WIDTH = 1000;
const HEIGHT = 800;

interface Box {
	left: number;
	top: number;
	width?: number;
	height?: number;
}

/** A button of the fake page at `box`, in viewport coordinates. */
function button(name: string, box: Box) {
	const { left, top, width = 100, height = 20 } = box;
	return {
		tagName: "BUTTON",
		innerText: name,
		isConnected: true,
		isContentEditable: false,
		getAttribute: () => null,
		querySelector: () => null,
		getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
	};
}

type Element = ReturnType<typeof button>;

/**
 * Runs the snapshot expression, exactly as it is sent to the page, against a
 * minimal fake DOM. `scope` stands for the page's globalThis, so refs persist
 * across runs that share it.
 */
function snapshot(elements: Element[], options: { full?: boolean; text?: { value: string; parent: Element }[]; innerText?: string; scope?: object }) {
	const textNodes = options.text ?? [];
	const document = {
		title: "Fake page",
		body: { innerText: options.innerText ?? "" },
		querySelectorAll: (selector: string) => (selector === "iframe, frame" ? [] : elements),
		getElementById: () => null,
		createTreeWalker: () => {
			let index = 0;
			return { nextNode: () => (index < textNodes.length ? { nodeValue: textNodes[index++].value, parentElement: textNodes[index - 1].parent } : null) };
		},
	};
	const window = { innerWidth: WIDTH, innerHeight: HEIGHT, scrollY: 0 };
	const getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
	const scope: any = options.scope ?? {};
	const run = new Function("document", "window", "location", "getComputedStyle", "NodeFilter", "globalThis", `return ${snapshotExpression({ full: options.full === true })};`);
	const result = run(document, window, { href: "https://example.com/" }, getComputedStyle, { SHOW_TEXT: 4 }, scope);
	return { result, scope };
}

/** `count` buttons inside the viewport, then `outside` buttons below it. */
function page(count: number, outside: number) {
	const inside = Array.from({ length: count }, (_, i) => button(`in ${i}`, { left: 10, top: (i * 7) % (HEIGHT - 20) }));
	const below = Array.from({ length: outside }, (_, i) => button(`out ${i}`, { left: 10, top: HEIGHT + 100 + i * 30 }));
	return { inside, below, all: [...inside, ...below] };
}

test("the snapshot expression parses for both modes", () => {
	for (const full of [false, true]) assert.doesNotThrow(() => new Function(`return ${snapshotExpression({ full })};`), String(full));
	assert.equal(snapshotExpression(), snapshotExpression({ full: false }));
});

test("by default only elements in the viewport are listed, at most 80, with the count left outside", () => {
	const { all } = page(100, 50);
	const { result } = snapshot(all, {});
	assert.equal(result.elements.length, 80);
	assert.ok(result.elements.every((element: { name: string }) => element.name.startsWith("in ")));
	assert.equal(result.omitted, 20);
	assert.equal(result.offscreen, 50);
});

test("an element partly inside the viewport counts as inside", () => {
	const partly = [button("top", { left: 10, top: -15 }), button("right", { left: WIDTH - 5, top: 10 }), button("gone", { left: 10, top: -25 })];
	const { result } = snapshot(partly, {});
	assert.deepEqual(result.elements.map((element: { name: string }) => element.name), ["top", "right"]);
	assert.equal(result.offscreen, 1);
});

test("full: true lists offscreen elements too, up to 300", () => {
	const small = snapshot(page(10, 50).all, { full: true }).result;
	assert.equal(small.elements.length, 60);
	assert.equal(small.offscreen, 0);
	assert.equal(small.elements.filter((element: { offscreen?: boolean }) => element.offscreen).length, 50);
	const big = snapshot(page(100, 250).all, { full: true }).result;
	assert.equal(big.elements.length, 300);
	assert.equal(big.omitted, 50);
	assert.equal(big.offscreen, 0);
});

test("refs of the elements returned in either mode resolve, and stay the same across modes", () => {
	const { all, below } = page(3, 2);
	const first = snapshot(all, {});
	assert.deepEqual([...first.scope.__gentleRefs.keys()], ["e1", "e2", "e3"]);
	assert.equal(first.scope.__gentleRefs.get("e1"), all[0]);
	const second = snapshot(all, { full: true, scope: first.scope });
	assert.deepEqual(second.result.elements.map((element: { ref: string }) => element.ref), ["e1", "e2", "e3", "e4", "e5"]);
	assert.equal(second.scope.__gentleRefs.get("e4"), below[0]);
	const third = snapshot(all, { scope: first.scope });
	assert.deepEqual([...third.scope.__gentleRefs.keys()], ["e1", "e2", "e3"]);
});

test("by default the text is the visible part of the page, at most 1500 characters", () => {
	const shown = button("shown", { left: 0, top: 0, width: WIDTH, height: 100 });
	const hidden = button("hidden", { left: 0, top: HEIGHT + 10, width: WIDTH, height: 100 });
	const text = [
		{ value: "  Visible   heading ", parent: shown },
		{ value: "Below the fold", parent: hidden },
		{ value: "visible body", parent: shown },
	];
	assert.equal(snapshot([], { text, innerText: "everything" }).result.text, "Visible heading visible body");
	const long = [{ value: "x".repeat(4000), parent: shown }];
	assert.equal(snapshot([], { text: long }).result.text.length, 1500);
});

test("full: true reads the text of the whole page, offscreen included, at most 6000 characters", () => {
	const shown = button("shown", { left: 0, top: 0 });
	const below = button("below", { left: 0, top: HEIGHT + 500 });
	const text = [
		{ value: "Visible", parent: shown },
		{ value: "Below   the fold", parent: below },
	];
	assert.equal(snapshot([], { full: true, text }).result.text, "Visible Below the fold");
	assert.equal(snapshot([], { full: true, text: [{ value: "y".repeat(9000), parent: shown }] }).result.text.length, 6000);
});

test("the text leaves out what the listed elements already name, in both modes", () => {
	const save = button("Save", { left: 10, top: 10 });
	const link = button("Docs page", { left: 10, top: 50 });
	const inLink = { ...button("", { left: 10, top: 50 }), parentElement: link };
	const paragraph = button("", { left: 0, top: 100, width: WIDTH, height: 40 });
	const text = [
		{ value: "Intro paragraph", parent: paragraph },
		{ value: "Save", parent: save },
		{ value: "Docs page", parent: inLink },
		{ value: "closing words", parent: paragraph },
	];
	for (const full of [false, true]) {
		const { result } = snapshot([save, link], { full, text });
		assert.deepEqual(result.elements.map((element: { name: string }) => element.name), ["Save", "Docs page"], String(full));
		assert.equal(result.text, "Intro paragraph closing words", String(full));
	}
	// An element left out of the list keeps its text: the model has no other way to see it.
	const many = page(80, 0).inside;
	const extra = button("Extra", { left: 10, top: 10 });
	const { result } = snapshot([...many, extra], { text: [{ value: "Extra", parent: extra }, { value: "in 3", parent: many[3] }] });
	assert.equal(result.omitted, 1);
	assert.equal(result.text, "Extra");
});
