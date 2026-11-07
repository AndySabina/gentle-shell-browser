// The WhatsApp watch: a doorbell that tells a Gentle Shell session about new
// messages in its WhatsApp Web tab. The content script (whatsapp.js) only
// reads the chat list; this module decides. A session hears about a chat only
// while the user has switched its watch on, only for chats on the user's allow
// list, and once per new message. Unread messages already there when the
// watch is switched on, or when a tab's chat list first shows, do not ring.

export const ALLOW_KEY = "whatsappAllow";
export const WATCH_KEY = "whatsappWatch";
/** Only WhatsApp Web itself; a look-alike host does not match. */
export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const WHATSAPP_URL = `${WHATSAPP_ORIGIN}/`;
const MAX_ROWS = 100;
const MAX_TEXT = 300;
const MAX_NAME = 100;
const MAX_ALLOWED = 100;

/**
 * @typedef {{name: string, preview: string, unread: number, ambiguous?: true}} Chat `ambiguous`: another row has the same name
 * @typedef {{get: (keys: Record<string, unknown>) => Promise<Record<string, any>>, set: (items: Record<string, unknown>) => Promise<void>}} Storage
 * @typedef {{
 *   id: string,
 *   name: string,
 *   group: {tabs: () => Promise<{tabId: number, url: string}[]>, contains: (tabId: number) => Promise<boolean>, openTab?: (url: string) => Promise<{tabId: number}>},
 *   connection?: {state: string, call: (method: string, params: unknown) => Promise<unknown>},
 * }} WatchSession
 * @typedef {{
 *   local: Storage,
 *   session: Storage,
 *   sessions: {live: () => WatchSession[]},
 *   read: (tabId: number) => Promise<unknown[] | undefined>,
 *   stop?: (tabId: number) => Promise<unknown>,
 *   ready?: () => Promise<unknown>,
 *   changed?: () => void,
 * }} WatchDeps `changed` tells open popups after the switch or the allow list changes
 */

/** @param {string} url */
export function isWhatsAppUrl(url) {
	try {
		return new URL(url).origin === WHATSAPP_ORIGIN;
	} catch {
		return false;
	}
}

/** @param {unknown} text */
const clean = (text) =>
	String(text)
		// Control characters and the direction marks WhatsApp wraps text in.
		.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * How chat names compare: case, Unicode form and spacing do not count.
 * @param {string} name
 */
export function chatKey(name) {
	return clean(name).normalize("NFC").toLowerCase();
}

/**
 * A chat name for the allow list, as the user wrote it.
 * @param {unknown} name
 */
export function cleanChatName(name) {
	const cleaned = typeof name === "string" ? clean(name) : "";
	if (!cleaned || cleaned.length > MAX_NAME) throw new Error(`Give a chat name of 1 to ${MAX_NAME} characters, as WhatsApp shows it.`);
	return cleaned;
}

/**
 * The content script's raw rows, `{titles, badges}`: the first title is the
 * chat's name, the last its last message; a numeric badge is the unread count.
 * Anything else is skipped. The first row of a name wins and is marked
 * ambiguous when another row has that name: then nothing tells which chat it is.
 * @param {unknown} rows
 * @returns {Chat[]}
 */
export function parseRows(rows) {
	if (!Array.isArray(rows)) return [];
	/** @type {Map<string, Chat>} */
	const seen = new Map();
	/** @type {Chat[]} */
	const chats = [];
	for (const raw of rows.slice(0, MAX_ROWS)) {
		if (!raw || typeof raw !== "object") continue;
		const { titles, badges } = /** @type {{titles?: unknown, badges?: unknown}} */ (raw);
		if (!Array.isArray(titles) || !Array.isArray(badges)) continue;
		const texts = titles.filter((title) => typeof title === "string").map(clean).filter(Boolean);
		const name = texts[0]?.slice(0, MAX_NAME);
		if (!name) continue;
		const first = seen.get(chatKey(name));
		if (first) {
			first.ambiguous = true;
			continue;
		}
		const badge = badges.find((text) => typeof text === "string" && /^\d{1,4}$/.test(text.trim()));
		/** @type {Chat} */
		const chat = { name, preview: texts.length > 1 ? texts[texts.length - 1].slice(0, MAX_TEXT) : "", unread: badge === undefined ? 0 : Number(badge) };
		seen.set(chatKey(name), chat);
		chats.push(chat);
	}
	return chats;
}

