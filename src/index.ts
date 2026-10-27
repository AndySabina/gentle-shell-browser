import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askApproval } from "./approval.ts";
import { BrowserController } from "./controller.ts";
import { configDir } from "./token.ts";
import { registerBrowserTools } from "./tools.ts";

function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export const USAGE = "Usage: /browser [status | start | stop | update | level [always | remember | never] | rules [clear [site]]]";
const SUBCOMMANDS = ["status", "start", "stop", "update", "level", "rules"];
/** The permission modes; the extension stores the mode under its old name, `level`. */
const MODES: Record<string, string> = {
	always: "Always ask — asks before every step",
	remember: "Remember my decisions — asks, and you can save allow or deny per site and action type",
	never: "Never ask — does whatever you tell it; only the session group and STOP limit it",
};
/** The order categories are listed in, as in the extension. */
const CATEGORIES = ["navigate", "click", "type", "key", "scroll", "money", "irreversible"];

/** What the /browser commands need from the controller. */
type CommandController = Pick<BrowserController, "port" | "status" | "call">;
interface CommandContext {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

function errorLine(error: unknown): string {
	return `Gentle Chrome: ${error instanceof Error ? error.message : String(error)}`;
}

/** `/browser level [mode]`. Only the user reaches this: no tool calls getLevel or setLevel. */
export async function levelCommand(controller: CommandController, name: string | undefined, context: CommandContext): Promise<string[]> {
	if (name !== undefined && !Object.hasOwn(MODES, name)) return [USAGE];
	if (controller.port() === undefined) return controller.status();
	try {
		if (name === undefined) {
			const { level } = (await controller.call("getLevel", {})) as { level: string };
			return [`Gentle Chrome: permission mode is ${MODES[level] ?? level}.`];
		}
		if (name === "never") {
			const confirmed =
				context.hasUI &&
				(await context.ui.confirm(
					"Switch Gentle Chrome to Never ask?",
					"Nothing will ask for your approval anymore: the agent does whatever it is told, payments and deletions included. Only the session's tab group and STOP limit it.",
				));
			if (!confirmed) return ["Gentle Chrome: mode unchanged."];
		}
		const { level } = (await controller.call("setLevel", { level: name })) as { level: string };
		return [`Gentle Chrome: permission mode set to ${MODES[level] ?? level}.`];
	} catch (error) {
		return [errorLine(error)];
	}
}

/** `/browser rules [clear [site]]`: the decisions saved in remember mode. Only the user reaches this. */
export async function rulesCommand(controller: CommandController, args: string[], context: CommandContext): Promise<string[]> {
	const [action, site, ...extra] = args;
	if ((action !== undefined && action !== "clear") || extra.length > 0) return [USAGE];
	if (controller.port() === undefined) return controller.status();
	try {
		if (action === undefined) {
			const { rules } = (await controller.call("getRules", {})) as { rules: Record<string, Record<string, string>> };
			const lines = Object.keys(rules)
				.sort()
				.flatMap((name) => CATEGORIES.filter((category) => Object.hasOwn(rules[name], category)).map((category) => `${name} — ${category}: ${rules[name][category]}`));
			return lines.length ? ["Gentle Chrome: saved decisions:", ...lines] : ["Gentle Chrome: no saved decisions."];
		}
		if (site !== undefined) {
			await controller.call("clearRules", { site });
			return [`Gentle Chrome: cleared the saved decisions for ${site}.`];
		}
		const confirmed = context.hasUI && (await context.ui.confirm("Clear every saved decision?", "Remember mode will ask again for every site and action type."));
		if (!confirmed) return ["Gentle Chrome: saved decisions unchanged."];
		await controller.call("clearRules", {});
		return ["Gentle Chrome: cleared every saved decision."];
	} catch (error) {
		return [errorLine(error)];
	}
}

export default function gentleChrome(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	const controller = new BrowserController({
		configDir: configDir(process.env, homedir()),
		// Unset: scan the session port range, so several sessions run side by side.
		port: parsePort(process.env.GENTLE_CHROME_PORT),
		sessionName: () => pi.getSessionName()?.trim() || basename(process.cwd()),
		abort: () => ctx?.abort(),
		setStatus: (text) => ctx?.ui.setStatus("gentle-chrome", text),
		notify: (text) => ctx?.ui.notify(text, "info"),
		// The extension decided this step needs approval; the user answers here.
		handlers: { approve: (params) => askApproval(ctx, params) },
	});

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		await controller.start();
	});
	pi.on("session_shutdown", async () => {
		await controller.stop();
	});

	registerBrowserTools(pi, (method, params) => controller.call(method, params));

	pi.registerCommand("browser", {
		description: "Control your Chrome from this session: /browser [status | start | stop | update | level [always | remember | never] | rules [clear [site]]]",
		getArgumentCompletions: (prefix) => {
			const level = /^level\s+(\S*)$/.exec(prefix);
			if (level) return Object.keys(MODES).filter((name) => name.startsWith(level[1])).map((name) => ({ value: `level ${name}`, label: name }));
			const rules = /^rules\s+(\S*)$/.exec(prefix);
			if (rules) return "clear".startsWith(rules[1]) ? [{ value: "rules clear", label: "clear" }] : [];
			return SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
		},
		handler: async (args, context) => {
			ctx = context;
			const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const name = rest[0];
			let lines: string[];
			if (action === "status") lines = controller.status();
			else if (action === "start") lines = await controller.start();
			else if (action === "stop") {
				await controller.stop();
				lines = ["Gentle Chrome: stopped."];
			} else if (action === "update") lines = await controller.update();
			else if (action === "level") lines = await levelCommand(controller, name, context);
			else if (action === "rules") lines = await rulesCommand(controller, rest, context);
			else lines = [USAGE];
			context.ui.notify(lines.join("\n"), "info");
		},
	});
}
