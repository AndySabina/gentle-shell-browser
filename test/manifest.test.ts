import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXTENSION_ID, extensionIdFromKey } from "../src/host.ts";

const extensionDir = new URL("../extension/", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));

test("the extension and its toolbar button declare icons at every size Chrome uses", () => {
	const sizes = ["16", "32", "48", "128"];
	assert.deepEqual(Object.keys(manifest.icons ?? {}).sort(), [...sizes].sort());
	assert.deepEqual(Object.keys(manifest.action?.default_icon ?? {}).sort(), ["16", "32"]);
});

test("every icon the manifest names exists as a PNG", () => {
	const paths = [...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})] as string[];
	for (const path of paths) {
		const file = join(extensionDir, path);
		assert.ok(existsSync(file), path);
		assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], path);
	}
});

test("the extension may talk to the native host and has a fixed id from its key", () => {
	assert.ok(manifest.permissions.includes("nativeMessaging"));
	assert.equal(typeof manifest.key, "string");
	assert.equal(extensionIdFromKey(manifest.key), EXTENSION_ID);
});
