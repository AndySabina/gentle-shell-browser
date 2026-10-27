// A Gentle Shell tab group: the only tabs a session may read or act on.
// The user grants a tab by dragging it into the group and revokes it by
// dragging it out; every tab-scoped request must pass `requireTab` first.
// Each session has its own instance, title and stored id (sessions.js); the
// defaults are the single "Gentle Shell" group.

export const GROUP_TITLE = "Gentle Shell";
export const GROUP_COLOR = "pink";
const STORAGE_KEY = "groupId";

/**
 * The subset of `chrome` this module uses, so tests can pass a fake.
 * @typedef {{
 *   tabs: Pick<typeof chrome.tabs, "create" | "get" | "query" | "group" | "ungroup" | "remove">,
 *   tabGroups: Pick<typeof chrome.tabGroups, "get" | "query" | "update">,
 *   windows: Pick<typeof chrome.windows, "getLastFocused">,
 *   storage: {local: Pick<chrome.storage.LocalStorageArea, "get" | "set">},
 * }} GroupApi
 * @typedef {{
 *   title?: string,
 *   load?: () => Promise<number | undefined>,
 *   save?: (groupId: number | undefined) => Promise<void>,
 *   adoptable?: (groupId: number) => boolean | Promise<boolean>,
 * }} GroupOptions `load`/`save` keep the group id (default: storage key "groupId");
 *   `adoptable` refuses a same-titled group that belongs to someone else
 */

export class TabGroup {
	/**
	 * @param {GroupApi} api
	 * @param {GroupOptions} [options]
	 */
	constructor(api, options = {}) {
		this.api = api;
		this.title = options.title ?? GROUP_TITLE;
		this.load = options.load ?? (async () => {
			const stored = (await api.storage.local.get({ [STORAGE_KEY]: null }))[STORAGE_KEY];
			return typeof stored === "number" ? stored : undefined;
		});
		this.save = options.save ?? ((groupId) => api.storage.local.set({ [STORAGE_KEY]: groupId ?? null }));
		this.adoptable = options.adoptable ?? (() => true);
		/** @type {Set<number>} tabs an agent action opened that the policy has not admitted yet */
		this.held = new Set();
	}

	/**
	 * The id of the Gentle Shell group, or undefined when there is none.
	 * @returns {Promise<number | undefined>}
	 */
	async current() {
		return (await this.find())?.id;
	}

	/**
	 * Opens `url` in a new background tab inside the group, creating the group if needed.
	 * It never becomes the active tab, so the user keeps working in their own tab.
	 * Callers must have validated and approved the URL already.
	 * @param {string} url
	 * @returns {Promise<{tabId: number, groupId: number}>}
	 */
	async openTab(url) {
		const existing = await this.find();
		const windowId = existing ? existing.windowId : (await this.api.windows.getLastFocused({ windowTypes: ["normal"] })).id;
		const tab = await this.api.tabs.create({ url, active: false, windowId });
		if (tab.id === undefined) throw new Error("Chrome did not return the new tab id");
		if (existing) {
			await this.api.tabs.group({ tabIds: tab.id, groupId: existing.id });
			return { tabId: tab.id, groupId: existing.id };
		}
		const groupId = await this.api.tabs.group({ tabIds: tab.id, createProperties: { windowId } });
		await this.api.tabGroups.update(groupId, { title: this.title, color: GROUP_COLOR });
		await this.save(groupId);
		return { tabId: tab.id, groupId };
	}

	/** @returns {Promise<{tabId: number, title: string, url: string, active: boolean}[]>} */
	async tabs() {
		const groupId = await this.current();
		if (groupId === undefined) return [];
		const tabs = await this.api.tabs.query({ groupId });
		return tabs
			.filter((tab) => tab.id !== undefined && tab.groupId === groupId && !this.held.has(tab.id))
			.map((tab) => ({ tabId: /** @type {number} */ (tab.id), title: tab.title ?? "", url: tab.url ?? "", active: Boolean(tab.active) }));
	}

