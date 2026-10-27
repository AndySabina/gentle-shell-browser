import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { USAGE } from "../src/index.ts";

const root = new URL("../", import.meta.url).pathname;
const guidePath = join(root, "docs/GUIDE.md");
const readmePath = join(root, "README.md");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Every text file under docs/, plus the README and the capture script. */
function publicTextFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (!name.endsWith(".png")) files.push(path);
		}
	};
	walk(join(root, "docs"));
	files.push(readmePath, join(root, "scripts/capture-screenshots.sh"));
	return files.filter((path) => existsSync(path));
}

test("docs/GUIDE.md exists and the README links to it", () => {
	assert.ok(existsSync(guidePath), "docs/GUIDE.md");
	assert.match(read(readmePath), /\]\(docs\/GUIDE\.md(#[^)]*)?\)/);
});

test("every image in docs/GUIDE.md and README.md is an existing PNG", () => {
	let count = 0;
	for (const path of [guidePath, readmePath]) {
		const text = read(path);
		const markdown = [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map(([, alt, src]) => [alt, src]);
		const html = [...text.matchAll(/<img\b[^>]*>/g)].map(([tag]) => [/\balt="([^"]*)"/.exec(tag)?.[1] ?? "", /\bsrc="([^"]*)"/.exec(tag)?.[1] ?? ""]);
		for (const [alt, src] of [...markdown, ...html]) {
			count++;
			assert.ok(alt.trim(), `${src} has alt text`);
			assert.match(src, /\.png$/, src);
			const file = join(dirname(path), src);
			assert.ok(existsSync(file), `${relative(root, path)}: ${src} exists`);
			assert.deepEqual(readFileSync(file).subarray(0, 8), PNG_SIGNATURE, `${src} is a PNG`);
		}
	}
	assert.ok(count >= 6, "the guide shows the popup and overlay pictures");
});

test("every /browser subcommand the guide names is in the command's usage", () => {
	const known = new Set(USAGE.match(/[a-z]+/g));
	const named = [...read(guidePath).matchAll(/\/browser ([a-z]+)/g)].map((match) => match[1]);
	assert.ok(named.length > 0, "the guide names /browser subcommands");
	for (const name of named) assert.ok(known.has(name), `/browser ${name} is in ${USAGE}`);
});

test("docs, README and the capture script carry no personal data", () => {
	// The project's public repository URL is the only allowed mention of the owner's account.
	const allowed = /github\.com\/[A-Za-z0-9-]+\/gentle-shell-browser/g;
	// Generic leaks: real home folders and real email addresses. Placeholders (you, me, <user>) and
	// example/noreply addresses are fine. Extra private words can be listed, one per line, in the
	// git-ignored file test/.private-terms, so the test itself never names them.
	const forbidden = [
		/\/home\/(?!you\/|me\/|u\/)[a-z][a-z0-9_-]*\//i,
		/C:\\{1,2}Users\\{1,2}(?!(?:you|me|<user>)\\)[a-z][a-z0-9_-]*\\/i,
		/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|users\.noreply\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
		...privateTerms().map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")),
	];
	const files = publicTextFiles();
	assert.ok(files.includes(guidePath));
	for (const file of files) {
		const text = readFileSync(file, "utf8").replace(allowed, "");
		for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${relative(root, file)} matches a forbidden pattern`);
	}
});

function privateTerms(): string[] {
	const file = join(root, "test", ".private-terms");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}
