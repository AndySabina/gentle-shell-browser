import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AGENT_RISKY,
	CATEGORY_LABELS,
	classifyAction,
	DEFAULT_RISKY_DOMAINS,
	decideStep,
	isRiskyPage,
	normalizeMode,
	normalizeRiskyDomains,
	normalizeRules,
	normalizeSettings,
	normalizeSite,
	pageRiskFromSignals,
	readAnswer,
	siteOf,
	stepCategory,
	withoutRule,
	withoutSite,
	withRule,
} from "../extension/lib/policy.js";

const LIST = DEFAULT_RISKY_DOMAINS;
const SAFE_PAGE = "https://example.com/docs";

test("the starter list covers payments, mail, accounts and admin consoles", () => {
	for (const entry of ["paypal.com", "mercadopago.com.ar", "mail.google.com", "accounts.google.com", "login.microsoftonline.com", "github.com/settings", "console.aws.amazon.com", "dashboard.stripe.com"]) {
		assert.ok(LIST.includes(entry), entry);
	}
	assert.ok(LIST.every((entry: unknown) => typeof entry === "string" && entry.length > 0));
});

test("a list entry matches its host and subdomains, not look-alikes", () => {
	assert.equal(isRiskyPage("https://paypal.com/", LIST).risky, true);
	assert.equal(isRiskyPage("https://www.paypal.com/myaccount", LIST).risky, true);
	assert.match(isRiskyPage("https://www.paypal.com/", LIST).reason ?? "", /paypal\.com/);
	assert.equal(isRiskyPage("https://notpaypal.com/", LIST).risky, false);
	assert.equal(isRiskyPage("https://paypal.com.evil.test/", LIST).risky, false);
});

test("a host+path entry matches only below that path", () => {
	assert.equal(isRiskyPage("https://github.com/settings/tokens", LIST).risky, true);
	assert.equal(isRiskyPage("https://github.com/settings", LIST).risky, true);
	assert.equal(isRiskyPage("https://github.com/user/repo", LIST).risky, false);
	assert.equal(isRiskyPage("https://github.com/settingsx", LIST).risky, false);
});

test("user entries are normalized: scheme, case, leading *. and trailing slash", () => {
	const list = ["HTTPS://Shop.Example.org/", "*.corp.test", "intranet.test/Admin-Panel/"];
	assert.equal(isRiskyPage("https://shop.example.org/cart", list).risky, true);
	assert.equal(isRiskyPage("https://hr.corp.test/", list).risky, true);
	assert.equal(isRiskyPage("https://intranet.test/admin-panel/users", list).risky, true);
	assert.equal(isRiskyPage("https://intranet.test/wiki", list).risky, false);
});

test("heuristics flag bank, wallet and billing hosts, admin hosts and sensitive paths", () => {
	for (const url of [
		"https://www.bancogalicia.com/",
		"https://homebanking.example.com/",
		"https://mybank.test/",
		"https://wallet.example.com/",
		"https://billing.example.com/",
		"https://admin.example.com/",
		"https://shop.example.com/checkout",
		"https://www.mercadolibre.com.ar/checkout/v1",
		"https://example.com/account/",
		"https://example.com/user/settings",
		"https://example.com/payments/new",
		"https://example.com/security",
		"https://example.com/reset/password",
		"https://example.com/pay",
	]) {
		const verdict = isRiskyPage(url, []);
		assert.equal(verdict.risky, true, url);
		assert.equal(typeof verdict.reason, "string", url);
	}
});

test("ordinary pages are safe", () => {
	for (const url of [SAFE_PAGE, "https://www.mercadolibre.com.ar/celulares", "https://news.ycombinator.com/item?id=1", "https://en.wikipedia.org/wiki/Bank_holiday", "https://example.com/paying-guests", "about:blank"]) {
		assert.deepEqual(isRiskyPage(url, LIST), { risky: false }, url);
	}
});

test("an unreadable address is treated as risky", () => {
	assert.equal(isRiskyPage("not a url", LIST).risky, true);
});

const field = (facts: Record<string, unknown>) => ({ tag: "input", type: "text", name: "", autocomplete: "", fieldName: "", id: "", role: "", editable: false, isSubmit: false, formFields: [], ...facts });

