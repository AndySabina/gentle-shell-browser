import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDiscovery } from "../extension/lib/sessions.js";
import { encodeMessage, extensionIdFromKey, handleRequest, MessageReader, nativeHostFiles } from "../src/host.ts";
import { newSessionId, writeSessionRecord } from "../src/sessions.ts";
import { loadOrCreateToken } from "../src/token.ts";

const scratches: string[] = [];
after(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-chrome-host-"));
	scratches.push(dir);
	return dir;
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((resolve) => child.once("exit", resolve));
	return child.pid as number;
}

test("extensionIdFromKey maps the first 32 hex digits of sha256(DER) to a-p", () => {
	const key = Buffer.from("gentle shell test key bytes").toString("base64");
	const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
	const expected = [...hex].map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");
	assert.equal(extensionIdFromKey(key), expected);
	assert.match(expected, /^[a-p]{32}$/);
});

test("encodeMessage writes a 4-byte little-endian length and UTF-8 JSON", () => {
	const message = { type: "discover", name: "ñ" };
	const json = Buffer.from(JSON.stringify(message), "utf8");
	const frame = encodeMessage(message);
	assert.equal(frame.readUInt32LE(0), json.length);
	assert.deepEqual(frame.subarray(4), json);
});

test("MessageReader decodes a message split across 3 chunks and two messages in one chunk", () => {
	const reader = new MessageReader();
	const frame = encodeMessage({ type: "discover", padding: "x".repeat(20) });
	assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
	assert.deepEqual(reader.push(frame.subarray(2, 10)), []);
	assert.deepEqual(reader.push(frame.subarray(10)), [{ type: "discover", padding: "x".repeat(20) }]);
	assert.deepEqual(reader.push(Buffer.concat([encodeMessage({ a: 1 }), encodeMessage([2, "b"])])), [{ a: 1 }, [2, "b"]]);
});

test("MessageReader rejects a declared length over 1 MiB", () => {
	const reader = new MessageReader();
	const header = Buffer.alloc(4);
	header.writeUInt32LE(1024 * 1024 + 1);
	assert.throws(() => reader.push(header), { message: "Message too large" });
	const exact = Buffer.alloc(4);
	exact.writeUInt32LE(1024 * 1024);
	assert.deepEqual(new MessageReader().push(exact), []);
});

test("discover returns the token and only the live sessions as id/name/port", async () => {
	const dir = scratch();
	const live = newSessionId();
	writeSessionRecord(dir, { id: live, name: "chrome", port: 48733, pid: process.pid });
	writeSessionRecord(dir, { id: newSessionId(), name: "gone", port: 48734, pid: await deadPid() });
	assert.deepEqual(handleRequest({ type: "discover" }, dir), { token: loadOrCreateToken(dir), sessions: [{ id: live, name: "chrome", port: 48733 }] });
});

test("a host reply with empty and padded names next to a valid one is accepted by the extension and includes the valid one", () => {
	const dir = scratch();
	const ok = newSessionId();
	writeSessionRecord(dir, { id: newSessionId(), name: "", port: 48733, pid: process.pid });
	writeSessionRecord(dir, { id: newSessionId(), name: ` ${"x".repeat(60)} `, port: 48734, pid: process.pid });
	writeSessionRecord(dir, { id: ok, name: "ok", port: 48735, pid: process.pid });
	const discovery = parseDiscovery(handleRequest({ type: "discover" }, dir));
	assert.deepEqual(discovery.sessions, [{ id: ok, name: "ok", port: 48735 }]);
});

test("any other request is unknown", () => {
	const dir = scratch();
	assert.deepEqual(handleRequest({ type: "token" }, dir), { error: "unknown request" });
	assert.deepEqual(handleRequest("discover", dir), { error: "unknown request" });
	assert.deepEqual(handleRequest(null, dir), { error: "unknown request" });
});

test("nativeHostFiles builds the Chrome host manifest and a CRLF batch file with an unquoted distro", () => {
	const options = {
		nodePath: "/usr/bin/node",
		hostScript: "/home/me/chrome/src/host.ts",
		extensionId: "abcdefghijklmnopabcdefghijklmnop",
		hostDirWindows: "C:\\Users\\me\\gentle-shell-chrome-host",
	};
	assert.deepEqual(nativeHostFiles({ ...options, distro: "Ubuntu" }), {
		manifest: {
			name: "dev.gentle.shell",
			description: "Gentle Shell browser bridge",
			path: "C:\\Users\\me\\gentle-shell-chrome-host\\gentle-shell-host.bat",
			type: "stdio",
			allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
		},
		bat: '@echo off\r\nwsl.exe -d Ubuntu -e "/usr/bin/node" "/home/me/chrome/src/host.ts"\r\n',
	});
	assert.equal(nativeHostFiles({ ...options, distro: "" }).bat, '@echo off\r\nwsl.exe -e "/usr/bin/node" "/home/me/chrome/src/host.ts"\r\n');
	// wsl.exe keeps quotes in the -d value, so the name goes unquoted and must be a plain distro name.
	assert.throws(() => nativeHostFiles({ ...options, distro: 'Ubuntu" & calc' }), { message: 'Invalid WSL distribution name: Ubuntu" & calc' });
	// The paths go into a batch file: quotes, variables, line breaks and cmd operators would change what it runs.
	for (const unsafe of ['/usr/bin/no"de', "/usr/%PATH%/node", "/usr/bin/node\r\ncalc", "/usr/bin/node\ncalc", "/a^b", "/a&calc", "/a|calc", "/a<b", "/a>b"]) {
		assert.throws(() => nativeHostFiles({ ...options, distro: "Ubuntu", nodePath: unsafe }), { message: `Unsafe path for the native host: ${unsafe}` }, unsafe);
		assert.throws(() => nativeHostFiles({ ...options, distro: "Ubuntu", hostScript: unsafe }), { message: `Unsafe path for the native host: ${unsafe}` }, unsafe);
	}
});

/** Runs `node src/host.ts`, writes `input` to its stdin and collects its output. */
function runHost(dir: string, input: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
	const script = new URL("../src/host.ts", import.meta.url).pathname;
	const child = spawn(process.execPath, [script], { env: { ...process.env, GENTLE_CHROME_CONFIG_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
	child.stdin.end(input);
	return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr })));
}

test("the host CLI answers one framed discover on stdout and nothing else", async () => {
	const dir = scratch();
	const id = newSessionId();
	writeSessionRecord(dir, { id, name: "chrome", port: 48740, pid: process.pid });
	const { code, stdout, stderr } = await runHost(dir, encodeMessage({ type: "discover" }));
	assert.equal(stderr, "");
	assert.equal(code, 0);
	assert.deepEqual(stdout, encodeMessage({ token: loadOrCreateToken(dir), sessions: [{ id, name: "chrome", port: 48740 }] }));
});

test("the host CLI answers a malformed request with bad request", async () => {
	const dir = scratch();
	const body = Buffer.from("{not json", "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length);
	const { code, stdout } = await runHost(dir, Buffer.concat([header, body]));
	assert.equal(code, 0);
	assert.deepEqual(stdout, encodeMessage({ error: "bad request" }));
});
