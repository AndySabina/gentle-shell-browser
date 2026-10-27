// Draws the real overlay (the expression the extension evaluates in a tab)
// with the cursor on the Subscribe button, as during a click.
import { overlayExpression } from "../../extension/lib/overlay.js";
import { WAITING_LABEL } from "../../extension/lib/policy.js";

// A still picture: end the glide at once instead of animating it.
const replaceSync = CSSStyleSheet.prototype.replaceSync;
CSSStyleSheet.prototype.replaceSync = function (text) {
	return replaceSync.call(this, `${text}\n.cursor, .highlight { transition: none !important; }`);
};

const button = /** @type {HTMLElement} */ (document.getElementById("subscribe"));
// The same label actions.js builds for a click on a named element.
const label = location.search === "?waiting" ? WAITING_LABEL : `Click · ${JSON.stringify(button.innerText)}`;

/** Glides the cursor onto the button; measured again whenever the layout changes. */
function draw() {
	const box = button.getBoundingClientRect();
	const rect = { left: box.left, top: box.top, width: box.width, height: box.height };
	const x = Math.round(box.left + box.width / 2);
	const y = Math.round(box.top + box.height / 2);
	// Indirect eval: the expression runs in the page's global scope, as through the debugger.
	return (0, eval)(overlayExpression("move", { x, y, label, rect }));
}

// Headless Chrome may resize the viewport after the first layout.
addEventListener("resize", () => void draw());
if (document.readyState !== "complete") await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
await document.fonts.ready;
await draw();
