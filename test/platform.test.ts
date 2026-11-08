import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTarget, detectPlatform, nativeHostDirs } from "../src/platform.ts";

const noFile = () => {
	throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

test("detectPlatform tells WSL from plain Linux, and keeps macOS and Windows", () => {
	assert.equal(detectPlatform({ os: "linux", exists: (path) => path === "/proc/sys/fs/binfmt_misc/WSLInterop", readFile: noFile, env: {} }), "wsl");
	assert.equal(detectPlatform({ os: "linux", exists: () => false, readFile: () => "Linux version 6.6.87.2-microsoft-standard-WSL2", env: {} }), "wsl");
	assert.equal(detectPlatform({ os: "linux", exists: () => false, readFile: () => "Linux version 6.8.0-45-generic", env: {} }), "linux");
	assert.equal(detectPlatform({ os: "linux", exists: () => false, readFile: noFile, env: {} }), "linux");
	assert.equal(detectPlatform({ os: "darwin", exists: () => false, readFile: noFile, env: {} }), "darwin");
	assert.equal(detectPlatform({ os: "win32", exists: () => false, readFile: noFile, env: {} }), "win32");
});

test("GENTLE_CHROME_PLATFORM overrides detection, for a Linux Chrome inside WSL", () => {
	const wsl = { os: "linux" as const, exists: () => true, readFile: noFile };
	assert.equal(detectPlatform({ ...wsl, env: { GENTLE_CHROME_PLATFORM: "linux" } }), "linux");
	assert.equal(detectPlatform({ ...wsl, env: { GENTLE_CHROME_PLATFORM: "" } }), "wsl");
	assert.throws(() => detectPlatform({ ...wsl, env: { GENTLE_CHROME_PLATFORM: "beos" } }), {
		message: "GENTLE_CHROME_PLATFORM must be one of wsl, linux, darwin, win32 (got beos).",
	});
});

test("defaultTarget is a per-user folder on each native platform, and none on WSL", () => {
	assert.equal(defaultTarget("linux", "/home/you", {}), "/home/you/.local/share/gentle-shell-chrome");
	assert.equal(defaultTarget("darwin", "/Users/you", {}), "/Users/you/Library/Application Support/gentle-shell-chrome");
	assert.equal(defaultTarget("win32", "C:\\Users\\you", { USERPROFILE: "C:\\Users\\you" }), "C:\\Users\\you\\gentle-shell-chrome");
	assert.equal(defaultTarget("wsl", "/home/you", {}), undefined);
});

test("nativeHostDirs names Chrome's folder, Chromium's only when Chromium is there, and the override alone when set", () => {
	assert.deepEqual(nativeHostDirs("linux", "/home/you", {}, () => false), ["/home/you/.config/google-chrome/NativeMessagingHosts"]);
	assert.deepEqual(nativeHostDirs("linux", "/home/you", {}, (path) => path === "/home/you/.config/chromium"), [
		"/home/you/.config/google-chrome/NativeMessagingHosts",
		"/home/you/.config/chromium/NativeMessagingHosts",
	]);
	assert.deepEqual(nativeHostDirs("darwin", "/Users/you", {}, (path) => path === "/Users/you/Library/Application Support/Chromium"), [
		"/Users/you/Library/Application Support/Google/Chrome/NativeMessagingHosts",
		"/Users/you/Library/Application Support/Chromium/NativeMessagingHosts",
	]);
	assert.deepEqual(nativeHostDirs("linux", "/home/you", { GENTLE_CHROME_NATIVE_HOSTS_DIR: "/home/you/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" }, () => true), [
		"/home/you/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
	]);
	// WSL and Windows register in the Windows registry instead.
	assert.deepEqual(nativeHostDirs("wsl", "/home/you", {}, () => true), []);
	assert.deepEqual(nativeHostDirs("win32", "C:\\Users\\you", {}, () => true), []);
});
