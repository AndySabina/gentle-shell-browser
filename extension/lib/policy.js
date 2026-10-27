// Authorization policy: the permission mode, what kind of step an action is
// (its category) and whether the user must approve it. Pure functions only,
// so every rule is unit-tested; the service worker reads the stored settings
// and asks Gentle Shell when a rule says so.
//
// Modes: "always" asks before every acting step; "remember" asks unless the
// user saved allow or deny for that site and category; "never" asks nothing.
// Reading never asks. The group limit and STOP hold in every mode.

export const MODES = ["always", "remember", "never"];
export const DEFAULT_MODE = "always";
/** The levels before the three modes, as stored by older builds. */
const LEGACY_MODES = { supervised: "always", autonomous: "remember" };
export const CATEGORIES = ["navigate", "click", "type", "key", "scroll", "money", "irreversible"];
/** How the approval prompt names each category: "Always allow <label> on <site>". */
export const CATEGORY_LABELS = Object.freeze({
	navigate: "opening pages",
	click: "clicks",
	type: "typing",
	key: "key presses",
	scroll: "scrolling",
	money: "payments and transfers",
	irreversible: "deleting, passwords and security changes",
});
const DECISIONS = ["allow", "deny"];
// A host name or an IPv6 literal: no other characters can be a stored site.
const SITE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/;
/** Every denied step fails with a message starting with this, so the model can tell. */
export const NOT_APPROVED = "The user did not approve:";
export const WAITING_LABEL = "Waiting for your approval in Gentle Shell…";
/** Reason shown when the agent marked a step as sensitive; it can only add an approval. */
export const AGENT_RISKY = "the agent marked this step as sensitive";

/**
 * Starter list of risky pages; the user edits it in the popup. An entry is a
 * host (matching its subdomains too) or a host plus path prefix.
 */
export const DEFAULT_RISKY_DOMAINS = Object.freeze([
	"paypal.com",
	"stripe.com",
	"dashboard.stripe.com",
	"mercadopago.com",
	"mercadopago.com.ar",
	"wise.com",
	"coinbase.com",
	"binance.com",
	"chase.com",
	"bbva.com.ar",
	"santander.com.ar",
	"hsbc.com.ar",
	"mail.google.com",
	"mail.yahoo.com",
	"mail.proton.me",
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"accounts.google.com",
	"myaccount.google.com",
	"pay.google.com",
	"payments.google.com",
	"login.microsoftonline.com",
	"account.microsoft.com",
	"appleid.apple.com",
	"github.com/settings",
	"console.aws.amazon.com",
	"signin.aws.amazon.com",
	"portal.azure.com",
	"console.cloud.google.com",
]);

const HOST_WORDS = ["banking", "bank", "banco", "wallet", "billing"];
const PATH_SEGMENTS = new Set(["checkout", "billing", "payment", "payments", "pay", "admin", "settings", "security", "password", "account", "accounts", "wallet"]);
// Word-boundary match on accent-free lower case. "sign in/up/out/on" is a login, not a signature.
const RISKY_VERBS =
	/\b(place order|cancel subscription|pay|pagar|buy|comprar|purchase|order|checkout|send|enviar|delete|eliminar|borrar|remove|quitar|publish|publicar|post|transfer|transferir|confirm|confirmar|unsubscribe|sign(?!\s+(?:in|up|out|on)\b)|firmar|donate|donar)\b/;
