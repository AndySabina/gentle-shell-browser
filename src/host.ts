import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { listSessions } from "./sessions.ts";
import { configDir, loadOrCreateToken } from "./token.ts";

/**
 * Chrome native messaging host. Windows Chrome starts it (through a .bat that
 * runs wsl.exe) when the extension asks, so the extension gets the token and
 * the live sessions without a pairing code. Only the extension whose id is in
 * the host manifest's allowed_origins can start it.
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

/** The host manifest Chrome reads from the registry path, and the .bat it points at. */
export function nativeHostFiles(options: { nodePath: string; hostScript: string; extensionId: string; hostDirWindows: string; distro: string }): {
	manifest: { name: string; description: string; path: string; type: "stdio"; allowed_origins: string[] };
	bat: string;
} {
	// wsl.exe keeps quotes as part of the -d value, so the name goes unquoted.
	if (options.distro && !/^[A-Za-z0-9._-]+$/.test(options.distro)) throw new Error(`Invalid WSL distribution name: ${options.distro}`);
	// Quoted inside a batch file: a quote, %variable%, line break or cmd operator would change what it runs.
	for (const path of [options.nodePath, options.hostScript]) if (/["%\r\n^&|<>]/.test(path)) throw new Error(`Unsafe path for the native host: ${path}`);
	const distro = options.distro ? `-d ${options.distro} ` : "";
	return {
		manifest: {
			name: HOST_NAME,
			description: "Gentle Shell browser bridge",
			path: `${options.hostDirWindows}\\gentle-shell-host.bat`,
			type: "stdio",
			allowed_origins: [`chrome-extension://${options.extensionId}/`],
		},
		bat: `@echo off\r\nwsl.exe ${distro}-e "${options.nodePath}" "${options.hostScript}"\r\n`,
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
			reply(handleRequest(messages[0], configDir(process.env, homedir())));
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