/** What WhatsApp shows in place of the last message while someone types or records. */
const TYPING = /^(?:.+ )?(?:is typing|está escribiendo|typing|escribiendo|recording audio|grabando audio)…$/i;

/**
 * A typing status is not a message: such a report does not count, so the
 * message rings once, when its text shows.
 * @param {Chat} chat
 */
export const isTyping = (chat) => TYPING.test(chat.preview);

/** @param {Chat} chat a new message raises the unread count */
const signature = (chat) => (chat.unread > 0 ? String(chat.unread) : "read");

/** How many already handled messages each chat remembers. */
const MAX_KNOWN = 20;

export class WhatsAppWatch {
	/** @param {WatchDeps} deps */
	constructor(deps) {
		this.deps = deps;
		/** @type {Map<number, Map<string, string>>} per tab, what each chat looked like at the last report */
		this.seen = new Map();
		/**
		 * Per chat, the last messages that rang or were unread when the watch
		 * started: WhatsApp can show one unread again after the agent read it,
		 * and that must not ring twice.
		 * @type {Map<string, string[]>}
		 */
		this.known = new Map();
		/** @type {Map<string, {lastRead?: {at: string, chats: number, allowed: {name: string, unread: number, typing?: boolean, ambiguous?: boolean}[]}, lastRing?: {chat: string, at: string, delivered: boolean, error?: string}}>} */
		this.diagnostics = new Map();
		/** @type {Promise<unknown>} allow-list changes run one at a time */
		this.writing = Promise.resolve();
	}

	/** @returns {Promise<string[]>} */
	async allowList() {
		const stored = (await this.deps.local.get({ [ALLOW_KEY]: [] }))[ALLOW_KEY];
		return Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [];
	}

	/**
	 * @param {(allowed: string[]) => string[]} change
	 * @returns {Promise<{allowed: string[]}>}
	 */
	changeAllowList(change) {
		const write = this.writing.then(async () => {
			const allowed = change(await this.allowList());
			await this.deps.local.set({ [ALLOW_KEY]: allowed });
			this.deps.changed?.();
			return { allowed };
		});
		this.writing = write.catch(() => {});
		return write;
	}

	/** @param {unknown} name */
	async allow(name) {
		const chat = cleanChatName(name);
		return this.changeAllowList((allowed) => {
			if (allowed.some((entry) => chatKey(entry) === chatKey(chat))) return allowed;
			if (allowed.length >= MAX_ALLOWED) throw new Error(`The allow list holds at most ${MAX_ALLOWED} chats.`);
			return [...allowed, chat];
		});
	}

	/** @param {unknown} name */
	async remove(name) {
		const chat = cleanChatName(name);
		return this.changeAllowList((allowed) => {
			const kept = allowed.filter((entry) => chatKey(entry) !== chatKey(chat));
			if (kept.length === allowed.length) throw new Error(`"${chat}" is not on the allow list.`);
			return kept;
		});
	}

	/** @returns {Promise<Record<string, boolean>>} */
	async watched() {
		const stored = (await this.deps.session.get({ [WATCH_KEY]: {} }))[WATCH_KEY];
		return stored && typeof stored === "object" ? stored : {};
	}

	/** @param {string} id */
	async watching(id) {
		return (await this.watched())[id] === true;
	}

	/** @param {WatchSession} session */
	async whatsappTabs(session) {
		return (await session.group.tabs()).filter((tab) => isWhatsAppUrl(tab.url)).map((tab) => tab.tabId);
	}

	/** @param {WatchSession} session */
	async state(session) {
		return { on: await this.watching(session.id), allowed: await this.allowList(), whatsappTabs: (await this.whatsappTabs(session)).length, ...this.diagnostics.get(session.id) };
	}