const SKIP_KEYS = new Set(["Tab", "Shift+Tab", "Escape"]);
const UNSEEN = "cannot inspect the target";
// Their content is another document or plugin: the policy cannot read what the input reaches.
const OPAQUE_TAGS = new Set(["iframe", "frame", "embed", "object"]);
// Enter or Space on these activates them like a click.
const ACTIVATABLE_ROLES = new Set(["button", "link", "menuitem"]);
const ACTIVATABLE_INPUTS = new Set(["submit", "button", "image", "reset"]);
const SEARCH_FIELD_NAMES = new Set(["q", "query", "search", "s"]);
const TEXT_INPUTS = new Set(["", "text", "search"]);
// Page content. Field words are matched on the name, id and label split into lower-case words.
const PAYMENT_FIELD_WORDS =
	/\b(card ?(number|num|no)|cc ?(number|num)|cvv\d?|cvc\d?|csc|expiry|expiration|exp ?date|iban|routing|account ?(number|num|no)|tarjeta|vencimiento|cuenta|clabe|cbu)\b/;
// Hosts (and their subdomains) that serve embedded payment forms.
const PAYMENT_FRAME_HOSTS = ["js.stripe.com", "checkout.stripe.com", "paypal.com", "checkout.com", "braintreegateway.com", "squareup.com", "squarecdn.com"];
// A host label equal to one of these, such as www.mercadopago.com.ar.
const PAYMENT_FRAME_LABELS = new Set(["mercadopago", "adyen", "braintree"]);
const SECURITY_TERMS =
	/\b(change password|cambiar contrasena|two-factor|two factor|verificacion en dos pasos|delete account|eliminar cuenta|billing|facturacion|payment methods|metodos de pago|security|seguridad)\b/;
const UNREADABLE_PAGE = "the page content could not be inspected";
// Risky verbs that move money or delete; the others (send, publish, confirm…) are plain steps.
const MONEY_VERBS = new Set(["place order", "pay", "pagar", "buy", "comprar", "purchase", "order", "checkout", "transfer", "transferir", "donate", "donar"]);
const IRREVERSIBLE_VERBS = new Set(["delete", "eliminar", "borrar", "remove", "quitar"]);
// Headings about billing; the other security terms are about passwords, two-factor and accounts.
const BILLING_TERMS = new Set(["billing", "facturacion", "payment methods", "metodos de pago"]);

/**
 * @typedef {"always" | "remember" | "never"} Mode
 * @typedef {"navigate" | "click" | "type" | "key" | "scroll" | "money" | "irreversible"} Category
 * @typedef {"allow" | "deny"} Decision
 * @typedef {Record<string, Partial<Record<Category, Decision>>>} Rules saved decisions by site, then category
 * @typedef {"money" | "irreversible"} Severe
 * @typedef {{reason: string, category?: Severe, verb?: boolean, about?: Severe, unsure?: boolean}} Finding
 *   one reason a step is risky: `category` when it moves money or cannot be undone, `verb` when it
 *   comes from the target's name, `about` when the page is about security or billing, `unsure` when
 *   the page could not be read
 * @typedef {{type?: string, autocomplete?: string, name?: string, id?: string}} FormField
 * @typedef {{
 *   tag?: string, type?: string, name?: string, autocomplete?: string, fieldName?: string, id?: string,
 *   role?: string, editable?: boolean, isSubmit?: boolean, formFields?: FormField[],
 *   inForm?: boolean, formAction?: string, searchLandmark?: boolean, shadowHost?: boolean,
 * }} ElementFacts element facts read from the page; `fieldName` is the name attribute, `name` the visible name
 * @typedef {{risky: boolean, reason?: string}} Verdict
 * @typedef {FormField & {label?: string}} PageField a visible input; `label` is its aria-label or label text
 * @typedef {{fields?: PageField[], submits?: string[], frames?: string[], headings?: string[]}} PageSignals
 *   what the page probe read from the main frame: visible inputs, names of form submit controls,
 *   addresses of visible frames, and the title and headings
 */

/**
 * The stored mode (storage key `level`); the old levels map to the new modes.
 * @param {unknown} value
 * @returns {Mode}
 */
export function normalizeMode(value) {
	if (typeof value !== "string") return DEFAULT_MODE;
	if (MODES.includes(value)) return /** @type {Mode} */ (value);
	return /** @type {Mode | undefined} */ (LEGACY_MODES[/** @type {keyof typeof LEGACY_MODES} */ (value)]) ?? DEFAULT_MODE;
}

