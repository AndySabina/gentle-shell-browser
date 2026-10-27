// Loads the real popup markup and script with a stub `chrome` object that
// answers the popup's requests with fake, anonymous state.
import { HELPER_MISSING } from "../../extension/lib/sessions.js";

const sessions = [
	{ id: "a1", name: "my-app", title: "Gentle · my-app", state: "connected" },
	{ id: "b2", name: "docs-site", title: "Gentle · docs-site", state: "connected" },
];

const SCENARIOS = {
	connected: { state: { helper: { state: "ok" }, enabled: true, sessions }, settings: { level: "always", rules: {} } },
	remember: {
		state: { helper: { state: "ok" }, enabled: true, sessions },
		settings: {
			level: "remember",
			rules: { "example.com": { click: "allow" }, "shop.example": { money: "deny" }, "docs.example": { type: "allow" } },
		},
	},
	never: { state: { helper: { state: "ok" }, enabled: true, sessions }, settings: { level: "never", rules: {} } },
	"helper-missing": {
		state: { helper: { state: "helper-missing", error: HELPER_MISSING }, enabled: true, sessions: [] },
		settings: { level: "always", rules: {} },
	},
};

const scenario = SCENARIOS[location.search.slice(1)] ?? SCENARIOS.connected;

globalThis.chrome = {
	runtime: {
		id: "gentle-shell-harness",
		async sendMessage(message) {
			if (message.type === "state") return { ok: true, result: scenario.state };
			if (message.type === "settings") return { ok: true, result: scenario.settings };
			return { ok: false, error: `The harness does not answer ${message.type}` };
		},
		onMessage: { addListener() {} },
		getURL: (path) => new URL(`../../extension/${path}`, import.meta.url).href,
		getManifest: () => ({ name: "Gentle Shell Browser", version: "0.0.0" }),
	},
};

// The real popup.html: its stylesheet and body, without its script (imported below, after the stub).
const request = new XMLHttpRequest();
request.open("GET", new URL("../../extension/popup.html", import.meta.url).href, false);
request.send();
const popup = new DOMParser().parseFromString(request.responseText, "text/html");
for (const node of popup.head.querySelectorAll('link[rel="stylesheet"]')) document.head.append(document.importNode(node, true));
for (const node of popup.body.childNodes) if (node.nodeName !== "SCRIPT") document.body.append(document.importNode(node, true));

await import("../../extension/popup.js");