	/**
	 * Switches `session`'s watch. On, it reads its WhatsApp tabs first, so the
	 * unread messages already there count as seen, and opens WhatsApp Web in
	 * the session's group when it has none; Gentle Shell hears of the change.
	 * @param {WatchSession} session
	 * @param {boolean} on
	 */
	async setWatch(session, on) {
		const watched = { ...(await this.watched()) };
		let missing = false;
		if (on) {
			const tabs = await this.whatsappTabs(session);
			for (const tabId of tabs) await this.readBaseline(session, tabId);
			missing = tabs.length === 0;
			watched[session.id] = true;
		} else {
			delete watched[session.id];
			// Off means nothing reads the chats: the reader leaves the tabs.
			for (const tabId of await this.whatsappTabs(session)) {
				this.seen.delete(tabId);
				await this.deps.stop?.(tabId).catch(() => {});
			}
		}
		await this.deps.session.set({ [WATCH_KEY]: watched });
		// Opened once the switch is stored, so its first load finds the watch on.
		/** @type {{openedWhatsApp?: true, openWhatsAppError?: string}} */
		let opening = {};
		if (missing && session.group.openTab) {
			// The watch is on either way: a tab Chrome refused is reported, not thrown.
			opening = await session.group
				.openTab(WHATSAPP_URL)
				.then(() => ({ openedWhatsApp: /** @type {const} */ (true) }))
				.catch((error) => ({ openWhatsAppError: error instanceof Error ? error.message : String(error) }));
		}
		this.deps.changed?.();
		await session.connection?.call("watchChanged", { on }).catch(() => {});
		return { ...(await this.state(session)), ...opening };
	}

	/**
	 * Reads `tabId`'s chat list now, so the unread messages it shows count as
	 * seen. A list with no chats (WhatsApp Web still loading) is no baseline:
	 * the first report with chats becomes it.
	 * @param {WatchSession} session
	 * @param {number} tabId
	 */
	async readBaseline(session, tabId) {
		this.seen.delete(tabId);
		const rows = await this.deps.read(tabId).catch(() => undefined);
		if (!rows) return;
		const chats = parseRows(rows);
		if (chats.length > 0) this.baseline(tabId, chats, true);
		await this.noteRead(session.id, chats);
	}

	/**
	 * @param {number} tabId
	 * @param {Chat[]} chats
	 * @param {boolean} [settled] the unread messages shown count as handled
	 */
	baseline(tabId, chats, settled = false) {
		this.seen.set(tabId, new Map(chats.map((chat) => [chatKey(chat.name), signature(chat)])));
		if (!settled) return;
		for (const chat of chats) if (chat.unread > 0 && !isTyping(chat)) this.remember(chat);
	}

	/** @param {Chat} chat */
	remember(chat) {
		const key = chatKey(chat.name);
		const known = (this.known.get(key) ?? []).filter((preview) => preview !== chat.preview);
		known.push(chat.preview);
		this.known.set(key, known.slice(-MAX_KNOWN));
	}

	/** @param {Chat} chat */
	isKnown(chat) {
		return this.known.get(chatKey(chat.name))?.includes(chat.preview) ?? false;
	}

	/**
	 * A WhatsApp Web tab finished loading or joined a group: a page load drops
	 * the reader, so a watching session's tab gets it again, and what is unread
	 * now counts as seen.
	 * @param {number} tabId
	 * @param {string} url
	 */
	async tabLoaded(tabId, url) {
		await this.deps.ready?.();
		if (!isWhatsAppUrl(url)) return;
		const owner = await this.ownerOf(tabId);
		if (!owner || !(await this.watching(owner.id))) return;
		await this.readBaseline(owner, tabId);
	}

	/**
	 * Remembers what the last read of `id`'s chat list showed, for /browser watch.
	 * @param {string} id
	 * @param {Chat[]} chats
	 */
	async noteRead(id, chats) {
		const allowed = new Set((await this.allowList()).map(chatKey));
		const diagnostics = this.diagnostics.get(id) ?? {};
		diagnostics.lastRead = {
			at: new Date().toISOString(),
			chats: chats.length,
			allowed: chats.filter((chat) => allowed.has(chatKey(chat.name))).map((chat) => ({ name: chat.name, unread: chat.unread, ...(isTyping(chat) ? { typing: true } : {}), ...(chat.ambiguous ? { ambiguous: true } : {}) })),
		};
		this.diagnostics.set(id, diagnostics);
		return diagnostics;
	}

