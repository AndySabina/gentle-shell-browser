import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/**
 * The terminal side of an approval. The Chrome extension decides that a step
 * needs approval and refuses it unless the user picks "Allow once" here
 * ("Deny" is listed first, so it is the default). In remember mode the
 * request names the site and category, and the user may also save "Always
 * allow" or "Always deny" for them; the extension stores that decision.
 */

export type Category = "navigate" | "click" | "type" | "key" | "scroll" | "money" | "irreversible";

export interface ApprovalRequest {
	kind: "navigate" | "open" | "action";
	title: string;
	detail: string;
	url: string;
	reason: string;
	/** The permission mode. */
	level?: string;
	/** Offered only in remember mode: the answer may be saved for this site and category. */
	remember?: { site: string; category: Category };
}

export interface ApprovalAnswer {
	approved: boolean;
	remember?: "allow" | "deny";
}

export interface ApprovalContext {
	hasUI: boolean;
	ui: { select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> };
}

export const ALLOW_ONCE = "Allow once";
export const DENY = "Deny";
/** The extension waits 5 minutes; the prompt closes with it. */
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const KINDS = new Set(["navigate", "open", "action"]);
const MODE_NAMES: Record<string, string> = { always: "Always ask", remember: "Remember my decisions", never: "Never ask" };
/** "Always allow <label> on <site>"; the same words as the extension's popup. */
export const CATEGORY_LABELS: Record<Category, string> = {
	navigate: "opening pages",
	click: "clicks",
	type: "typing",
	key: "key presses",
	scroll: "scrolling",
	money: "payments and transfers",
	irreversible: "deleting, passwords and security changes",
};

/**
 * Page text reaches the terminal: drop control characters (escape sequences),
 * bidi overrides that reorder what the user reads, and line separators; clip.
 */
function clean(text: string, max = 300): string {
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `remember` when it is a site and a known category; undefined when it is not valid. */
function parseRemember(value: unknown): ApprovalRequest["remember"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { site, category } = value as Record<string, unknown>;
	if (typeof site !== "string" || !clean(site, 253) || typeof category !== "string" || !Object.hasOwn(CATEGORY_LABELS, category)) return undefined;
	return { site: clean(site, 253), category: category as Category };
}

export function parseApprovalRequest(value: unknown): ApprovalRequest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const request = value as Record<string, unknown>;
	if (typeof request.kind !== "string" || !KINDS.has(request.kind)) return undefined;
	if (typeof request.title !== "string" || !request.title.trim()) return undefined;
	for (const key of ["detail", "url", "reason"]) if (typeof request[key] !== "string") return undefined;
	const remember = request.remember === undefined ? undefined : parseRemember(request.remember);
	if (request.remember !== undefined && !remember) return undefined;
	return {
		kind: request.kind as ApprovalRequest["kind"],
		title: request.title,
		detail: request.detail as string,
		url: request.url as string,
		reason: request.reason as string,
		level: typeof request.level === "string" ? request.level : undefined,
		...(remember ? { remember } : {}),
	};
}

export async function askApproval(context: ApprovalContext | undefined, value: unknown, signal?: AbortSignal): Promise<ApprovalAnswer> {
	const request = parseApprovalRequest(value);
	if (!request || !context?.hasUI) return { approved: false };
	const lines = [`Gentle Shell wants to ${clean(request.title)}`];
	if (request.detail.trim()) lines.push(clean(request.detail));
	if (request.url.trim()) lines.push(`URL: ${clean(request.url, 500)}`);
	if (request.reason.trim()) lines.push(`Why: ${clean(request.reason)}`);
	if (request.level && MODE_NAMES[request.level]) lines.push(`Mode: ${MODE_NAMES[request.level]}`);
	const answers = new Map<string, ApprovalAnswer>([
		[DENY, { approved: false }],
		[ALLOW_ONCE, { approved: true }],
	]);
	if (request.remember) {
		const { site, category } = request.remember;
		answers.set(`Always allow ${CATEGORY_LABELS[category]} on ${site}`, { approved: true, remember: "allow" });
		answers.set(`Always deny ${CATEGORY_LABELS[category]} on ${site}`, { approved: false, remember: "deny" });
	}
	try {
		// Deny comes first so that it is the default choice.
		const choice = await context.ui.select(lines.join("\n"), [...answers.keys()], { signal, timeout: PROMPT_TIMEOUT_MS });
		return (choice !== undefined && answers.get(choice)) || { approved: false };
	} catch {
		return { approved: false };
	}
}
