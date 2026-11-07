import { CATEGORY_LABELS } from "./lib/policy.js";

const $ = (id) => document.getElementById(id);
const NEVER_WARNING =
	"Switch to Never ask?\n\nNothing will ask for your approval anymore: the agent does whatever it is told, payments and deletions included. Only the session's tab group and STOP limit it.";

/** The overall pill: the helper first, then how many sessions are connected. */
const HELPER_LABELS = {
	unknown: "Looking for Gentle Shell…",
	"helper-missing": "Helper not installed",
	invalid: "Helper error",
};

/** A session's connection state, in words; untrusted and unauthorized stop retrying until the switch is turned Off and On. */
const SESSION_LABELS = {
	connected: "connected",
	connecting: "connecting…",
	waiting: "retrying…",
	off: "off",
	replaced: "taken by another Chrome",
	unauthorized: "refused: turn Off and On",
	untrusted: "untrusted: turn Off and On",
};

async function send(type, extra = {}) {
	const response = await chrome.runtime.sendMessage({ type, ...extra });
	if (!response?.ok) throw new Error(response?.error ?? "No answer from the extension");
	return response.result;
}

function showError(error) {
	$("error").hidden = !error;
	$("error").textContent = error ? String(error.message ?? error) : "";
}

/** Only picks the pill's color: connected, waiting, problem or off. */
function pillState(state, connected) {
	if (state.helper.state === "unknown") return "waiting";
	if (state.helper.state !== "ok") return "problem";
	if (!state.enabled) return "off";
	if (connected > 0) return "connected";
	return state.sessions.some((session) => session.state === "untrusted" || session.state === "unauthorized") ? "problem" : "waiting";
}

function render(state) {
	const connected = state.sessions.filter((session) => session.state === "connected").length;
	const pill = state.helper.state !== "ok" ? HELPER_LABELS[state.helper.state] ?? state.helper.state : !state.enabled ? "Off" : connected > 0 ? `Connected (${connected})` : "Waiting for Gentle Shell…";
	$("status").textContent = pill;
	$("status").dataset.state = pillState(state, connected);
	$("helper").hidden = !state.helper.error;
	$("helper").textContent = state.helper.error ?? "";
	$("enabled").checked = state.enabled;
	$("no-sessions").hidden = state.helper.state !== "ok" || state.sessions.length > 0;
	// Each session's own state, so a session that stopped retrying is visible.
	$("session-list").replaceChildren(
		...state.sessions.map((session) => {
			const item = document.createElement("li");
			const text = document.createElement("span");
			text.className = "rule-text";
			text.textContent = session.name;
			const tag = document.createElement("span");
			tag.className = "tag";
			tag.textContent = SESSION_LABELS[session.state] ?? session.state;
			item.dataset.state = session.state;
			item.append(text, tag);
			return item;
		}),
	);
	$("stop").hidden = connected === 0;
}

async function run(action) {
	showError(undefined);
	try {
		render(await action());
	} catch (error) {
		showError(error);
	}
}

$("enabled").addEventListener("change", () => run(() => send("setEnabled", { enabled: $("enabled").checked })));
$("stop").addEventListener("click", () => run(() => send("stop")));

function renderSettings(settings) {
	for (const input of document.querySelectorAll('input[name="level"]')) input.checked = input.value === settings.level;
	// Saved decisions are used only in remember mode, so they are shown only there.
	$("rules").hidden = settings.level !== "remember";
	const rules = Object.entries(settings.rules).sort(([a], [b]) => a.localeCompare(b));
	$("rule-list").replaceChildren(
		...rules.flatMap(([site, decisions]) =>
			Object.entries(decisions).map(([category, decision]) => {
				const item = document.createElement("li");
				const text = document.createElement("span");
				text.className = "rule-text";
				text.textContent = `${site} — ${CATEGORY_LABELS[category] ?? category}`;
				const tag = document.createElement("span");
				tag.className = "tag";
				tag.textContent = decision;
				item.dataset.decision = decision;
				const remove = document.createElement("button");
				remove.className = "secondary remove";
				remove.textContent = "Remove";
				remove.title = `Forget ${decision} for ${CATEGORY_LABELS[category] ?? category} on ${site}`;
				remove.addEventListener("click", () => changeSettings(() => send("removeRule", { site, category })));
				item.append(text, tag, remove);
				return item;
			}),
		),
	);
	$("no-rules").hidden = rules.length > 0;
	$("clear-rules").hidden = rules.length === 0;
}

async function changeSettings(action) {
	showError(undefined);
	try {
		renderSettings(await action());
	} catch (error) {
		showError(error);
	}
}

for (const input of document.querySelectorAll('input[name="level"]')) {
	input.addEventListener("change", () => {
		// Never ask removes every prompt: the user confirms first, or the mode stays as it was.
		if (input.value === "never" && !confirm(NEVER_WARNING)) return void changeSettings(() => send("settings"));
		void changeSettings(() => send("setLevel", { level: input.value }));
	});
}
$("clear-rules").addEventListener("click", () => {
	if (confirm("Clear every saved decision? Remember mode will ask again for every site and action type.")) void changeSettings(() => send("clearRules"));
});
const WATCH_WARNING = (name) =>
	`Switch the WhatsApp watch on for "${name}"?\n\nA new message from a chat on the list will start that session on its own, and it will answer in that chat without asking you first. Replies still follow the permission mode.`;

function renderWatch(view) {
	$("watch-sessions").replaceChildren(
		...view.sessions.map((session) => {
			const label = document.createElement("label");
			label.className = "switch";
			const input = document.createElement("input");
			input.type = "checkbox";
			input.checked = session.on;
			input.addEventListener("change", () => {
				// Answering on its own writes to other people: the user confirms first.
				if (input.checked && !confirm(WATCH_WARNING(session.name))) return void changeWatch(() => send("watchState"));
				void changeWatch(() => send("setWatch", { sessionId: session.id, on: input.checked }));
			});
			const text = document.createElement("span");
			text.textContent = `Answer new messages · ${session.name}`;
			label.append(input, text);
			return label;
		}),
	);
	$("no-watch").hidden = view.sessions.length > 0;
	$("allow-list").replaceChildren(
		...view.allowed.map((chat) => {
			const item = document.createElement("li");
			const text = document.createElement("span");
			text.className = "rule-text";
			text.textContent = chat;
			const remove = document.createElement("button");
			remove.className = "secondary remove";
			remove.textContent = "Remove";
			remove.title = `Stop answering ${chat}`;
			remove.addEventListener("click", () => changeWatch(() => send("removeChat", { chat })));
			item.append(text, remove);
			return item;
		}),
	);
	$("no-allowed").hidden = view.allowed.length > 0;
}

async function changeWatch(action) {
	showError(undefined);
	try {
		renderWatch(await action());
	} catch (error) {
		showError(error);
	}
}

$("allow-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const chat = $("allow-name").value;
	void changeWatch(async () => {
		const view = await send("allowChat", { chat });
		$("allow-name").value = "";
		return view;
	});
});

chrome.runtime.onMessage.addListener((message) => {
	if (message?.type === "state-changed") {
		void run(() => send("state"));
		void changeWatch(() => send("watchState"));
	}
	if (message?.type === "watch-changed") void changeWatch(() => send("watchState"));
});

void run(() => send("state"));
void changeSettings(() => send("settings"));
void changeWatch(() => send("watchState"));