	/** @param {number} tabId */
	async ownerOf(tabId) {
		for (const session of this.deps.sessions.live()) if (await session.group.contains(tabId)) return session;
		return undefined;
	}

	/** The sessions whose group holds a WhatsApp Web tab, for the popup. */
	async watchSessions() {
		const list = [];
		for (const session of this.deps.sessions.live()) {
			if ((await this.whatsappTabs(session)).length > 0) list.push({ id: session.id, name: session.name, on: await this.watching(session.id) });
		}
		return list;
	}

	/**
	 * The content script read the chat list of `tabId`. Each allowed chat with
	 * a new unread message rings the session whose group holds the tab.
	 * @param {number} tabId
	 * @param {unknown} rows
	 */
	async report(tabId, rows) {
		await this.deps.ready?.();
		const owner = await this.ownerOf(tabId);
		if (!owner || !(await this.watching(owner.id))) return;
		const chats = parseRows(rows);
		const allowed = new Set((await this.allowList()).map(chatKey));
		const diagnostics = await this.noteRead(owner.id, chats);
		const before = this.seen.get(tabId);
		// No chats yet (WhatsApp Web still loading) is no baseline either.
		if (!before && chats.length === 0) return;
		this.baseline(tabId, chats, !before);
		// A chat showing a typing status keeps what it looked like before.
		const seen = /** @type {Map<string, string>} */ (this.seen.get(tabId));
		for (const chat of chats) {
			if (!isTyping(chat)) continue;
			const previous = before?.get(chatKey(chat.name));
			if (previous === undefined) seen.delete(chatKey(chat.name));
			else seen.set(chatKey(chat.name), previous);
		}
		// No baseline (the worker restarted): this report is the baseline.
		if (!before) return;
		for (const chat of chats) {
			const key = chatKey(chat.name);
			// Two chats with an allowed name: either could be someone else's, so neither rings.
			if (chat.unread === 0 || chat.ambiguous || isTyping(chat) || !allowed.has(key) || before.get(key) === signature(chat)) continue;
			// A count that rose from a nonzero count means new messages, whatever their text.
			const previous = Number(before.get(key));
			const rose = previous > 0 && chat.unread > previous;
			// A message that already rang, shown unread again after the chat was read, is not new.
			if (!rose && this.isKnown(chat)) continue;
			/** @type {{chat: string, at: string, delivered: boolean, error?: string}} */
			const ring = { chat: chat.name, at: new Date().toISOString(), delivered: false };
			try {
				if (!owner.connection) throw new Error("Session is not connected");
				await owner.connection.call("whatsappMessage", { chat: chat.name, unread: chat.unread, preview: chat.preview, tabId });
				ring.delivered = true;
				delete ring.error;
				this.remember(chat);
			} catch (error) {
				ring.error = error instanceof Error ? error.message : String(error);
			}
			diagnostics.lastRing = ring;
		}
	}
}

/**
 * The popup's requests for the watch; each change answers with the new view.
 * @param {WhatsAppWatch} watch
 */
export function watchPopup(watch) {
	const view = async () => ({ sessions: await watch.watchSessions(), allowed: await watch.allowList() });
	/** @param {() => Promise<unknown>} change */
	const after = async (change) => {
		await change();
		return view();
	};
	return {
		watchState: view,
		/** @param {{sessionId?: unknown, on?: unknown}} message */
		setWatch: (message) =>
			after(async () => {
				const session = watch.deps.sessions.live().find((live) => live.id === message.sessionId);
				if (!session) throw new Error("That Gentle Shell session is gone.");
				await watch.setWatch(session, message.on === true);
			}),
		/** @param {{chat?: unknown}} message */
		allowChat: (message) => after(() => watch.allow(message.chat)),
		/** @param {{chat?: unknown}} message */
		removeChat: (message) => after(() => watch.remove(message.chat)),
	};
}
