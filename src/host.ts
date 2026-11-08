import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions } from "./sessions.ts";
import { configDir, loadOrCreateToken } from "./token.ts";

/**
 * Chrome native messaging host. Chrome starts it when the extension asks, so
 * the extension gets the token and the live sessions without a pairing code:
 * Windows Chrome with Gentle Shell in WSL through a .bat that runs wsl.exe,
 * Windows Chrome through a .bat that runs node.exe, and Linux or macOS Chrome
 * through a shell launcher. Only the extension whose id is in the host
 * manifest's allowed_origins can start it.
 */

export const HOST_NAME = "dev.gentle.shell";
const MAX_MESSAGE = 1024 * 1024;

/** Chrome's id for an extension: sha256 of its DER public key, first 32 hex digits, 0-f mapped to a-p. */
export function extensionIdFromKey(base64Der: string): string {
	const hex = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((digit) => "abcdefghijklmnop"[Number.parseInt(digit, 16)]).join("");
}

/** The id fixed by the "key" in extension/manifest.json. */
export const EXTENSION_ID = "gcbchempcjebjgkmonbaheclgfnklgkp";

/** A native message: 4-byte little-endian length, then UTF-8 JSON. */
export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length);
	return Buffer.concat([header, body]);
}

/** Collects stdin chunks and returns every complete message; throws on a bad length or bad JSON. */
export class MessageReader {
	private buffered = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffered = Buffer.concat([this.buffered, chunk]);
		const messages: unknown[] = [];
		while (this.buffered.length >= 4) {
			const length = this.buffered.readUInt32LE(0);
			if (length > MAX_MESSAGE) throw new Error("Message too large");
			if (this.buffered.length < 4 + length) break;
			const body = this.buffered.subarray(4, 4 + length).toString("utf8");
			this.buffered = this.buffered.subarray(4 + length);
			messages.push(JSON.parse(body));
		}
		return messages;
	}
}

export type HostReply = { token: string; sessions: { id: string; name: string; port: number }[] } | { error: string };

export function handleRequest(request: unknown, dir: string): HostReply {
	if (!request || typeof request !== "object" || (request as { type?: unknown }).type !== "discover") return { error: "unknown request" };
	const token = loadOrCreateToken(dir);
	const sessions = listSessions(dir).map(({ id, name, port }) => ({ id, name, port }));
	return { token, sessions };
}

/**
 * The config folder the host reads. Install writes the session's folder into
 * the launcher as `--config-dir <dir>`, because Chrome starts the host with the
 * user's normal environment, which a private Gentle Shell layout does not
 * share. A host installed without it resolves the folder from its environment.
 */
export function hostConfigDir(
	args: string[],
	env: Record<string, string | undefined>,
	home: string,
	isAbsolute: (dir: string) => boolean = process.platform === "win32" ? win32.isAbsolute : (dir) => dir.startsWith("/"),
): string {
	const at = args.indexOf("--config-dir");
	if (at === -1) return configDir(env, home);
	const dir = args[at + 1];
	if (!dir || !isAbsolute(dir)) throw new Error("--config-dir needs an absolute folder");
	return dir;
}

export interface HostManifest {
	name: string;
	description: string;
	path: string;
	type: "stdio";
	allowed_origins: string[];
}

/** The manifest Chrome reads to find the launcher at `path`. */
function hostManifest(path: string, extensionId: string): HostManifest {
	return { name: HOST_NAME, description: "Gentle Shell browser bridge", path, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] };
}

