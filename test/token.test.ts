import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configDir, loadOrCreateToken, tokensEqual } from "../src/token.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "gentle-chrome-token-"));
}

test("creates a random token readable only by the owner", () => {
	const dir = join(scratch(), "gentle-chrome");
	const token = loadOrCreateToken(dir);
	assert.match(token, /^[A-Za-z0-9_-]{43}$/);
	const file = join(dir, "token");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(readFileSync(file, "utf8").trim(), token);
});

test("reuses the stored token", () => {
	const dir = scratch();
	assert.equal(loadOrCreateToken(dir), loadOrCreateToken(dir));
});

test("rejects a stored token that is too short and leaves it untouched", () => {
	const dir = scratch();
	writeFileSync(join(dir, "token"), "short\n", { mode: 0o600 });
	assert.throws(() => loadOrCreateToken(dir), /token file .* is invalid/);
	assert.equal(readFileSync(join(dir, "token"), "utf8"), "short\n");
});

test("tokensEqual compares exactly", () => {
	assert.equal(tokensEqual("abc", "abc"), true);
	assert.equal(tokensEqual("abc", "abd"), false);
	assert.equal(tokensEqual("abc", "abcd"), false);
	assert.equal(tokensEqual("", "abc"), false);
});

test("configDir honours GENTLE_CHROME_CONFIG_DIR, then XDG_CONFIG_HOME, then the home directory", () => {
	assert.equal(configDir({ GENTLE_CHROME_CONFIG_DIR: "/x/custom" }, "/home/u"), "/x/custom");
	assert.equal(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u"), "/x/cfg/gentle-chrome");
	assert.equal(configDir({}, "/home/u"), "/home/u/.config/gentle-chrome");
});
