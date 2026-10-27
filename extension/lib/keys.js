// Maps key strings such as "Enter", "a" or "Control+Shift+k" to the params of
// CDP Input.dispatchKeyEvent (US layout codes, as Chrome expects).

/** CDP modifier bits. */
const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const ALT_CTRL_META = 1 | 2 | 4;
const SHIFT = 8;

/** @type {Record<string, {key: string, code: string, vk: number, text?: string}>} */
const NAMED = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", vk: 9 },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	delete: { key: "Delete", code: "Delete", vk: 46 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	home: { key: "Home", code: "Home", vk: 36 },
	end: { key: "End", code: "End", vk: 35 },
	pageup: { key: "PageUp", code: "PageUp", vk: 33 },
	pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
	space: { key: " ", code: "Space", vk: 32, text: " " },
};

/** @type {Record<string, [string, number]>} unshifted US punctuation: code and virtual key code */
const PUNCTUATION = {
	"-": ["Minus", 189],
	"=": ["Equal", 187],
	"[": ["BracketLeft", 219],
	"]": ["BracketRight", 221],
	"\\": ["Backslash", 220],
	";": ["Semicolon", 186],
	"'": ["Quote", 222],
	",": ["Comma", 188],
	".": ["Period", 190],
	"/": ["Slash", 191],
	"`": ["Backquote", 192],
};

/** @param {string} char */
function printable(char) {
	if (/^[a-z]$/i.test(char)) {
		const upper = char.toUpperCase();
		return { key: char, code: `Key${upper}`, vk: upper.charCodeAt(0), text: char };
	}
	if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, vk: char.charCodeAt(0), text: char };
	const [code, vk] = PUNCTUATION[char] ?? ["", 0];
	return { key: char, code, vk, text: char };
}

/**
 * @param {string} spec e.g. "Enter", "a", "Shift+Tab", "Control+a"
 * @returns {{key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, text?: string}}
 */
export function keyEvent(spec) {
	const unknown = new Error(`Unknown key: ${spec}`);
	const match = /^((?:[a-z]+\+)*)(.+)$/i.exec(String(spec));
	if (!match) throw unknown;
	let modifiers = 0;
	for (const name of match[1].split("+").filter(Boolean)) {
		const bit = MODIFIERS[/** @type {keyof typeof MODIFIERS} */ (name.toLowerCase())];
		if (!bit) throw unknown;
		modifiers |= bit;
	}
	const base = match[2];
	const entry = [...base].length === 1 ? printable(base) : NAMED[base.toLowerCase()];
	if (!entry) throw unknown;
	let { key, text } = entry;
	if (modifiers & SHIFT && /^[a-z]$/.test(key)) {
		key = key.toUpperCase();
		text = key;
	}
	/** @type {{key: string, code: string, windowsVirtualKeyCode: number, modifiers: number, text?: string}} */
	const event = { key, code: entry.code, windowsVirtualKeyCode: entry.vk, modifiers };
	// Shortcuts such as Control+a must not also insert their character.
	if (text !== undefined && !(modifiers & ALT_CTRL_META)) event.text = text;
	return event;
}
