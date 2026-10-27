import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const extensionDir = new URL("../extension/", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(extensionDir, path), "utf8");
const css = read("popup.css");

test("every url() in popup.css points to a bundled woff2 font", () => {
	const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
	assert.ok(urls.length >= 2, "popup.css declares the bundled fonts");
	for (const url of urls) {
		const file = join(extensionDir, url);
		assert.ok(existsSync(file), url);
		assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2", url);
	}
});

test("the bundled font ships with its SIL Open Font License", () => {
	const license = join(extensionDir, "fonts/OFL.txt");
	assert.ok(existsSync(license));
	assert.match(readFileSync(license, "utf8"), /SIL OPEN FONT LICENSE/i);
});

test("popup.css uses the brand rose accent and the brand font family", () => {
	assert.match(css, /--rose:\s*#ff76c3\s*;/);
	assert.match(css, /font-family:\s*"Iosevka Gentle"\s*;/);
	assert.match(css, /"Iosevka Gentle",\s*"IosevkaTerm NF",\s*"Iosevka Term",\s*"JetBrains Mono",\s*ui-monospace,\s*monospace/);
	assert.match(css, /color-scheme:\s*dark\s*;/);
});

test("popup.html still has every element id popup.js looks up", () => {
	const html = read("popup.html");
	const ids = new Set([...read("popup.js").matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]));
	assert.ok(ids.size > 0);
	for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("the page overlay never uses innerHTML and the extension exposes no resources to pages", () => {
	assert.doesNotMatch(read("lib/overlay.js"), /innerHTML/);
	assert.doesNotMatch(read("manifest.json"), /web_accessible_resources/);
});

test("the page overlay uses the brand palette and the installed brand fonts only", () => {
	const overlay = read("lib/overlay.js");
	assert.match(overlay, /#ff76c3/);
	assert.match(overlay, /#1a1218/);
	assert.match(overlay, /"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace/);
	assert.doesNotMatch(overlay, /#7c3aed/);
	assert.doesNotMatch(overlay, /Iosevka Gentle|chrome-extension:|fonts\//);
});
