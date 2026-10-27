import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listenOnFreePort, listSessions, newSessionId, normalizeSessionName, removeSessionRecord, writeSessionRecord } from "../src/sessions.ts";

const scratches: string[] = [];
after(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-chrome-sessions-"));
	scratches.push(dir);
	return dir;
}

/** Listens with a plain TCP server, the way the bridge would. */
function listen(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

const closeServer = (server: Server) => new Promise<void>((done) => server.close(() => done()));

/** A free port P such that P + 1 is also free, found by the OS. */
async function twoFreePorts(): Promise<number> {
	for (;;) {
		const probe = await listen(0);
		const port = (probe.address() as { port: number }).port;
		await closeServer(probe);
		if (port >= 65535) continue;
		try {
			await closeServer(await listen(port + 1));
			return port;
		} catch {}
	}
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((resolve) => child.once("exit", resolve));
	return child.pid as number;
}

test("session ids are 16 random bytes in base64url", () => {
	const id = newSessionId();
	assert.match(id, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(Buffer.from(id, "base64url").length, 16);
	assert.notEqual(newSessionId(), id);
});

test("the scan skips a busy port and listens on the next one", async () => {
	const start = await twoFreePorts();
	const occupied = await listen(start);
	const servers: Server[] = [];
	const tried: number[] = [];
	try {
		const port = await listenOnFreePort(
			async (candidate) => {
				tried.push(candidate);
				servers.push(await listen(candidate));
			},
			start,
			start + 1,
		);
		assert.equal(port, start + 1);
		assert.deepEqual(tried, [start, start + 1]);
	} finally {
		await closeServer(occupied);
		for (const server of servers) await closeServer(server);
	}
});

test("the scan covers 48733..48832 by default", async () => {
	const tried: number[] = [];
	await assert.rejects(
		listenOnFreePort(async (candidate) => {
			tried.push(candidate);
			throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
		}),
		{ message: "No free port between 48733 and 48832 (too many Gentle Shell sessions?)." },
	);
	assert.equal(tried.length, 100);
	assert.deepEqual([tried[0], tried.at(-1)], [48733, 48832]);
});

test("an error other than a busy port stops the scan", async () => {
	const tried: number[] = [];
	await assert.rejects(
		listenOnFreePort(async (candidate) => {
			tried.push(candidate);
			throw new Error("permission denied");
		}),
		{ message: "permission denied" },
	);
	assert.deepEqual(tried, [48733]);
});

test("a record is written atomically with private modes and removed idempotently", () => {
	const dir = join(scratch(), "config");
	const id = newSessionId();
	const before = Date.now();
	const file = writeSessionRecord(dir, { id, name: "chrome", port: 48733, pid: process.pid });
	const sessions = join(dir, "sessions");
	assert.equal(file, join(sessions, `${id}.json`));
	const stored = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(Object.keys(stored), ["id", "name", "port", "pid", "startedAt"]);
	assert.deepEqual({ ...stored, startedAt: undefined }, { id, name: "chrome", port: 48733, pid: process.pid, startedAt: undefined });
	assert.equal(new Date(stored.startedAt).toISOString(), stored.startedAt);
	assert.ok(Date.parse(stored.startedAt) >= before - 1000 && Date.parse(stored.startedAt) <= Date.now());
	assert.equal(statSync(sessions).mode & 0o777, 0o700);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	// No temporary file is left behind.
	assert.deepEqual(readdirSync(sessions), [`${id}.json`]);
	assert.deepEqual(listSessions(dir), [stored]);
	removeSessionRecord(dir, id);
	assert.equal(existsSync(file), false);
	removeSessionRecord(dir, id);
	removeSessionRecord(join(scratch(), "never"), id);
	assert.deepEqual(listSessions(dir), []);
});

test("listSessions skips invalid records, keeps EPERM-alive ones, deletes dead ones and sorts by startedAt", async () => {
	const dir = scratch();
	const sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	const entry = (overrides: Record<string, unknown> = {}) => {
		const value = { id: newSessionId(), name: "chrome", port: 48733, pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", ...overrides };
		return value as typeof value & Record<string, unknown>;
	};
	const put = (value: Record<string, unknown>, file = `${value.id}.json`) => {
		writeFileSync(join(sessions, file), JSON.stringify(value));
		return file;
	};
	const later = entry({ name: "later", startedAt: "2026-03-01T00:00:00.000Z" });
	const earlier = entry({ name: "earlier", startedAt: "2026-02-01T00:00:00.000Z" });
	// pid 1 (init) belongs to root: process.kill throws EPERM, which still means alive.
	const permitted = entry({ name: "init-owned", pid: 1, startedAt: "2026-02-15T00:00:00.000Z" });
	put(later);
	put(earlier);
	put(permitted);
	const dead = put(entry({ name: "dead", pid: await deadPid() }));
	const invalid = [
		put({ broken: true }, "garbage.json"),
		put(entry({ id: "short" }), "short.json"),
		put(entry({ name: 7 })),
		put(entry({ name: "x".repeat(61) })),
		put(entry({ port: "48733" })),
		put(entry({ port: 48732 })),
		put(entry({ port: 48833 })),
		put(entry({ port: 48733.5 })),
		put(entry({ pid: 0 })),
		put(entry({ pid: -5 })),
		put(entry({ pid: 1.5 })),
	];
	writeFileSync(join(sessions, "not-json.json"), "{nope");
	invalid.push("not-json.json");
	assert.deepEqual(listSessions(dir), [earlier, permitted, later]);
	assert.equal(existsSync(join(sessions, dead)), false);
	for (const name of invalid) assert.equal(existsSync(join(sessions, name)), true, name);
});

test("normalizeSessionName trims, drops control characters, keeps at most 60 and falls back to session", () => {
	assert.equal(normalizeSessionName("  alpha  "), "alpha");
	assert.equal(normalizeSessionName("a\u0000b\nc\td\u007f"), "abcd");
	assert.equal(normalizeSessionName(` ${"x".repeat(70)}`), "x".repeat(60));
	assert.equal(normalizeSessionName(`${"x".repeat(59)} y`), "x".repeat(59));
	assert.equal(normalizeSessionName(""), "session");
	assert.equal(normalizeSessionName(" \n\u0007 "), "session");
	for (const raw of ["  alpha  ", "a\nb", ` ${"x".repeat(70)}`, "", `${"x".repeat(59)} y`]) {
		const once = normalizeSessionName(raw);
		assert.equal(normalizeSessionName(once), once, raw);
	}
});

test("listSessions returns a 60-character name and skips names that are not normalized, without deleting them", () => {
	const dir = scratch();
	const ok = newSessionId();
	writeSessionRecord(dir, { id: ok, name: "x".repeat(60), port: 48832, pid: process.pid });
	const skipped = ["", ` ${"x".repeat(60)} `, " padded", "a\nb", "x".repeat(61)].map((name) => {
		const id = newSessionId();
		writeSessionRecord(dir, { id, name, port: 48733, pid: process.pid });
		return id;
	});
	assert.deepEqual(listSessions(dir).map((session) => session.id), [ok]);
	for (const id of skipped) assert.equal(existsSync(join(dir, "sessions", `${id}.json`)), true, id);
});

test("listSessions with no sessions folder is empty and creates nothing", () => {
	const dir = scratch();
	assert.deepEqual(listSessions(dir), []);
	assert.deepEqual(readdirSync(dir), []);
});
