// Injected into a WhatsApp Web tab while its session's watch is on (see
// lib/whatsapp.js). It only reads the chat list: for each chat its titles
// (name first, last message last) and short badge texts (the unread count),
// and sends them to the worker when they change. It decides nothing, sends
// nothing anywhere else and never changes the page. Each injection replaces
// the previous reader and returns the chat list right now.
// Switching the watch off calls its stop function, which removes it.

(() => {
	const INSTALLED = "__gentleShellWhatsAppWatch";
	const STOP = "__gentleShellWhatsAppWatchStop";
	const MAX_ROWS = 100;
	const DEBOUNCE_MS = 1000;

	function read() {
		const pane = document.querySelector("#pane-side");
		if (!pane) return [];
		const rows = [...pane.querySelectorAll('[role="listitem"], [role="row"]')];
		// A row inside another row is the same chat.
		return rows
			.filter((row) => !rows.some((other) => other !== row && other.contains(row)))
			.slice(0, MAX_ROWS)
			.map((row) => ({
				titles: [...row.querySelectorAll("span[title]")].map((span) => span.getAttribute("title") ?? ""),
				badges: [...row.querySelectorAll("[aria-label]")].map((element) => (element.textContent ?? "").trim()).filter((text) => text.length > 0 && text.length <= 4),
			}));
	}

	globalThis[STOP]?.();
	{
		globalThis[INSTALLED] = true;
		let last = JSON.stringify(read());
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		const observer = new MutationObserver(() => {
			if (timer === undefined) timer = setTimeout(send, DEBOUNCE_MS);
		});
		function send() {
			timer = undefined;
			const rows = read();
			const text = JSON.stringify(rows);
			if (text === last) return;
			last = text;
			try {
				// After the extension reloads this copy is orphaned: it stops, and the new one is injected.
				if (!chrome.runtime?.id) throw new Error("extension reloaded");
				void chrome.runtime.sendMessage({ type: "whatsapp-chats", rows }).catch(() => {});
			} catch {
				observer.disconnect();
			}
		}
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		// The watch went off: stop reading; switching it on again installs a new reader.
		globalThis[STOP] = () => {
			observer.disconnect();
			clearTimeout(timer);
			delete globalThis[INSTALLED];
			delete globalThis[STOP];
		};
	}
	return read();
})();