/** Throws for a path that would change what a batch file runs. */
function checkBatchPaths(paths: string[], configDir: string): void {
	// Quoted inside a batch file: a quote, %variable%, line break or cmd operator would change what it runs.
	for (const path of paths) if (/["%\r\n^&|<>]/.test(path)) throw new Error(`Unsafe path for the native host: ${path}`);
	// The folder is the last quoted argument: a trailing backslash would escape its closing quote.
	if (configDir.endsWith("\\")) throw new Error(`Unsafe path for the native host: ${configDir}`);
}

/** The host manifest Chrome reads from the registry path, and the .bat it points at. */
export function nativeHostFiles(options: { nodePath: string; hostScript: string; extensionId: string; hostDirWindows: string; distro: string; configDir: string }): {
	manifest: HostManifest;
	bat: string;
} {
	// wsl.exe keeps quotes as part of the -d value, so the name goes unquoted.
	if (options.distro && !/^[A-Za-z0-9._-]+$/.test(options.distro)) throw new Error(`Invalid WSL distribution name: ${options.distro}`);
	checkBatchPaths([options.nodePath, options.hostScript, options.configDir], options.configDir);
	// The host starts in a Windows working folder, where a relative folder means something else.
	if (!options.configDir.startsWith("/")) throw new Error(`Native host config folder must be an absolute path: ${options.configDir}`);
	const distro = options.distro ? `-d ${options.distro} ` : "";
	return {
		manifest: hostManifest(`${options.hostDirWindows}\\gentle-shell-host.bat`, options.extensionId),
		// Full path: Chrome started from WSL may hand the host a PATH without System32.
		bat: `@echo off\r\n%SystemRoot%\\System32\\wsl.exe ${distro}-e "${options.nodePath}" "${options.hostScript}" --config-dir "${options.configDir}"\r\n`,
	};
}

/** For native Windows Chrome: the manifest and a .bat in `hostDir` that runs node.exe directly. */
export function windowsHostFiles(options: { nodePath: string; hostScript: string; extensionId: string; hostDir: string; configDir: string }): { manifest: HostManifest; bat: string } {
	checkBatchPaths([options.nodePath, options.hostScript, options.configDir], options.configDir);
	// Chrome starts the host in its own working folder, where a relative folder means something else.
	if (!win32.isAbsolute(options.configDir)) throw new Error(`Native host config folder must be an absolute path: ${options.configDir}`);
	return {
		manifest: hostManifest(`${options.hostDir}\\gentle-shell-host.bat`, options.extensionId),
		bat: `@echo off\r\n"${options.nodePath}" "${options.hostScript}" --config-dir "${options.configDir}"\r\n`,
	};
}

/** A word the shell reads as it is: single-quoted, each ' written as '\''. */
function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** For Linux and macOS Chrome: the manifest and an executable shell launcher in `hostDir`. */
export function posixHostFiles(options: { nodePath: string; hostScript: string; extensionId: string; hostDir: string; configDir: string }): { manifest: HostManifest; launcher: string } {
	// A line break would end the exec line, whatever the quoting.
	for (const path of [options.nodePath, options.hostScript, options.configDir, options.hostDir]) if (/[\r\n]/.test(path)) throw new Error(`Unsafe path for the native host: ${path}`);
	// Chrome starts the host in its own working folder, where a relative folder means something else.
	if (!options.configDir.startsWith("/")) throw new Error(`Native host config folder must be an absolute path: ${options.configDir}`);
	return {
		manifest: hostManifest(`${options.hostDir}/gentle-shell-host.sh`, options.extensionId),
		launcher: `#!/bin/sh\nexec ${shellQuote(options.nodePath)} ${shellQuote(options.hostScript)} --config-dir ${shellQuote(options.configDir)}\n`,
	};
}

/** Reads one message, writes one reply and exits. stdout carries only the framed reply. */
function serve(): void {
	const reader = new MessageReader();
	let done = false;
	const reply = (message: HostReply) => {
		done = true;
		process.stdin.pause();
		process.stdout.write(encodeMessage(message), () => process.exit(0));
	};
	process.stdin.on("data", (chunk: Buffer) => {
		if (done) return;
		let messages: unknown[];
		try {
			messages = reader.push(chunk);
		} catch (error) {
			process.stderr.write(`gentle-shell-host: ${error instanceof Error ? error.message : String(error)}\n`);
			return reply({ error: "bad request" });
		}
		if (messages.length === 0) return;
		try {
			reply(handleRequest(messages[0], hostConfigDir(process.argv.slice(2), process.env, homedir())));
		} catch (error) {
			process.stderr.write(`gentle-shell-host: ${error instanceof Error ? error.message : String(error)}\n`);
			reply({ error: "host error" });
		}
	});
	process.stdin.on("end", () => {
		if (done) return;
		process.stderr.write("gentle-shell-host: stdin closed before a complete message\n");
		process.exit(1);
	});
}

// (import.meta.main needs Node 24.2; the package supports 22.18.)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
