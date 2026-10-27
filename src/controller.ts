import { type Bridge, type ExtensionInfo, type Handler, startBridge } from "./bridge.ts";
import { listenOnFreePort, newSessionId, normalizeSessionName, removeSessionRecord, writeSessionRecord } from "./sessions.ts";
import { loadOrCreateToken } from "./token.ts";
import { buildId, installExtension, REPO_EXTENSION_DIR, recordedTarget } from "./update.ts";

const HOST = "127.0.0.1";
const RELOAD_ATTEMPTS = 10;
const RELOAD_RETRY_MS = 30_000;
const NO_TARGET = "run scripts/install-extension.sh once to enable automatic updates.";
const MANUAL_RELOAD = "Gentle Chrome: copied the new extension; reload it once in chrome://extensions (Gentle Shell Browser card) — after that it updates itself.";

function updateFailed(reason: unknown): string {
	return `Gentle Chrome: could not update the Chrome extension: ${reason instanceof Error ? reason.message : String(reason)}`;
}

export interface ControllerDeps {
	configDir: string;
	/** Listen on exactly this port; when unset, the first free port of the session range. */
	port?: number;
	/** The name shown to the user for this session, such as the Pi session name or the folder name. */
	sessionName(): string;
	/** Aborts the running agent turn (the user pressed STOP in Chrome). */
	abort(): void;
	setStatus?(text: string | undefined): void;
	/** Shows the browser tools to the model while Chrome is connected, and hides them otherwise. */
	setBrowserToolsActive?(active: boolean): void;
	/** Extra methods the Chrome extension may call, such as approval prompts. */
	handlers?: Record<string, Handler>;
	/** Tells the user what happened outside a command, such as an extension update. */
	notify?(text: string): void;
	/** The extension/ folder updates are copied from; defaults to this checkout's. */
	extensionDir?: string;
	/** Wait before asking a busy extension to reload again. */
	updateRetryMs?: number;
}

/** Owns the bridge for one Pi session and turns its state into user-facing lines. */
export class BrowserController {
	/** Identifies this Pi session to the Chrome extension; fixed for the controller's lifetime. */
	readonly sessionId: string;
	private bridge: Bridge | undefined;
	/** The name in this session's record, set when it starts listening. */
	private name = "";
	/** Removes the session record if the process exits without stop(). */
	private exitCleanup: (() => void) | undefined;
	private starting: Promise<string[]> | undefined;
	private readonly deps: ControllerDeps;
	/** The running update; resolves to the line for the user, or undefined once Chrome reloads. */
	private updating: Promise<string | undefined> | undefined;
	/** The build the extension was asked to reload into. */
	private expected: string | undefined;
	/** "old -> new" already copied for an extension that cannot reload itself. */
	private manual: string | undefined;
	private outdatedNoticed = false;

	constructor(deps: ControllerDeps) {
		this.deps = deps;
		this.sessionId = newSessionId();
	}

	port(): number | undefined {
		return this.bridge?.port;
	}

	start(): Promise<string[]> {
		if (this.bridge) return Promise.resolve(this.status());
		this.starting ??= this.open().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		const bridge = this.bridge;
		this.bridge = undefined;
		this.unregister();
		if (bridge) await bridge.close();
		this.deps.setStatus?.(undefined);
		this.deps.setBrowserToolsActive?.(false);
	}

	status(): string[] {
		if (!this.bridge) return ["Gentle Chrome: not running. Run /browser start."];
		const info = this.bridge.connected();
		const where = `session "${this.name}" (${this.sessionId}) listening on ${HOST}:${this.bridge.port}`;
		return info
			? [`Gentle Chrome: ${where}, Chrome connected (extension ${info.version}).`]
			: [`Gentle Chrome: ${where}, Chrome not connected; the browser tools appear when it connects.`];
	}

	/** `/browser update`: copies the extension to its recorded folder now and reloads it if Chrome runs another build. */
	async update(): Promise<string[]> {
		const bridge = this.bridge;
		if (!bridge) return this.status();
		if (this.updating) return ["Gentle Chrome: an update is already running."];
		try {
			const target = recordedTarget(this.deps.configDir);
			if (!target) return [`Gentle Chrome: no extension folder recorded; ${NO_TARGET}`];
			const build = buildId(this.extensionDir());
			const from = bridge.connected()?.build;
			if (from === undefined || from === build) {
				installExtension({ sourceDir: this.extensionDir(), targetDir: target, configDir: this.deps.configDir });
				return [from === undefined ? `Gentle Chrome: copied build ${build} to ${target}; Chrome is not connected, so it updates when it connects.` : `Gentle Chrome: the Chrome extension is up to date (${build}).`];
			}
			return [(await this.run(target, from, build)) ?? `Gentle Chrome: copied build ${build} to ${target}; Chrome is reloading the extension.`];
		} catch (error) {
			return [updateFailed(error)];
		}
	}

