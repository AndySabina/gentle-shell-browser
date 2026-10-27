import assert from "node:assert/strict";
import { test } from "node:test";
import { keyEvent } from "../extension/lib/keys.js";

test("named keys map to their CDP key, code and virtual key code", () => {
	assert.deepEqual(keyEvent("Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
	assert.deepEqual(keyEvent("Tab"), { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 0 });
	assert.deepEqual(keyEvent("Escape"), { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 0 });
	assert.deepEqual(keyEvent("Backspace"), { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 });
	assert.deepEqual(keyEvent("Delete"), { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, modifiers: 0 });
	assert.deepEqual(keyEvent("ArrowLeft"), { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 0 });
	assert.deepEqual(keyEvent("ArrowUp"), { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, modifiers: 0 });
	assert.deepEqual(keyEvent("ArrowRight"), { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, modifiers: 0 });
	assert.deepEqual(keyEvent("ArrowDown"), { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 0 });
	assert.deepEqual(keyEvent("Home"), { key: "Home", code: "Home", windowsVirtualKeyCode: 36, modifiers: 0 });
	assert.deepEqual(keyEvent("End"), { key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 0 });
	assert.deepEqual(keyEvent("PageUp"), { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33, modifiers: 0 });
	assert.deepEqual(keyEvent("PageDown"), { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, modifiers: 0 });
	assert.deepEqual(keyEvent("Space"), { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0, text: " " });
	assert.deepEqual(keyEvent("enter"), keyEvent("Enter"));
});

test("printable characters carry their text", () => {
	assert.deepEqual(keyEvent("a"), { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, text: "a" });
	assert.deepEqual(keyEvent("Z"), { key: "Z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 0, text: "Z" });
	assert.deepEqual(keyEvent("7"), { key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0, text: "7" });
	assert.deepEqual(keyEvent("/"), { key: "/", code: "Slash", windowsVirtualKeyCode: 191, modifiers: 0, text: "/" });
	assert.deepEqual(keyEvent("ñ"), { key: "ñ", code: "", windowsVirtualKeyCode: 0, modifiers: 0, text: "ñ" });
});

test("modifier combos set the exact modifiers bitmask (Alt=1 Ctrl=2 Meta=4 Shift=8)", () => {
	assert.deepEqual(keyEvent("Control+a"), { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
	assert.deepEqual(keyEvent("Ctrl+a"), keyEvent("Control+a"));
	assert.deepEqual(keyEvent("Shift+Tab"), { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
	assert.deepEqual(keyEvent("Meta+Enter"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 });
	assert.deepEqual(keyEvent("Alt+ArrowLeft"), { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 1 });
	assert.deepEqual(keyEvent("Control+Shift+k"), { key: "K", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 10 });
	assert.deepEqual(keyEvent("Shift+a"), { key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A" });
	assert.deepEqual(keyEvent("Control++"), { key: "+", code: "", windowsVirtualKeyCode: 0, modifiers: 2 });
});

test("unknown keys throw with the exact message", () => {
	for (const key of ["Foo", "Hyper+a", "Control+", "", "Control+Banana"]) {
		assert.throws(() => keyEvent(key), { message: `Unknown key: ${key}` }, key);
	}
});