	/**
	 * Returns the tab only if it is inside the group right now. This is the
	 * confinement boundary: call it before any read or action on a tab.
	 * @param {unknown} tabId
	 * @returns {Promise<chrome.tabs.Tab>}
	 */
	async requireTab(tabId) {
		const groupId = await this.current();
		if (groupId === undefined) throw new Error("There is no Gentle Shell group yet. Use browser_act with action \"open\" to create it.");
		const outside = new Error(`Tab ${tabId} is not in the Gentle Shell group. Ask the user to drag it into the group.`);
		if (typeof tabId !== "number" || !Number.isInteger(tabId)) throw outside;
		let tab;
		try {
			tab = await this.api.tabs.get(tabId);
		} catch {
			throw outside;
		}
		if (tab.groupId !== groupId || this.held.has(tabId)) throw outside;
		return tab;
	}

	/**
	 * `requireTab` as a yes/no answer, for checks during an action and before
	 * the debugger attaches.
	 * @param {unknown} tabId
	 */
	async contains(tabId) {
		try {
			await this.requireTab(tabId);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Takes a tab out of the group without holding it, so the user can drag it
	 * back in. Resolves true when it was in the group.
	 * @param {number} tabId
	 */
	async evict(tabId) {
		const groupId = await this.current();
		const tab = await this.api.tabs.get(tabId).catch(() => undefined);
		if (groupId === undefined || tab?.groupId !== groupId) return false;
		await this.api.tabs.ungroup(tabId);
		return true;
	}

	/** @param {number} tabId */
	isHeld(tabId) {
		return this.held.has(tabId);
	}

	/**
	 * Keeps a tab an agent action opened outside the group until `admit` or
	 * `discard`: Chrome may have put it in the group because its opener is
	 * there. Call again whenever Chrome changes its group.
	 * @param {number} tabId
	 */
	async hold(tabId) {
		this.held.add(tabId);
		const groupId = await this.current();
		const tab = await this.api.tabs.get(tabId).catch(() => undefined);
		if (groupId !== undefined && tab?.groupId === groupId && this.held.has(tabId)) await this.api.tabs.ungroup(tabId);
	}

	/**
	 * The user approved (or the policy allows) a held tab: it joins the group.
	 * @param {number} tabId
	 */
	async admit(tabId) {
		this.held.delete(tabId);
		const groupId = await this.current();
		if (groupId === undefined) throw new Error("The Gentle Shell group is gone.");
		await this.api.tabs.group({ tabIds: tabId, groupId });
	}

	/**
	 * A held tab was not approved: close it.
	 * @param {number} tabId
	 */
	async discard(tabId) {
		try {
			await this.api.tabs.remove(tabId);
		} finally {
			this.held.delete(tabId);
		}
	}

	/**
	 * The session ended: the group stays for the user, renamed "<title> (ended)",
	 * and is forgotten, so no session adopts it again.
	 */
	async end() {
		const stored = await this.load();
		await this.save(undefined);
		if (stored !== undefined) await this.api.tabGroups.update(stored, { title: `${this.title} (ended)` }).catch(() => {});
	}

	/** @returns {Promise<chrome.tabGroups.TabGroup | undefined>} */
	async find() {
		const stored = await this.load();
		if (stored !== undefined) {
			try {
				return await this.api.tabGroups.get(stored);
			} catch {
				// The group was closed; fall through to adoption.
			}
		}
		// A group the user created with this title counts as granted: naming a
		// group that way is the same explicit act as dragging tabs into ours.
		// Only this exact title (the query may match a pattern), and never an ended group.
		for (const adopted of await this.api.tabGroups.query({ title: this.title })) {
			if (adopted.title !== this.title || adopted.title.endsWith(" (ended)")) continue;
			if (!(await this.adoptable(adopted.id))) continue;
			await this.save(adopted.id);
			return adopted;
		}
		return undefined;
	}
}
