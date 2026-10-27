import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every Gentle Shell session listens on its own port in a fixed range and
 * registers itself in <configDir>/sessions/<id>.json, so the Chrome extension
 * can find and connect to each live session.
 */

export const FIRST_PORT = 48733;
export const LAST_PORT = 48832;
const MAX_NAME = 60;
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface SessionRecord {
	id: string;
	name: string;
	port: number;
	pid: number;
	/** ISO 8601. */
	startedAt: string;
}

/**
 * The one rule for a session's name, shared by the record and the host:
 * control characters removed, trimmed, at most 60 characters, and "session"
 * when nothing is left. Applying it twice changes nothing.
 */
export function normalizeSessionName(raw: string): string {
	let name = raw.replace(/\p{Cc}/gu, "").trim().slice(0, MAX_NAME);
	// Never end on half of a surrogate pair.
	if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
	return name.trimEnd() || "session";
}

/** 16 random bytes, base64url. */
export function newSessionId(): string {
	return randomBytes(16).toString("base64url");
}

/**
 * Tries `tryPort` on each port from `start` to `end` in order and returns the
 * first one it listens on. A busy port (EADDRINUSE) moves on; any other error stops the scan.
 */
export async function listenOnFreePort(tryPort: (port: number) => Promise<unknown>, start = FIRST_PORT, end = LAST_PORT): Promise<number> {
	for (let port = start; port <= end; port++) {
		try {
			await tryPort(port);
			return port;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error(`No free port between ${start} and ${end} (too many Gentle Shell sessions?).`);
}

function sessionsDir(configDir: string): string {
	return join(configDir, "sessions");
}

/** Writes <configDir>/sessions/<id>.json (0600, in a 0700 folder) atomically; returns its path. */
export function writeSessionRecord(configDir: string, session: { id: string; name: string; port: number; pid: number }): string {
	const dir = sessionsDir(configDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const record: SessionRecord = { id: session.id, name: session.name, port: session.port, pid: session.pid, startedAt: new Date().toISOString() };
	const file = join(dir, `${session.id}.json`);
	const temp = join(dir, `.${session.id}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return file;
}

/** Removes a session's record; nothing happens when it is already gone. */
export function removeSessionRecord(configDir: string, id: string): void {
	rmSync(join(sessionsDir(configDir), `${id}.json`), { force: true });
}

function isRecord(value: unknown, file: string): value is SessionRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { id, name, port, pid, startedAt } = value as Record<string, unknown>;
	return (
		typeof id === "string" &&
		SESSION_ID.test(id) &&
		file === `${id}.json` &&
		typeof name === "string" &&
		name === normalizeSessionName(name) &&
		Number.isInteger(port) &&
		(port as number) >= FIRST_PORT &&
		(port as number) <= LAST_PORT &&
		Number.isInteger(pid) &&
		(pid as number) > 0 &&
		typeof startedAt === "string" &&
		!Number.isNaN(Date.parse(startedAt))
	);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * The live sessions, oldest first. Records whose process is gone are deleted;
 * records that are not valid are skipped and left alone.
 */
export function listSessions(configDir: string): SessionRecord[] {
	const dir = sessionsDir(configDir);
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const sessions: SessionRecord[] = [];
	for (const file of files) {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(value, file)) continue;
		if (!alive(value.pid)) {
			try {
				unlinkSync(join(dir, file));
			} catch {}
			continue;
		}
		const { id, name, port, pid, startedAt } = value;
		sessions.push({ id, name, port, pid, startedAt });
	}
	return sessions.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