/**
 * A site as rules store it: the lower-case host without a trailing dot or a
 * leading "www."; "" when it is not a host name.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSite(value) {
	if (typeof value !== "string") return "";
	const host = value.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
	return host.length <= 253 && SITE.test(host) ? host : "";
}

/**
 * The site of a page or destination; "" for addresses without a host (about:blank).
 * @param {string} url
 */
export function siteOf(url) {
	try {
		return normalizeSite(new URL(url).hostname);
	} catch {
		return "";
	}
}

/**
 * The stored rules, keeping only valid sites, categories and decisions.
 * @param {unknown} value
 * @returns {Rules}
 */
export function normalizeRules(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	/** @type {[string, Partial<Record<Category, Decision>>][]} */
	const sites = [];
	for (const [site, decisions] of Object.entries(value)) {
		if (normalizeSite(site) !== site || !decisions || typeof decisions !== "object" || Array.isArray(decisions)) continue;
		const kept = Object.entries(decisions).filter(([category, decision]) => CATEGORIES.includes(category) && DECISIONS.includes(decision));
		if (kept.length) sites.push([site, Object.fromEntries(kept)]);
	}
	return Object.fromEntries(sites);
}

/**
 * The saved decision for `category` on `site`, if any.
 * @param {unknown} rules
 * @param {string} site
 * @param {string} category
 * @returns {Decision | undefined}
 */
function ruleFor(rules, site, category) {
	if (!site || !rules || typeof rules !== "object" || !Object.hasOwn(rules, site)) return undefined;
	const decisions = /** @type {Record<string, unknown>} */ (rules)[site];
	if (!decisions || typeof decisions !== "object" || !Object.hasOwn(decisions, category)) return undefined;
	const decision = /** @type {Record<string, unknown>} */ (decisions)[category];
	return DECISIONS.includes(/** @type {string} */ (decision)) ? /** @type {Decision} */ (decision) : undefined;
}

/**
 * `rules` plus one saved decision; unchanged when the site, category or decision is not valid.
 * @param {unknown} rules
 * @param {string} site
 * @param {string} category
 * @param {string} decision
 * @returns {Rules}
 */
export function withRule(rules, site, category, decision) {
	const current = normalizeRules(rules);
	if (!site || normalizeSite(site) !== site || !CATEGORIES.includes(category) || !DECISIONS.includes(decision)) return current;
	return { ...current, [site]: { ...current[site], [category]: decision } };
}

/**
 * `rules` without the decision for `category` on `site`.
 * @param {unknown} rules
 * @param {string} site
 * @param {string} category
 * @returns {Rules}
 */
export function withoutRule(rules, site, category) {
	const current = normalizeRules(rules);
	const key = normalizeSite(site);
	if (!Object.hasOwn(current, key)) return current;
	const rest = Object.fromEntries(Object.entries(current[key]).filter(([name]) => name !== category));
	const others = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key));
	return Object.keys(rest).length ? { ...others, [key]: rest } : others;
}

/**
 * `rules` without any decision for `site` (given as typed: "WWW.Example.com" is example.com).
 * @param {unknown} rules
 * @param {string} site
 * @returns {Rules}
 */
export function withoutSite(rules, site) {
	const key = normalizeSite(site);
	return Object.fromEntries(Object.entries(normalizeRules(rules)).filter(([name]) => name !== key));
}

/**
 * The stored list if it is an array of non-empty strings, otherwise the defaults.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeRiskyDomains(value) {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) return [...DEFAULT_RISKY_DOMAINS];
	return value.map((entry) => entry.trim());
}

/**
 * @param {any} stored what chrome.storage.local returned
 * @returns {{level: Mode, riskyDomains: string[], rules: Rules}}
 */
export function normalizeSettings(stored) {
	return { level: normalizeMode(stored?.level), riskyDomains: normalizeRiskyDomains(stored?.riskyDomains), rules: normalizeRules(stored?.rules) };
}