test("typing into password, card and one-time-code fields is risky", () => {
	for (const element of [
		field({ type: "password" }),
		field({ autocomplete: "cc-number" }),
		field({ autocomplete: "section-pay cc-csc" }),
		field({ autocomplete: "one-time-code" }),
		field({ fieldName: "cardNumber" }),
		field({ id: "cvv" }),
		field({ fieldName: "CVC" }),
		field({ id: "iban-input" }),
	]) {
		const verdict = classifyAction({ kind: "type", element, pageUrl: SAFE_PAGE, riskyDomains: LIST });
		assert.equal(verdict.risky, true, JSON.stringify(element));
		assert.equal(typeof verdict.reason, "string");
	}
	assert.deepEqual(classifyAction({ kind: "type", element: field({ type: "email", fieldName: "email" }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
});

test("clicking a risky verb is risky in English and Spanish, with any case or accents", () => {
	for (const name of ["Pay now", "PAGAR", "Buy", "Comprar ahora", "Place order", "Checkout", "Send", "Enviar mensaje", "Delete repository", "Eliminar", "Borrar", "Remove", "Quitar", "Publish", "Publicar", "Post", "Transfer", "Transferír", "Confirm", "Confirmar compra", "Unsubscribe", "Cancel subscription", "Sign", "Firmar", "Donate", "Donar", "Purchase", "Order", "ENVIÁR"]) {
		const verdict = classifyAction({ kind: "click", element: field({ tag: "button", type: undefined, name }), pageUrl: SAFE_PAGE, riskyDomains: LIST });
		assert.equal(verdict.risky, true, name);
		assert.match(verdict.reason ?? "", new RegExp(JSON.stringify(name).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name);
	}
});

test("harmless buttons and links are not risky", () => {
	for (const name of ["Search", "Next", "Siguiente", "Buscar", "Open PayPal docs", "Display", "Sign in", "Iniciar sesión", "Reorder list", ""]) {
		assert.deepEqual(classifyAction({ kind: "click", element: field({ tag: "button", type: undefined, name }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false }, name);
	}
	assert.deepEqual(classifyAction({ kind: "scroll", pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
});

const UNSEEN = { risky: true, reason: "cannot inspect the target" };

test("a target that cannot be inspected asks: missing, inside a frame or embed, or an unnamed shadow host", () => {
	for (const kind of ["click", "type", "key"] as const) {
		assert.deepEqual(classifyAction({ kind, key: "Enter", pageUrl: SAFE_PAGE, riskyDomains: LIST }), UNSEEN, `${kind} without element`);
		assert.deepEqual(classifyAction({ kind, key: "Enter", element: null, pageUrl: SAFE_PAGE, riskyDomains: LIST }), UNSEEN, `${kind} null`);
		for (const tag of ["iframe", "frame", "embed", "object"]) {
			assert.deepEqual(classifyAction({ kind, key: "a", element: field({ tag, type: undefined, name: "Checkout widget" }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), UNSEEN, `${kind} ${tag}`);
		}
		assert.deepEqual(classifyAction({ kind, key: "a", element: field({ tag: "pay-button", type: undefined, shadowHost: true }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), UNSEEN, `${kind} shadow host`);
	}
	assert.deepEqual(classifyAction({ kind: "click", element: field({ tag: "x-menu", type: undefined, name: "Menu", shadowHost: true }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "key", key: "Tab", element: field({ tag: "iframe", type: undefined }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
});

const button = (name: string, facts: Record<string, unknown> = {}) => field({ tag: "button", type: undefined, name, ...facts });

test("Enter or Space on a focused button, link or submit control runs the same name check as a click", () => {
	for (const key of ["Enter", "Space", " ", "enter"]) {
		const verdict = classifyAction({ kind: "key", key, element: button("Pay now"), pageUrl: SAFE_PAGE, riskyDomains: LIST });
		assert.equal(verdict.risky, true, key);
		assert.match(verdict.reason ?? "", /Pay now/, key);
	}
	assert.equal(classifyAction({ kind: "key", key: "Space", element: button("Delete account"), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "key", key: "Enter", element: field({ tag: "a", type: undefined, name: "Send money" }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "key", key: "Enter", element: field({ tag: "div", type: undefined, role: "button", name: "Publicar" }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "key", key: "Space", element: field({ type: "submit", name: "Confirm" }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.deepEqual(classifyAction({ kind: "key", key: "Enter", element: button("Next"), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "key", key: "a", element: button("Pay now"), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "key", key: " ", element: button("Pay now"), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: true, reason: 'pressing Space on "Pay now" (pay)' });
	assert.deepEqual(classifyAction({ kind: "type", submit: true, element: button("Pay now"), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: true, reason: 'pressing Enter on "Pay now" (pay)' });
});

const plainForm = [{ type: "text", autocomplete: "", name: "title", id: "" }, { type: "text", autocomplete: "", name: "body", id: "" }];

test("submitting a form is risky: Enter or submit inside it, or a submit control, unless it is a search form", () => {
	const input = field({ fieldName: "title", inForm: true, formFields: plainForm });
	assert.match(classifyAction({ kind: "key", key: "Enter", element: input, pageUrl: SAFE_PAGE, riskyDomains: LIST }).reason ?? "", /submitting a form/);
	assert.equal(classifyAction({ kind: "type", submit: true, element: input, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.deepEqual(classifyAction({ kind: "type", element: input, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	// A harmless name stays harmless unless the control submits a non-search form.
	assert.match(classifyAction({ kind: "click", element: button("Next", { isSubmit: true, inForm: true, formFields: plainForm }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).reason ?? "", /submitting a form/);
	assert.equal(classifyAction({ kind: "click", element: field({ type: "image", name: "Go", isSubmit: true, inForm: true, formFields: plainForm }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.deepEqual(classifyAction({ kind: "click", element: button("Next", { inForm: true, formFields: plainForm }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });

	const searches = [
		{ searchLandmark: true, formFields: plainForm },
		{ formFields: [...plainForm, { type: "search", autocomplete: "", name: "term", id: "" }] },
		{ formAction: "https://example.com/search/results", formFields: plainForm },
		...["q", "query", "search", "s"].map((name) => ({ formFields: [{ type: "text", autocomplete: "", name, id: "" }, { type: "hidden", autocomplete: "", name: "lang", id: "" }] })),
	];
	for (const facts of searches) {
		const inSearch = { inForm: true, ...facts };
		assert.deepEqual(classifyAction({ kind: "key", key: "Enter", element: field(inSearch), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false }, JSON.stringify(facts));
		assert.deepEqual(classifyAction({ kind: "type", submit: true, element: field(inSearch), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false }, JSON.stringify(facts));
		assert.deepEqual(classifyAction({ kind: "click", element: button("Search", { isSubmit: true, ...inSearch }), pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false }, JSON.stringify(facts));
	}
	const twoTextFields = [{ type: "text", autocomplete: "", name: "q", id: "" }, { type: "text", autocomplete: "", name: "to", id: "" }];
	assert.equal(classifyAction({ kind: "key", key: "Enter", element: field({ inForm: true, formFields: twoTextFields }), pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
});

test("Enter or submit in a textarea or contenteditable is risky (sends messages); in a search input it is not", () => {
	const textarea = field({ tag: "textarea", type: undefined });
	const editable = field({ tag: "div", type: undefined, editable: true });
	const search = field({ type: "search", fieldName: "q" });
	assert.equal(classifyAction({ kind: "key", key: "Enter", element: textarea, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "key", key: "Control+Enter", element: editable, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "type", submit: true, element: editable, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.deepEqual(classifyAction({ kind: "key", key: "Enter", element: search, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "type", submit: true, element: search, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "type", element: textarea, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
	assert.deepEqual(classifyAction({ kind: "key", key: "a", element: textarea, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
});

test("submitting a form that has a password or payment field is risky", () => {
	const login = field({ fieldName: "user", formFields: [{ type: "text", autocomplete: "username", name: "user", id: "" }, { type: "password", autocomplete: "", name: "pw", id: "" }] });
	assert.equal(classifyAction({ kind: "key", key: "Enter", element: login, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	assert.equal(classifyAction({ kind: "type", submit: true, element: login, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	const submitButton = field({ tag: "button", type: undefined, name: "Continue", isSubmit: true, formFields: [{ type: "text", autocomplete: "cc-number", name: "", id: "" }] });
	assert.equal(classifyAction({ kind: "click", element: submitButton, pageUrl: SAFE_PAGE, riskyDomains: LIST }).risky, true);
	const searchForm = field({ type: "search", formFields: [{ type: "search", autocomplete: "", name: "q", id: "" }] });
	assert.deepEqual(classifyAction({ kind: "type", submit: true, element: searchForm, pageUrl: SAFE_PAGE, riskyDomains: LIST }), { risky: false });
});

test("any action on a risky page is risky", () => {
	for (const kind of ["click", "type", "key", "scroll"] as const) {
		const verdict = classifyAction({ kind, key: "ArrowDown", element: field({ name: "Next" }), pageUrl: "https://mail.google.com/mail/u/0/", riskyDomains: LIST });
		assert.equal(verdict.risky, true, kind);
		assert.match(verdict.reason ?? "", /mail\.google\.com/);
	}
});

test("stored settings are validated; the mode defaults to always and the old levels map to the new modes", () => {
	for (const mode of ["always", "remember", "never"]) assert.equal(normalizeMode(mode), mode);
	assert.equal(normalizeMode("supervised"), "always");
	assert.equal(normalizeMode("autonomous"), "remember");
	for (const bad of [undefined, null, "", "NEVER", "Always", "full", 1, {}]) assert.equal(normalizeMode(bad), "always", String(bad));
	assert.deepEqual(normalizeRiskyDomains(["a.test", " b.test "]), ["a.test", "b.test"]);
	assert.deepEqual(normalizeRiskyDomains([]), []);
	for (const bad of [undefined, null, "a.test", ["a.test", ""], ["a.test", 3], [" "]]) assert.deepEqual(normalizeRiskyDomains(bad), [...DEFAULT_RISKY_DOMAINS]);
	assert.deepEqual(normalizeSettings({}), { level: "always", riskyDomains: [...DEFAULT_RISKY_DOMAINS], rules: {} });
	assert.deepEqual(normalizeSettings({ level: "autonomous", riskyDomains: ["x.test"] }), { level: "remember", riskyDomains: ["x.test"], rules: {} });
	assert.deepEqual(normalizeSettings({ level: "never", rules: { "example.com": { click: "allow" } } }).rules, { "example.com": { click: "allow" } });
	assert.deepEqual(normalizeSettings(undefined), { level: "always", riskyDomains: [...DEFAULT_RISKY_DOMAINS], rules: {} });
});

// S14: three permission modes, with decisions saved per site and action type.

test("a site is the lower-case host name without a leading www.", () => {
	assert.equal(siteOf("https://WWW.Example.COM/path?q=1"), "example.com");
	assert.equal(siteOf("https://www.mercadopago.com.ar/checkout"), "mercadopago.com.ar");
	assert.equal(siteOf("https://mail.google.com/mail/u/0/"), "mail.google.com");
	assert.equal(siteOf("https://wwwx.example.com/"), "wwwx.example.com");
	assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
	for (const bad of ["about:blank", "not a url", "", "file:///etc/passwd"]) assert.equal(siteOf(bad), "", bad);
	assert.equal(normalizeSite(" WWW.Example.com. "), "example.com");
	for (const bad of ["", "__proto__", "a b.test", "x/y", 3, undefined]) assert.equal(normalizeSite(bad), "", String(bad));
});

const ELEMENT = { tag: "button", type: undefined, name: "Next", autocomplete: "", fieldName: "", id: "", role: "", editable: false, isSubmit: false, formFields: [] };
const step = (facts: Record<string, unknown>) => stepCategory({ kind: "click", element: ELEMENT, pageUrl: SAFE_PAGE, riskyDomains: LIST, ...facts } as any);
const emptySignals = { fields: [], submits: [], frames: [], headings: [] };

test("stepCategory: payment, purchase and transfer verbs are money, in English and Spanish", () => {
	for (const name of ["Pay now", "PAGAR", "Buy", "Comprar ahora", "Place order", "Checkout", "Purchase", "Order", "Transfer", "Transferír", "Donate", "Donar"]) {
		const found = step({ element: { ...ELEMENT, name } });
		assert.equal(found.category, "money", name);
		assert.match(found.reason ?? "", /^clicking "/, name);
	}
	assert.deepEqual(step({ element: { ...ELEMENT, name: "Pay now" } }), { category: "money", reason: 'clicking "Pay now" (pay)' });
	assert.deepEqual(step({ kind: "key", key: "Enter", element: { ...ELEMENT, name: "Pagar" } }), { category: "money", reason: 'pressing Enter on "Pagar" (pagar)' });
});

test("stepCategory: card and bank fields, payment forms and payment frames are money", () => {
	const card = { ...ELEMENT, tag: "input", type: "text", name: "Card", autocomplete: "cc-number" };
	assert.deepEqual(step({ kind: "type", element: card }), { category: "money", reason: "typing into a payment card field" });
	assert.deepEqual(step({ kind: "type", element: { ...card, autocomplete: "", fieldName: "cvv" } }), { category: "money", reason: "typing into a payment field" });
	const cardForm = { ...ELEMENT, name: "Continue", isSubmit: true, inForm: true, formFields: [{ type: "text", autocomplete: "cc-number", name: "", id: "" }] };
	assert.deepEqual(step({ element: cardForm }), { category: "money", reason: "submitting a form with a payment card field" });
	const framed = { ...emptySignals, frames: ["https://js.stripe.com/v3/elements-inner-card.html"] };
	assert.deepEqual(step({ pageSignals: framed }), { category: "money", reason: "acting on a risky page: the page embeds a payment form from js.stripe.com" });
	const bank = { ...emptySignals, fields: [{ type: "text", autocomplete: "", name: "", id: "", label: "Número de tarjeta" }] };
	assert.deepEqual(step({ kind: "key", key: "a", element: { ...ELEMENT, tag: "input", type: "text" }, pageSignals: bank }), { category: "money", reason: "acting on a risky page: the page has a payment or bank account field" });
	// A money finding wins over a plain one found first.
	const sendCard = { ...cardForm, name: "Send" };
	assert.deepEqual(step({ element: sendCard }), { category: "money", reason: "submitting a form with a payment card field" });
	assert.deepEqual(step({ pageSignals: { ...emptySignals, submits: ["Send", "Pay now"] } }), { category: "money", reason: 'acting on a risky page: the page has a "Pay now" button (pay)' });
});

test("stepCategory: delete verbs, password and one-time code fields and password forms are irreversible", () => {
	for (const name of ["Delete repository", "Eliminar", "Borrar", "Remove", "Quitar"]) assert.equal(step({ element: { ...ELEMENT, name } }).category, "irreversible", name);
	assert.deepEqual(step({ element: { ...ELEMENT, name: "Delete account" } }), { category: "irreversible", reason: 'clicking "Delete account" (delete)' });
	const password = { ...ELEMENT, tag: "input", type: "password", name: "Password" };
	assert.deepEqual(step({ kind: "type", element: password }), { category: "irreversible", reason: "typing into a password field" });
	assert.deepEqual(step({ kind: "type", element: { ...password, type: "text", autocomplete: "one-time-code" } }), { category: "irreversible", reason: "typing into a one-time code field" });
	const login = { ...ELEMENT, tag: "input", type: "text", name: "User", inForm: true, formFields: [{ type: "password", autocomplete: "", name: "pw", id: "" }] };
	assert.deepEqual(step({ kind: "type", submit: true, element: login }), { category: "irreversible", reason: "submitting a form with a password field" });
	assert.deepEqual(step({ pageSignals: { ...emptySignals, fields: [{ type: "password", autocomplete: "", name: "pw", id: "", label: "" }] } }), { category: "irreversible", reason: "acting on a risky page: the page has a password field" });
	// On a security page a risky verb is irreversible; a harmless click there is still a click.
	const security = { ...emptySignals, headings: ["Change password"] };
	assert.deepEqual(step({ element: { ...ELEMENT, name: "Confirm" }, pageSignals: security }), { category: "irreversible", reason: 'acting on a risky page: the page is about "Change password" (change password)' });
	assert.deepEqual(step({ element: { ...ELEMENT, name: "Next" }, pageSignals: security }), { category: "click", reason: 'acting on a risky page: the page is about "Change password" (change password)' });
	assert.equal(step({ element: { ...ELEMENT, name: "Confirm" }, pageSignals: { ...emptySignals, headings: ["Payment methods"] } }).category, "money");
});

test("stepCategory: every other step is its plain kind, with the risk reason when there is one", () => {
	assert.deepEqual(step({}), { category: "click" });
	assert.deepEqual(step({ pageSignals: emptySignals }), { category: "click" });
	assert.deepEqual(step({ element: { ...ELEMENT, name: "Send" } }), { category: "click", reason: 'clicking "Send" (send)' });
	assert.deepEqual(step({ kind: "type", element: { ...ELEMENT, tag: "input", type: "email" } }), { category: "type" });
	assert.deepEqual(step({ kind: "key", key: "Enter", element: { ...ELEMENT, tag: "textarea" } }), { category: "key", reason: "pressing Enter in a message box may send it" });
	assert.deepEqual(step({ kind: "scroll", element: undefined }), { category: "scroll" });
	assert.deepEqual(step({ element: null }), { category: "click", reason: "cannot inspect the target" });
	assert.deepEqual(step({ pageUrl: "https://mail.google.com/mail/u/0/" }), { category: "click", reason: "acting on a risky page: mail.google.com is on your risky pages list" });
	// Scrolling cannot pay or delete: it stays scrolling even on a payment page.
	assert.deepEqual(step({ kind: "scroll", element: undefined, pageSignals: { ...emptySignals, frames: ["https://js.stripe.com/v3/"] } }), { category: "scroll", reason: "acting on a risky page: the page embeds a payment form from js.stripe.com" });
	// Content that could not be read is marked unsure, so a saved allow does not cover it.
	assert.deepEqual(step({ pageSignals: null }), { category: "click", reason: "acting on a risky page: the page content could not be inspected", unsure: true });
});

test("stepCategory: a navigation is navigate, even to a payment page, with the address risk as its reason", () => {
	assert.deepEqual(stepCategory({ kind: "navigate", pageUrl: "https://example.org/docs", riskyDomains: LIST }), { category: "navigate" });
	assert.deepEqual(stepCategory({ kind: "navigate", pageUrl: "https://www.paypal.com/checkout", riskyDomains: LIST }), { category: "navigate", reason: "risky page: paypal.com is on your risky pages list" });
});

test("the category labels are the exact prompt words", () => {
	assert.deepEqual(CATEGORY_LABELS, {
		navigate: "opening pages",
		click: "clicks",
		type: "typing",
		key: "key presses",
		scroll: "scrolling",
		money: "payments and transfers",
		irreversible: "deleting, passwords and security changes",
	});
});

const SITE = "example.com";
const decide = (mode: unknown, rule: string | undefined, agentRisky?: unknown, category = "click", reason?: string) =>
	decideStep({ mode, site: SITE, category, reason, rules: rule ? { [SITE]: { [category]: rule } } : {}, agentRisky } as any);

test("decideStep: never mode never asks and always allows, whatever the rule or the agent says", () => {
	for (const rule of ["allow", "deny", undefined]) {
		for (const agentRisky of [true, false, undefined]) {
			for (const category of ["click", "money", "irreversible", "navigate"]) {
				const verdict = decide("never", rule, agentRisky, category, 'clicking "Pay now" (pay)');
				assert.equal(verdict.ask, false, `${rule} ${agentRisky} ${category}`);
				assert.equal(verdict.allow, true, `${rule} ${agentRisky} ${category}`);
			}
		}
	}
});

test("decideStep: always mode asks for every step, even with a saved rule", () => {
	for (const rule of ["allow", "deny", undefined]) {
		for (const agentRisky of [true, false]) {
			for (const category of ["navigate", "click", "type", "key", "scroll", "money", "irreversible"]) {
				const verdict = decide("always", rule, agentRisky, category);
				assert.equal(verdict.ask, true, `${rule} ${agentRisky} ${category}`);
				assert.equal("allow" in verdict, false);
			}
		}
	}
	assert.deepEqual(decide("always", undefined), { ask: true, reason: "Always ask mode asks before every step" });
	assert.deepEqual(decide("always", undefined, true), { ask: true, reason: AGENT_RISKY });
	assert.deepEqual(decide("always", undefined, true, "money", 'clicking "Pay now" (pay)'), { ask: true, reason: 'clicking "Pay now" (pay)' });
	// Unknown and old values are always mode.
	for (const mode of [undefined, "bogus", "supervised"]) assert.equal(decide(mode, "allow").ask, true, String(mode));
});

test("decideStep: remember mode follows the saved rule for that site and category, and asks without one", () => {
	assert.deepEqual(decide("remember", "allow"), { ask: false, allow: true, reason: "saved rule: allow click on example.com" });
	assert.deepEqual(decide("remember", "allow", false), { ask: false, allow: true, reason: "saved rule: allow click on example.com" });
	assert.deepEqual(decide("remember", "deny"), { ask: false, allow: false, reason: "saved rule: deny click on example.com" });
	assert.deepEqual(decide("remember", "deny", true), { ask: false, allow: false, reason: "saved rule: deny click on example.com" });
	assert.deepEqual(decide("remember", undefined), { ask: true, reason: "no saved decision for clicks on example.com" });
	assert.deepEqual(decide("remember", undefined, false, "money", 'clicking "Pay now" (pay)'), { ask: true, reason: 'clicking "Pay now" (pay)' });
	// The agent can only raise: risky:true asks even over a saved allow.
	assert.deepEqual(decide("remember", "allow", true), { ask: true, reason: AGENT_RISKY });
	assert.deepEqual(decide("remember", undefined, true), { ask: true, reason: AGENT_RISKY });
	for (const value of ["true", 1, null]) assert.equal(decide("remember", "allow", value).ask, false, String(value));
	// Old autonomous is remember.
	assert.equal(decide("autonomous", "allow").allow, true);
});

test("decideStep: a rule for one category never covers another, nor another site", () => {
	const rules = { "mercadopago.com": { click: "allow" }, "example.com": { money: "allow" } };
	assert.deepEqual(decideStep({ mode: "remember", site: "mercadopago.com", category: "money", reason: 'clicking "Pagar" (pagar)', rules }), { ask: true, reason: 'clicking "Pagar" (pagar)' });
	assert.equal(decideStep({ mode: "remember", site: "mercadopago.com", category: "click", rules }).allow, true);
	assert.equal(decideStep({ mode: "remember", site: "mercadopago.com.ar", category: "click", rules }).ask, true);
	assert.equal(decideStep({ mode: "remember", site: "example.com", category: "click", rules }).ask, true);
	assert.equal(decideStep({ mode: "remember", site: "", category: "click", rules: { "": { click: "allow" } } }).ask, true);
	for (const bad of [undefined, null, "x", { "mercadopago.com": "allow" }, { "mercadopago.com": { click: true } }]) {
		assert.equal(decideStep({ mode: "remember", site: "mercadopago.com", category: "click", rules: bad }).ask, true, JSON.stringify(bad));
	}
});

test("saved rules are validated on read: invalid sites, categories and decisions are dropped", () => {
	const stored = {
		"example.com": { click: "allow", money: "deny", bogus: "allow", type: "maybe" },
		"WWW.Upper.test": { click: "allow" },
		"__proto__": { click: "allow" },
		"empty.test": {},
		"list.test": ["allow"],
		"text.test": "allow",
	};
	assert.deepEqual(normalizeRules(stored), { "example.com": { click: "allow", money: "deny" } });
	for (const bad of [undefined, null, "x", [], 3]) assert.deepEqual(normalizeRules(bad), {}, String(bad));
});

test("withRule, withoutRule and withoutSite return new rules and keep the others", () => {
	const rules = withRule({ "a.test": { click: "allow" } }, "b.test", "money", "deny");
	assert.deepEqual(rules, { "a.test": { click: "allow" }, "b.test": { money: "deny" } });
	assert.deepEqual(withRule(rules, "a.test", "click", "deny"), { "a.test": { click: "deny" }, "b.test": { money: "deny" } });
	assert.deepEqual(withRule(rules, "", "click", "allow"), rules);
	assert.deepEqual(withRule(rules, "a.test", "bogus", "allow"), rules);
	assert.deepEqual(withRule(rules, "a.test", "click", "maybe"), rules);
	assert.deepEqual(withoutRule(rules, "b.test", "money"), { "a.test": { click: "allow" } });
	assert.deepEqual(withoutRule(rules, "a.test", "type"), rules);
	assert.deepEqual(withoutSite(rules, "a.test"), { "b.test": { money: "deny" } });
	assert.deepEqual(withoutSite(rules, "WWW.A.test"), { "b.test": { money: "deny" } });
	assert.deepEqual(rules, { "a.test": { click: "allow" }, "b.test": { money: "deny" } });
});

test("readAnswer: a saved decision counts only when it was offered and matches the answer", () => {
	assert.deepEqual(readAnswer(true, false), { approved: true });
	assert.deepEqual(readAnswer({ approved: true }, true), { approved: true });
	assert.deepEqual(readAnswer({ approved: true, remember: "allow" }, true), { approved: true, remember: "allow" });
	assert.deepEqual(readAnswer({ approved: false, remember: "deny" }, true), { approved: false, remember: "deny" });
	assert.deepEqual(readAnswer({ approved: true, remember: "allow" }, false), { approved: true });
	assert.deepEqual(readAnswer({ approved: false, remember: "allow" }, true), { approved: false });
	assert.deepEqual(readAnswer({ approved: true, remember: "deny" }, true), { approved: true });
	assert.deepEqual(readAnswer({ approved: true, remember: "always" }, true), { approved: true });
	for (const bad of [false, undefined, null, "yes", 1, { approved: "true" }]) assert.deepEqual(readAnswer(bad, true), { approved: false }, String(bad));
});

// S11: risky pages are detected from their content.

const input = (facts: Record<string, unknown>) => ({ type: "text", autocomplete: "", name: "", id: "", label: "", ...facts });
const signals = (facts: Record<string, unknown>) => ({ fields: [], submits: [], frames: [], headings: [], ...facts });
const HARMLESS = signals({ fields: [input({ type: "search", name: "q", label: "Search" })], submits: ["Next"], frames: ["https://www.youtube.com/embed/x"], headings: ["Results for cats"] });

test("a visible password field makes the page risky", () => {
	assert.deepEqual(pageRiskFromSignals(signals({ fields: [input({ name: "user" }), input({ type: "password", name: "pw" })] })), { risky: true, reason: "the page has a password field" });
});

test("card, bank account and one-time code fields make the page risky, in English and Spanish", () => {
	for (const field of [
		input({ autocomplete: "cc-number" }),
		input({ autocomplete: "section-x cc-exp" }),
		input({ autocomplete: "one-time-code" }),
		input({ name: "cardNumber" }),
		input({ id: "card_number" }),
		input({ label: "Card number" }),
		input({ name: "cvc" }),
		input({ label: "CVV" }),
		input({ name: "expiryDate" }),
		input({ label: "Expiration date" }),
		input({ name: "iban" }),
		input({ label: "Routing number" }),
		input({ name: "accountNumber" }),
		input({ label: "Número de tarjeta" }),
		input({ label: "Fecha de vencimiento" }),
		input({ name: "numero_cuenta" }),
		input({ label: "CLABE interbancaria" }),
		input({ id: "cbu" }),
	]) {
		const verdict = pageRiskFromSignals(signals({ fields: [field] }));
		assert.equal(verdict.risky, true, JSON.stringify(field));
		assert.match(verdict.reason ?? "", /^the page has a .*(field)$/, JSON.stringify(field));
	}
});

test("a form submit control with a risky verb makes the page risky", () => {
	assert.deepEqual(pageRiskFromSignals(signals({ submits: ["Search", "Pagar ahora"] })), { risky: true, reason: 'the page has a "Pagar ahora" button (pagar)' });
	for (const name of ["Pay now", "Transfer", "Transferír", "Delete", "Send money"]) assert.equal(pageRiskFromSignals(signals({ submits: [name] })).risky, true, name);
});

test("a visible payment frame from a known provider makes the page risky; look-alikes do not", () => {
	for (const src of [
		"https://js.stripe.com/v3/elements-inner-card.html",
		"https://checkout.stripe.com/pay/cs_1",
		"https://www.paypal.com/smart/buttons",
		"https://www.mercadopago.com.ar/checkout/v1",
		"https://checkoutshopper-live.adyen.com/checkoutshopper/securedfields",
		"https://assets.braintreegateway.com/web/hosted-fields",
		"https://js.checkout.com/frames",
		"https://web.squarecdn.com/v1/square.js",
	]) {
		const verdict = pageRiskFromSignals(signals({ frames: [src] }));
		assert.equal(verdict.risky, true, src);
		assert.equal(verdict.reason, `the page embeds a payment form from ${new URL(src).hostname}`, src);
	}
	for (const src of ["https://notpaypal.com/x", "https://www.squarespace.com/embed", "https://stripe.com.evil.test/", "not a url", "about:blank"]) {
		assert.deepEqual(pageRiskFromSignals(signals({ frames: [src] })), { risky: false }, src);
	}
});

test("a title or heading about account security, billing or payment methods makes the page risky, in English and Spanish", () => {
	for (const heading of ["Change password", "Cambiar contraseña", "Two-factor authentication", "Verificación en dos pasos", "Delete account", "Eliminar cuenta", "Billing", "Facturación", "Payment methods", "Métodos de pago", "Security", "Seguridad"]) {
		const verdict = pageRiskFromSignals(signals({ headings: ["Welcome", heading] }));
		assert.equal(verdict.risky, true, heading);
		assert.match(verdict.reason ?? "", new RegExp(`^the page is about ${JSON.stringify(heading)} \\(`), heading);
	}
});

test("a harmless page (search box and a Next button) is not risky", () => {
	assert.deepEqual(pageRiskFromSignals(HARMLESS), { risky: false });
	assert.deepEqual(pageRiskFromSignals(signals({})), { risky: false });
});

test("content that could not be read is treated as risky", () => {
	for (const bad of [null, undefined, "x", 3]) assert.deepEqual(pageRiskFromSignals(bad), { risky: true, reason: "the page content could not be inspected" }, String(bad));
});

const PASSWORD_PAGE = signals({ fields: [input({ type: "password" })] });

test("isRiskyPage adds content signals to the list and heuristics, and without signals it is unchanged", () => {
	assert.deepEqual(isRiskyPage(SAFE_PAGE, LIST, PASSWORD_PAGE), { risky: true, reason: "the page has a password field" });
	assert.deepEqual(isRiskyPage(SAFE_PAGE, LIST, HARMLESS), { risky: false });
	assert.deepEqual(isRiskyPage(SAFE_PAGE, LIST), { risky: false });
	assert.match(isRiskyPage("https://www.paypal.com/", LIST, PASSWORD_PAGE).reason ?? "", /paypal\.com is on your risky pages list/);
	assert.deepEqual(isRiskyPage("about:blank", LIST, PASSWORD_PAGE), { risky: true, reason: "the page has a password field" });
});

test("any action on a page whose content is risky is risky", () => {
	for (const kind of ["click", "type", "key", "scroll"] as const) {
		const verdict = classifyAction({ kind, key: "ArrowDown", element: field({ name: "Next" }), pageUrl: SAFE_PAGE, riskyDomains: LIST, pageSignals: PASSWORD_PAGE });
		assert.deepEqual(verdict, { risky: true, reason: "acting on a risky page: the page has a password field" }, kind);
	}
	assert.deepEqual(classifyAction({ kind: "click", element: field({ name: "Next" }), pageUrl: SAFE_PAGE, riskyDomains: LIST, pageSignals: HARMLESS }), { risky: false });
});

test("the agent can only raise risk: true asks, false or any non-boolean changes nothing", () => {
	assert.equal(AGENT_RISKY, "the agent marked this step as sensitive");
	const next = field({ name: "Next" });
	assert.deepEqual(classifyAction({ kind: "click", element: next, pageUrl: SAFE_PAGE, riskyDomains: LIST, agentRisky: true }), { risky: true, reason: AGENT_RISKY });
	for (const value of [false, "true", 1, null, undefined]) {
		assert.deepEqual(classifyAction({ kind: "click", element: next, pageUrl: SAFE_PAGE, riskyDomains: LIST, agentRisky: value }), { risky: false }, String(value));
	}
	const pay = classifyAction({ kind: "click", element: field({ tag: "button", type: undefined, name: "Pay now" }), pageUrl: SAFE_PAGE, riskyDomains: LIST, agentRisky: false });
	assert.deepEqual(pay, { risky: true, reason: 'clicking "Pay now" (pay)' });
});