	/** Sends a command to the Chrome extension. */
	call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
		if (!this.bridge) return Promise.reject(new Error("Gentle Chrome is not running. Ask the user to run /browser start."));
		return this.bridge.call(method, params, options);
	}

	private async open(): Promise<string[]> {
		let bridge: Bridge | undefined;
		try {
			const listen = async (port: number) => {
				bridge = await this.listen(port);
			};
			// An explicit port (GENTLE_CHROME_PORT) is the only one tried. Otherwise
			// each session scans for its own free port, so two sessions never clash.
			if (this.deps.port !== undefined) await listen(this.deps.port);
			else await listenOnFreePort(listen);
			if (!bridge) throw new Error("the bridge did not start");
			this.name = normalizeSessionName(this.deps.sessionName());
			this.register(bridge.port);
		} catch (error) {
			this.unregister();
			await bridge?.close();
			return [`Gentle Chrome: ${error instanceof Error ? error.message : String(error)}`];
		}
		this.bridge = bridge;
		this.deps.setStatus?.("Chrome: waiting");
		return this.status();
	}

	private listen(port: number): Promise<Bridge> {
		return startBridge({
			host: HOST,
			port,
			sessionId: this.sessionId,
			token: loadOrCreateToken(this.deps.configDir),
			handlers: {
				...this.deps.handlers,
				stop: () => {
					this.deps.abort();
					return { stopped: true };
				},
			},
			onConnectionChange: (info) => {
				this.deps.setStatus?.(info ? "Chrome: connected" : "Chrome: waiting");
				this.deps.setBrowserToolsActive?.(info !== undefined);
				if (info) this.connected(info);
			},
		});
	}

	/** Writes this session's record so the Chrome extension can find it. */
	private register(port: number): void {
		const { configDir } = this.deps;
		const id = this.sessionId;
		writeSessionRecord(configDir, { id, name: this.name, port, pid: process.pid });
		this.exitCleanup = () => {
			try {
				removeSessionRecord(configDir, id);
			} catch {}
		};
		process.once("exit", this.exitCleanup);
	}

	private unregister(): void {
		if (!this.exitCleanup) return;
		process.off("exit", this.exitCleanup);
		this.exitCleanup();
		this.exitCleanup = undefined;
	}

	private extensionDir(): string {
		return this.deps.extensionDir ?? REPO_EXTENSION_DIR;
	}

	private notify(text: string): void {
		this.deps.notify?.(text);
	}

	/** An extension connected: update it when it runs another build than this checkout's. */
	private connected(info: ExtensionInfo): void {
		if (this.expected !== undefined && info.build === this.expected) {
			this.expected = undefined;
			return this.notify(`Gentle Chrome: the Chrome extension updated itself to ${info.build}.`);
		}
		if (this.updating) return;
		try {
			const build = buildId(this.extensionDir());
			if (info.build === build) return;
			const target = recordedTarget(this.deps.configDir);
			if (!target) {
				if (!this.outdatedNoticed) this.notify(`Gentle Chrome: the Chrome extension is outdated; ${NO_TARGET}`);
				this.outdatedNoticed = true;
				return;
			}
			if (this.manual === `${info.build} -> ${build}`) return;
			void this.run(target, info.build, build).then((line) => line && this.notify(line));
		} catch (error) {
			this.notify(updateFailed(error));
		}
	}

	/** One update at a time: copy the files, then ask the extension to reload. */
	private run(target: string, from: string, build: string): Promise<string | undefined> {
		this.updating = this.deliver(target, from, build).finally(() => {
			this.updating = undefined;
		});
		return this.updating;
	}

	private async deliver(target: string, from: string, build: string): Promise<string | undefined> {
		this.notify(`Gentle Chrome: updating the Chrome extension (${from} -> ${build})…`);
		try {
			installExtension({ sourceDir: this.extensionDir(), targetDir: target, configDir: this.deps.configDir });
		} catch (error) {
			return updateFailed(error);
		}
		for (let attempt = 1; ; attempt++) {
			if (!this.bridge) return undefined;
			const info = this.bridge.connected();
			if (!info) return `Gentle Chrome: copied build ${build} to ${target}; Chrome is not connected, so it updates when it connects.`;
			if (info.build === build) return `Gentle Chrome: the Chrome extension is up to date (${build}).`;
			this.expected = build;
			try {
				await this.bridge.call("reload", {});
				return undefined;
			} catch (error) {
				this.expected = undefined;
				const message = error instanceof Error ? error.message : String(error);
				if (message === "Unknown method: reload") {
					// An extension from before self-update: only the user can reload it.
					this.manual = `${from} -> ${build}`;
					return MANUAL_RELOAD;
				}
				if (!message.startsWith("Busy:")) return updateFailed(message);
				if (attempt >= RELOAD_ATTEMPTS) return updateFailed("an action kept running; run /browser update when it is idle.");
				await new Promise((resolve) => setTimeout(resolve, this.deps.updateRetryMs ?? RELOAD_RETRY_MS).unref());
			}
		}
	}
}