/** @param {string} entry */
function parseEntry(entry) {
	const text = entry.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	const slash = text.indexOf("/");
	const host = (slash < 0 ? text : text.slice(0, slash)).replace(/^\*?\./, "").replace(/\.$/, "");
	const path = slash < 0 ? "" : text.slice(slash).replace(/\/+$/, "");
	return { host, path };
}

/**
 * Whether a page is risky by its address: the list, then the heuristics.
 * @param {string} url
 * @param {readonly string[]} riskyDomains
 * @returns {Verdict}
 */
function riskyAddress(url, riskyDomains) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { risky: true, reason: "the address could not be read" };
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return { risky: false };
	const path = parsed.pathname.toLowerCase();
	for (const entry of riskyDomains) {
		const rule = parseEntry(entry);
		if (!rule.host || (host !== rule.host && !host.endsWith(`.${rule.host}`))) continue;
		if (rule.path && path !== rule.path && !path.startsWith(`${rule.path}/`)) continue;
		return { risky: true, reason: `${rule.host}${rule.path} is on your risky pages list` };
	}
	const labels = host.split(".");
	if (labels[0].startsWith("admin")) return { risky: true, reason: `${host} looks like an admin panel` };
	for (const label of labels) {
		const word = HOST_WORDS.find((candidate) => label.includes(candidate));
		if (word) return { risky: true, reason: `the address ${host} mentions "${word}"` };
	}
	for (const segment of path.split("/")) {
		if (PATH_SEGMENTS.has(segment)) return { risky: true, reason: `the page path has "/${segment}"` };
	}
	return { risky: false };
}

/**
 * Whether a page is risky: by its address, or by its content when `signals`
 * (what the page probe read) are given.
 * @param {string} url
 * @param {readonly string[]} riskyDomains
 * @param {unknown} [signals]
 * @returns {Verdict}
 */
export function isRiskyPage(url, riskyDomains, signals) {
	const address = riskyAddress(url, riskyDomains);
	if (address.risky || signals === undefined) return address;
	return pageRiskFromSignals(signals);
}

/** @param {unknown} value */
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

/** @param {string} url */
function paymentFrameHost(url) {
	let host;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return undefined;
	}
	if (PAYMENT_FRAME_HOSTS.some((rule) => host === rule || host.endsWith(`.${rule}`))) return host;
	if (host.split(".").some((label) => PAYMENT_FRAME_LABELS.has(label))) return host;
	return undefined;
}

/**
 * Why a visible field on the page holds a secret, payment or bank data, or undefined.
 * @param {PageField} field
 */
function pageFieldSecret(field) {
	const secret = sensitiveField(field);
	if (secret) return secret;
	const words = plain(`${field.name ?? ""} ${field.id ?? ""} ${field.label ?? ""}`.replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/[^a-z0-9]+/g, " ");
	return PAYMENT_FIELD_WORDS.test(words) ? "a payment or bank account field" : undefined;
}

/**
 * Whether the page content looks sensitive: password, payment or bank fields,
 * a form that pays or sends, an embedded payment form, or account security
 * and billing settings. Content that could not be read counts as risky.
 * @param {unknown} signals what the page probe returned
 * @returns {Verdict}
 */
export function pageRiskFromSignals(signals) {
	const first = pageFindings(signals)[0];
	return first ? { risky: true, reason: first.reason } : { risky: false };
}

/**
 * Every reason the page content looks sensitive, in the order pageRiskFromSignals checks them.
 * @param {unknown} signals
 * @returns {Finding[]}
 */
