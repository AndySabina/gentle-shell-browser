// Scripts that run inside the page (main frame, isolated world). Each function
// must be self-contained: it is serialized with `.toString()` and evaluated
// through CDP, so it cannot use anything from this module's scope.

/**
 * Builds the snapshot the model reads. Refs (`e<N>`) stay stable for an
 * element while the document lives, and `globalThis.__gentleRefs` maps each
 * ref of the latest snapshot to its element.
 *
 * By default it covers the viewport only: elements whose box intersects it
 * (at most 80; `offscreen` counts the visible ones left out) and the text of
 * text nodes whose parent element intersects it (at most 1500 characters).
 * With `full` it covers the whole page: 300 elements, offscreen ones included,
 * and the body's innerText up to 6000 characters.
 * @param {{ full?: boolean }} [options]
 */
function snapshotPage(options) {
	const full = options?.full === true;
	const MAX_ELEMENTS = full ? 300 : 80;
	const MAX_TEXT = full ? 6000 : 1500;
	const MAX_NAME = 80;
	const SELECTOR = [
		"a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable]:not([contenteditable=false])", "[tabindex]",
		...["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "textbox", "combobox"].map((role) => `[role=${role}]`),
	].join(",");
	const g = /** @type {any} */ (globalThis);
	g.__gentleIds ??= new WeakMap();
	g.__gentleNext ??= 1;
	/** @type {Map<string, Element>} */
	const refs = new Map();
	g.__gentleRefs = refs;

	const collapse = (/** @type {unknown} */ text) => String(text ?? "").replace(/\s+/g, " ").trim();
	const clip = (/** @type {string} */ text, /** @type {number} */ max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

	/** @param {Element} el */
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.split(/\s+/)[0];
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			const type = /** @type {HTMLInputElement} */ (el).type;
			if (type === "checkbox" || type === "radio") return type;
			if (["button", "submit", "reset", "image"].includes(type)) return "button";
			if (type === "range") return "slider";
			return "textbox";
		}
		if (/** @type {HTMLElement} */ (el).isContentEditable) return "textbox";
		return tag;
	};

	/** @param {Element} el */
	const nameOf = (el) => {
		const html = /** @type {HTMLInputElement} */ (el);
		const labelledBy = el.getAttribute("aria-labelledby");
		const candidates = [
			el.getAttribute("aria-label"),
			labelledBy && labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "),
			html.labels && [...html.labels].map((label) => label.innerText).join(" "),
			el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA" && /** @type {HTMLElement} */ (el).innerText,
			el.getAttribute("placeholder"),
			el.getAttribute("alt") ?? el.querySelector("img[alt]")?.getAttribute("alt"),
			el.getAttribute("title"),
			el.tagName === "INPUT" && ["button", "submit", "reset"].includes(html.type) && html.value,
		];
		for (const candidate of candidates) {
			const text = collapse(candidate || "");
			if (text) return clip(text, MAX_NAME);
		}
		return "";
	};

	/** @param {Element} el */
	const visibleBox = (el) => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return undefined;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return undefined;
		return rect;
	};

	const width = window.innerWidth;
	const height = window.innerHeight;
	const inView = (/** @type {DOMRect} */ rect) => rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
	const elements = [];
	let omitted = 0;
	let offscreen = 0;
	for (const el of document.querySelectorAll(SELECTOR)) {
		const rect = visibleBox(el);
		if (!rect) continue;
		if (!full && !inView(rect)) {
			offscreen++;
			continue;
		}
		if (elements.length >= MAX_ELEMENTS) {
			omitted++;
			continue;
		}
		let id = g.__gentleIds.get(el);
		if (!id) {
			id = `e${g.__gentleNext++}`;
			g.__gentleIds.set(el, id);
		}
		refs.set(id, el);
		const input = /** @type {HTMLInputElement} */ (el);
		const role = roleOf(el);
		/** @type {Record<string, unknown>} */
		const entry = { ref: id, role, name: nameOf(el) };
		if (el.tagName === "INPUT") entry.type = input.type;
		if (el.tagName === "A") entry.href = /** @type {HTMLAnchorElement} */ (el).href;
		if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !["checkbox", "radio", "button", "submit", "reset", "image"].includes(input.type)) {
			entry.value = input.type === "password" ? (input.value ? "••••" : "") : clip(String(input.value ?? ""), MAX_NAME);
		}
		const ariaChecked = el.getAttribute("aria-checked");
		if (input.checked === true || ariaChecked === "true") entry.checked = true;
		if (/** @type {HTMLButtonElement} */ (el).disabled === true || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
		const x = Math.round(rect.left + rect.width / 2);
		const y = Math.round(rect.top + rect.height / 2);
		if (x < 0 || y < 0 || x > width || y > height) entry.offscreen = true;
		entry.x = x;
		entry.y = y;
		elements.push(entry);
	}

	/** Text of the text nodes whose parent element is visible and intersects the viewport. */
	const viewportText = () => {
		if (!document.body) return "";
		/** @type {Map<Element, boolean>} */
		const shown = new Map();
		const parts = [];
		let length = 0;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node && length <= MAX_TEXT; node = walker.nextNode()) {
			const value = collapse(node.nodeValue);
			const parent = node.parentElement;
			if (!value || !parent) continue;
			if (!shown.has(parent)) {
				const rect = visibleBox(parent);
				shown.set(parent, !!rect && inView(rect));
			}
			if (!shown.get(parent)) continue;
			parts.push(value);
			length += value.length + 1;
		}
		return parts.join(" ");
	};

	return {
		url: location.href,
		title: document.title,
		viewport: { width, height, scrollY: Math.round(window.scrollY) },
		elements,
		omitted,
		offscreen,
		iframes: document.querySelectorAll("iframe, frame").length,
		text: clip(full ? collapse(document.body?.innerText ?? "") : viewportText(), MAX_TEXT),
	};
}

