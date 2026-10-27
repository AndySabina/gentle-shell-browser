// The ghost cursor the user watches: a page overlay drawn from our isolated
// world (the DOM is shared, so the user sees it) inside a closed shadow root.
// The user's real mouse is never moved. Only the STOP button takes clicks.

/** Binding the STOP button calls; the service worker gets `Runtime.bindingCalled`. */
export const STOP_BINDING = "__gentleShellStop";

/**
 * Runs inside the page. Self-contained: serialized with `.toString()`.
 * `ensure` builds the overlay if it is missing (a navigation removes it),
 * `move` glides the cursor to (x, y) — or keeps it in place when x/y are
 * null — shows the label and highlight, and resolves once the glide ended.
 * `clear` removes everything.
 * @param {"ensure" | "move" | "clear"} op
 * @param {{x?: number | null, y?: number | null, label?: string, rect?: {left: number, top: number, width: number, height: number} | null, binding?: string}} args
 */
function overlayPage(op, args) {
	const GLIDE_MS = 350;
	const ROSE = "#ff76c3";
	const BASE = "#1a1218";
	const TEXT = "#f6eff3";
	const RED = "#ff718f";
	// Pages cannot load the extension's bundled font, so use the brand fonts the user has installed.
	const FONT = '"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace';
	const g = /** @type {any} */ (globalThis);
	if (op === "clear") {
		g.__gentleOverlay?.host.remove();
		g.__gentleOverlay = undefined;
		return true;
	}

	/**
	 * @param {string} tag
	 * @param {string} className
	 * @param {ParentNode} parent
	 */
	const el = (tag, className, parent) => {
		const node = document.createElement(tag);
		node.className = className;
		parent.append(node);
		return node;
	};

	let ui = g.__gentleOverlay;
	if (!ui || !ui.host.isConnected) {
		ui?.host.remove();
		const host = document.createElement("gentle-shell-overlay");
		for (const [name, value] of Object.entries({ all: "initial", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none", display: "block" })) {
			host.style.setProperty(name, value, "important");
		}
		const root = host.attachShadow({ mode: "closed" });
		// Constructed sheets are not subject to the page's style-src CSP.
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(`
			* { box-sizing: border-box; pointer-events: none; }
			.frame { position: fixed; inset: 0; border: 2px solid ${ROSE}; }
			.banner { position: fixed; top: 0; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; padding: 4px 6px 5px 12px; border: 1px solid ${ROSE}; border-top: 0; border-radius: 0 0 8px 8px; background: ${BASE}; color: ${TEXT}; font: 700 12px/1.4 ${FONT}; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
			.banner button { pointer-events: auto; cursor: pointer; border: 0; border-radius: 8px; padding: 2px 10px; background: ${RED}; color: ${BASE}; font: 700 12px/1.4 ${FONT}; letter-spacing: .08em; }
			.highlight { position: fixed; display: none; border: 2px solid ${ROSE}; border-radius: 8px; background: rgba(255,118,195,.12); transition: all ${GLIDE_MS}ms ease; }
			.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; transition: transform ${GLIDE_MS}ms cubic-bezier(.2,.7,.2,1); will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
			.label { position: absolute; left: 20px; top: 22px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border-left: 3px solid ${ROSE}; border-radius: 8px; background: ${BASE}; color: ${TEXT}; font: 400 12px/1.4 ${FONT}; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
			.label.left { left: auto; right: 14px; }
			[hidden] { display: none !important; }
		`);
		root.adoptedStyleSheets = [sheet];
		el("div", "frame", root);
		const banner = el("div", "banner", root);
		const message = el("span", "", banner);
		message.textContent = "Gentle Shell is controlling this tab";
		const stop = el("button", "", banner);
		stop.textContent = "STOP";
		stop.addEventListener("click", (event) => {
			// Keep the click away from the page.
			event.preventDefault();
			event.stopPropagation();
			message.textContent = "Stopping…";
			try {
				g[String(args.binding)]?.("stop");
			} catch {
				// The debugger is already gone; nothing is controlling the tab.
			}
		});
		const highlight = el("div", "highlight", root);
		const cursor = el("div", "cursor", root);
		const SVG = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(SVG, "svg");
		for (const [name, value] of Object.entries({ width: "22", height: "22", viewBox: "0 0 22 22" })) svg.setAttribute(name, value);
		const arrow = document.createElementNS(SVG, "path");
		for (const [name, value] of Object.entries({ d: "M2 2 L2 19 L7 14.5 L10.5 21 L13.5 19.6 L10 13 L17 13 Z", fill: ROSE, stroke: BASE, "stroke-width": "1.5", "stroke-linejoin": "round" })) arrow.setAttribute(name, value);
		svg.append(arrow);
		cursor.append(svg);
		const label = el("div", "label", cursor);
		label.hidden = true;
		ui = { host, cursor, label, highlight, x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
		cursor.style.transform = `translate(${ui.x}px, ${ui.y}px)`;
		document.documentElement.append(host);
		// Commit the start position so the first move glides instead of jumping.
		cursor.getBoundingClientRect();
		g.__gentleOverlay = ui;
	}
	if (op === "ensure") return true;

	const rect = args.rect;
	if (rect) {
		Object.assign(ui.highlight.style, { display: "block", left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
	} else ui.highlight.style.display = "none";

	const moving = typeof args.x === "number" && typeof args.y === "number" && (Math.abs(args.x - ui.x) > 0.5 || Math.abs(args.y - ui.y) > 0.5);
	if (moving) {
		ui.x = /** @type {number} */ (args.x);
		ui.y = /** @type {number} */ (args.y);
		ui.cursor.style.transform = `translate(${ui.x}px, ${ui.y}px)`;
	}
	ui.label.textContent = String(args.label ?? "");
	ui.label.hidden = !args.label;
	ui.label.classList.toggle("left", ui.x > window.innerWidth - 240);
	return new Promise((resolve) => setTimeout(() => resolve(true), moving ? GLIDE_MS + 30 : 0));
}

/**
 * @param {"ensure" | "move" | "clear"} op
 * @param {object} [args]
 */
export function overlayExpression(op, args = {}) {
	return `(${overlayPage.toString()})(${JSON.stringify(op)}, ${JSON.stringify({ ...args, binding: STOP_BINDING })})`;
}

/** Draws the overlay in a tab through the debugger's isolated world. */
export class Overlay {
	/** @param {{evaluate: (tabId: number, expression: string) => Promise<any>}} cdp */
	constructor(cdp) {
		this.cdp = cdp;
	}

	/**
	 * Glides the cursor to (x, y) (null keeps it in place) and resolves when it arrived.
	 * @param {number} tabId
	 * @param {number | null} x
	 * @param {number | null} y
	 * @param {string} label
	 * @param {{left: number, top: number, width: number, height: number}} [rect]
	 */
	move(tabId, x, y, label, rect) {
		return this.cdp.evaluate(tabId, overlayExpression("move", { x, y, label, rect: rect ?? null }));
	}

	/** @param {number} tabId */
	async clear(tabId) {
		await this.cdp.evaluate(tabId, overlayExpression("clear")).catch(() => {});
	}
}