function pageFindings(signals) {
	if (!signals || typeof signals !== "object") return [{ reason: UNREADABLE_PAGE, unsure: true }];
	const page = /** @type {PageSignals} */ (signals);
	/** @type {Finding[]} */
	const found = [];
	for (const field of Array.isArray(page.fields) ? page.fields : []) {
		const secret = field && typeof field === "object" ? pageFieldSecret(field) : undefined;
		if (secret) found.push({ reason: `the page has ${secret}`, category: secretCategory(secret) });
	}
	for (const src of strings(page.frames)) {
		const host = paymentFrameHost(src);
		if (host) found.push({ reason: `the page embeds a payment form from ${host}`, category: "money" });
	}
	for (const name of strings(page.submits)) {
		const verb = RISKY_VERBS.exec(plain(name));
		if (verb) found.push(severe({ reason: `the page has a ${JSON.stringify(name)} button (${verb[1]})` }, verbCategory(verb[1])));
	}
	for (const heading of strings(page.headings)) {
		const term = SECURITY_TERMS.exec(plain(heading));
		if (term) found.push({ reason: `the page is about ${JSON.stringify(heading)} (${term[1]})`, about: BILLING_TERMS.has(term[1]) ? "money" : "irreversible" });
	}
	return found;
}

/**
 * @param {Finding} finding
 * @param {Severe | undefined} category
 * @returns {Finding}
 */
const severe = (finding, category) => (category ? { ...finding, category } : finding);

/**
 * A password or one-time code cannot be taken back; card and bank data move money.
 * @param {string} secret what sensitiveField or pageFieldSecret said
 * @returns {Severe}
 */
const secretCategory = (secret) => (/password|one-time/.test(secret) ? "irreversible" : "money");

/**
 * @param {string} verb a RISKY_VERBS match, accent-free lower case
 * @returns {Severe | undefined}
 */
const verbCategory = (verb) => (MONEY_VERBS.has(verb) ? "money" : IRREVERSIBLE_VERBS.has(verb) ? "irreversible" : undefined);

/**
 * Why a form field holds a secret or payment data, or undefined.
 * @param {FormField & {tag?: string}} field
 */
export function sensitiveField(field) {
	if (field.type === "password") return "a password field";
	const autocomplete = String(field.autocomplete ?? "").toLowerCase();
	if (/(^|\s)cc-/.test(autocomplete)) return "a payment card field";
	if (/(^|\s)one-time-code(\s|$)/.test(autocomplete)) return "a one-time code field";
	if (/(^|\s)(current|new)-password(\s|$)/.test(autocomplete)) return "a password field";
	if (/card|cvv|cvc|iban/i.test(`${field.name ?? ""} ${field.id ?? ""}`)) return "a payment field";
	return undefined;
}

/** @param {ElementFacts} element */
function elementSecret(element) {
	return sensitiveField({ type: element.type, autocomplete: element.autocomplete, name: element.fieldName, id: element.id });
}

/** @param {ElementFacts} element */
function formSecret(element) {
	for (const field of element.formFields ?? []) {
		const secret = sensitiveField(field);
		if (secret) return secret;
	}
	return undefined;
}