/**
 * Scrolls the element behind `ref` into view and returns its current center
 * and box in CSS pixels plus a short name for the cursor label. Returns null
 * when the ref is unknown or the element left the page.
 * @param {string} ref
 */
function resolveRef(ref) {
	const el = /** @type {Map<string, Element> | undefined} */ (/** @type {any} */ (globalThis).__gentleRefs)?.get(ref);
	if (!el || !el.isConnected) return null;
	el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	const rect = el.getBoundingClientRect();
	const html = /** @type {HTMLInputElement} */ (el);
	const label = html.labels?.[0]?.innerText;
	const raw = el.getAttribute("aria-label") || label || (/** @type {HTMLElement} */ (el).innerText ?? "") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
	const name = raw.replace(/\s+/g, " ").trim();
	return {
		x: Math.round(rect.left + rect.width / 2),
		y: Math.round(rect.top + rect.height / 2),
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
		name: name.length > 40 ? `${name.slice(0, 39)}…` : name,
	};
}

/**
 * Risk signals of the main frame for the policy (pageRiskFromSignals):
 * visible inputs, names of visible form submit controls, addresses of visible
 * frames, and the title and headings. Hidden elements do not count: payment
 * libraries often load invisible frames on ordinary pages.
 */
function pageRisk() {
	const MAX = 100;
	const clip = (/** @type {unknown} */ text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
	/** @param {Element} el */
	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== "hidden" && style.display !== "none";
	};
	/** @param {string} selector */
	const shown = (selector) => [...document.querySelectorAll(selector)].filter(visible).slice(0, MAX);
	const fields = shown("input").map((el) => {
		const input = /** @type {HTMLInputElement} */ (el);
		return {
			type: input.type,
			autocomplete: el.getAttribute("autocomplete") ?? "",
			name: el.getAttribute("name") ?? "",
			id: el.id,
			label: clip(el.getAttribute("aria-label") || input.labels?.[0]?.innerText || ""),
		};
	});
	const submits = shown("form button, form input[type=submit], form input[type=image]")
		.filter((el) => el.tagName !== "BUTTON" || (el.getAttribute("type") ?? "submit").toLowerCase() === "submit")
		.map((el) => clip(el.getAttribute("aria-label") || /** @type {HTMLElement} */ (el).innerText || /** @type {HTMLInputElement} */ (el).value || el.getAttribute("title") || ""))
		.filter(Boolean);
	const frames = shown("iframe[src], frame[src]").map((el) => /** @type {HTMLIFrameElement} */ (el).src);
	const headings = [document.title, ...shown("h1, h2, h3, [role=heading]").map((el) => /** @type {HTMLElement} */ (el).innerText)].map(clip).filter(Boolean);
	return { fields, submits, frames, headings };
}

/** URL, title, viewport size and scroll position of the page. */
function pageInfo() {
	return {
		url: location.href,
		title: document.title,
		width: window.innerWidth,
		height: window.innerHeight,
		scrollX: Math.round(window.scrollX),
		scrollY: Math.round(window.scrollY),
	};
}

/**
 * Expression for Debugger.evaluate that returns the page snapshot: the
 * viewport by default, the whole page with `full`.
 * @param {{ full?: boolean }} [options]
 */
export function snapshotExpression(options = {}) {
	return `(${snapshotPage.toString()})(${JSON.stringify({ full: options.full === true })})`;
}

/**
 * Expression for Debugger.evaluate that scrolls `ref` into view and returns
 * its center, box and name, or null when the ref is stale or unknown.
 * @param {string} ref
 */
export function resolveRefExpression(ref) {
	return `(${resolveRef.toString()})(${JSON.stringify(String(ref))})`;
}

/** Expression for Debugger.evaluate that returns the page risk signals. */
export function pageRiskExpression() {
	return `(${pageRisk.toString()})()`;
}

/** Expression for Debugger.evaluate that returns the page URL, title and viewport. */
export function pageInfoExpression() {
	return `(${pageInfo.toString()})()`;
}