/** @param {string} text */
function plain(text) {
	return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** @param {ElementFacts} element */
function inForm(element) {
	return Boolean(element.inForm || element.isSubmit || element.formFields?.length);
}

/**
 * A search box: submitting it only looks something up.
 * @param {ElementFacts} element
 */
function searchForm(element) {
	if (element.searchLandmark) return true;
	const fields = element.formFields ?? [];
	if (fields.some((field) => field.type === "search")) return true;
	try {
		if (element.formAction && new URL(element.formAction).pathname.toLowerCase().includes("search")) return true;
	} catch {
		// An unreadable action is not a search form.
	}
	const text = fields.filter((field) => TEXT_INPUTS.has(String(field.type ?? "")));
	return text.length === 1 && SEARCH_FIELD_NAMES.has(String(text[0].name ?? "").toLowerCase());
}

/**
 * Why submitting the element's form is risky, or undefined.
 * @param {ElementFacts} element
 * @returns {Finding | undefined}
 */
function formSubmission(element) {
	const secret = formSecret(element);
	if (secret) return { reason: `submitting a form with ${secret}`, category: secretCategory(secret) };
	if (inForm(element) && !searchForm(element)) return { reason: "submitting a form" };
	return undefined;
}

/**
 * Whether Enter or Space on the element activates it like a click.
 * @param {ElementFacts} element
 */
function activatable(element) {
	if (element.tag === "button" || element.tag === "a" || element.isSubmit) return true;
	if (element.tag === "input" && ACTIVATABLE_INPUTS.has(String(element.type))) return true;
	return ACTIVATABLE_ROLES.has(String(element.role ?? "").toLowerCase());
}

/**
 * @typedef {{kind: "click" | "type" | "key" | "scroll", element?: ElementFacts | null, key?: string, submit?: boolean, pageUrl: string, riskyDomains: readonly string[], pageSignals?: unknown, agentRisky?: unknown}} Action
 */

/**
 * Whether an input action is risky. Any action on a risky page is risky (by
 * address, or by content when `pageSignals` are given), and so is input on a
 * target the page script could not inspect. `agentRisky: true` makes any
 * action risky; any other value changes nothing.
 * @param {Action} action
 * @returns {Verdict}
 */
export function classifyAction(action) {
	const first = actionFindings(action)[0];
	return first ? { risky: true, reason: first.reason } : { risky: false };
}

/**
 * Every reason the action is risky, in the order classifyAction checks them:
 * the target, then the page, then the agent's flag.
 * @param {Action} action
 * @returns {Finding[]}
 */
function actionFindings({ kind, element, key, submit = false, pageUrl, riskyDomains, pageSignals, agentRisky }) {
	const found = elementFindings(kind, element, key, submit);
	const address = riskyAddress(pageUrl, riskyDomains);
	if (address.risky) found.push({ reason: `acting on a risky page: ${address.reason}` });
	if (pageSignals !== undefined) for (const finding of pageFindings(pageSignals)) found.push({ ...finding, reason: `acting on a risky page: ${finding.reason}` });
	if (agentRisky === true) found.push({ reason: AGENT_RISKY });
	return found;
}

/**
 * Every reason input on the element is risky; an uninspectable target is the only one.
 * @param {Action["kind"]} kind
 * @param {ElementFacts | null | undefined} element
 * @param {string | undefined} key
 * @param {boolean} submit
 * @returns {Finding[]}
 */
function elementFindings(kind, element, key, submit) {
	const skipped = kind === "key" && SKIP_KEYS.has(String(key));
	if (kind !== "scroll" && !skipped) {
		if (!element || OPAQUE_TAGS.has(String(element.tag)) || (element.shadowHost && !String(element.name ?? "").trim())) return [{ reason: UNSEEN }];
	}
	if (!element) return [];
	/** @type {Finding[]} */
	const found = [];
	const secret = elementSecret(element);
	if ((kind === "type" || (kind === "key" && !skipped)) && secret) found.push({ reason: `typing into ${secret}`, category: secretCategory(secret) });
	const enter = (kind === "type" && submit) || (kind === "key" && /(^|\+)enter$/i.test(String(key)));
	const space = kind === "key" && /(^|\+)(space| )$/i.test(String(key));
	if (enter && (element.tag === "textarea" || element.editable)) found.push({ reason: "pressing Enter in a message box may send it" });
	if (kind === "click" || ((enter || space) && activatable(element))) {
		const name = String(element.name ?? "");
		const verb = RISKY_VERBS.exec(plain(name));
		const pressed = kind === "type" ? "Enter" : String(key).trim() || "Space";
		if (verb) found.push(severe({ reason: `${kind === "click" ? "clicking" : `pressing ${pressed} on`} ${JSON.stringify(name)} (${verb[1]})`, verb: true }, verbCategory(verb[1])));
		const submits = element.isSubmit ? formSubmission(element) : undefined;
		if (submits) found.push(submits);
	}
	if (enter) {
		const submits = formSubmission(element);
		if (submits) found.push(submits);
	}
	return found;
}

/**
 * The category of an acting step, from the same detection as classifyAction:
 * `money` when a finding moves money (payment, purchase or transfer verbs,
 * card or bank fields, payment forms and frames), else `irreversible` when one
 * cannot be undone (delete verbs, password or one-time code fields, password
 * forms, a risky verb on a security page), else the plain kind. Navigation is
 * always `navigate`, and scrolling always `scroll`: it cannot pay or delete.
 * `reason` is the risk the step has, if any; `unsure` when the page content
 * could not be read, so a saved allow must not cover it.
 * @param {Omit<Action, "agentRisky" | "kind"> & {kind: Action["kind"] | "navigate"}} step
 * @returns {{category: Category, reason?: string, unsure?: true}}
 */
export function stepCategory({ kind, ...facts }) {
	if (kind === "navigate") {
		const page = isRiskyPage(facts.pageUrl, facts.riskyDomains);
		return page.risky ? { category: "navigate", reason: `risky page: ${page.reason}` } : { category: "navigate" };
	}
	const found = actionFindings({ kind, ...facts });
	const unsure = kind !== "scroll" && found.some((finding) => finding.unsure) ? { unsure: /** @type {const} */ (true) } : {};
	if (kind !== "scroll") {
		const verb = found.some((finding) => finding.verb);
		for (const category of /** @type {const} */ (["money", "irreversible"])) {
			const hit = found.find((finding) => finding.category === category) ?? (verb ? found.find((finding) => finding.about === category) : undefined);
			if (hit) return { category, reason: hit.reason, ...unsure };
		}
	}
	return { category: kind, ...(found[0] ? { reason: found[0].reason } : {}), ...unsure };
}

/**
 * Whether a step needs the user's approval. `never` allows everything;
 * `always` asks for every step; `remember` follows the saved decision for
 * this site and category and asks when there is none. The agent can only
 * raise: `agentRisky: true` asks even over a saved allow (never in `never`).
 * `reason` is the step's risk, shown to the user when asking.
 * @param {{mode: unknown, site: string, category: string, reason?: string, rules: unknown, agentRisky?: unknown}} step
 * @returns {{ask: boolean, allow?: boolean, reason: string}}
 */
export function decideStep({ mode, site, category, reason, rules, agentRisky }) {
	const current = normalizeMode(mode);
	if (current === "never") return { ask: false, allow: true, reason: "Never ask mode does not ask" };
	const why = reason || (agentRisky === true ? AGENT_RISKY : undefined);
	if (current === "always") return { ask: true, reason: why ?? "Always ask mode asks before every step" };
	const rule = ruleFor(rules, site, category);
	if (rule === "deny") return { ask: false, allow: false, reason: `saved rule: deny ${category} on ${site}` };
	if (rule === "allow" && agentRisky !== true) return { ask: false, allow: true, reason: `saved rule: allow ${category} on ${site}` };
	const label = CATEGORY_LABELS[/** @type {Category} */ (category)] ?? category;
	return { ask: true, reason: why ?? `no saved decision for ${label} on ${site || "this page"}` };
}

/**
 * Gentle Shell's answer to an approval request. `remember` counts only when
 * the request offered it (`offered`) and agrees with the answer: "allow" with
 * an approval, "deny" with a denial. Anything else is not an approval.
 * @param {unknown} value
 * @param {boolean} offered
 * @returns {{approved: boolean, remember?: Decision}}
 */
export function readAnswer(value, offered) {
	if (value === true) return { approved: true };
	if (!value || typeof value !== "object") return { approved: false };
	const { approved, remember } = /** @type {{approved?: unknown, remember?: unknown}} */ (value);
	const yes = approved === true;
	if (offered && ((remember === "allow" && yes) || (remember === "deny" && !yes))) return { approved: yes, remember };
	return { approved: yes };
}
