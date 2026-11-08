import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MAX_UPLOAD_FILES, prepareUpload, windowsPath } from "../src/upload.ts";

// Every file lives in a fresh temp folder: the real home is never touched.
const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-upload-")));
after(() => rmSync(root, { recursive: true, force: true }));

function file(relative: string, text = "x"): string {
	const path = join(root, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return path;
}

/** A converter that records the real paths it was given. */
function fakeConvert() {
	const calls: string[] = [];
	const convert = async (path: string) => {
		calls.push(path);
		return `W:${path.replaceAll("/", "\\")}`;
	};
	return { calls, convert };
}

const sensitive = (path: string, resolved?: string) =>
	`Upload refused: ${JSON.stringify(path)}${resolved ? ` (resolves to ${JSON.stringify(resolved)})` : ""} is a sensitive file (keys, passwords or credentials), which is never uploaded. Do not retry it or look for another way to upload it.`;

test("prepareUpload converts each real path and keeps the names and the paths the agent gave", async () => {
	const report = file("docs/report.docx");
	const photo = file("docs/photo.png");
	const link = join(root, "docs/latest.docx");
	symlinkSync(report, link);
	const { calls, convert } = fakeConvert();
	const prepared = await prepareUpload([report, link, photo], { convert });
	assert.deepEqual(calls, [report, report, photo]);
	assert.deepEqual(prepared, {
		files: [`W:${report.replaceAll("/", "\\")}`, `W:${report.replaceAll("/", "\\")}`, `W:${photo.replaceAll("/", "\\")}`],
		names: ["report.docx", "latest.docx", "photo.png"],
		paths: [report, link, photo],
	});
});

test("prepareUpload refuses a relative, missing, non-regular or unreadable file with the exact message and converts nothing", async () => {
	const good = file("ok.txt");
	const folder = join(root, "folder");
	mkdirSync(folder, { recursive: true });
	const locked = file("locked.txt");
	const cases: [string, string, object?][] = [
		["notes.txt", 'Upload refused: "notes.txt" is not an absolute path. Pass the file\'s full path.'],
		["./notes.txt", 'Upload refused: "./notes.txt" is not an absolute path. Pass the file\'s full path.'],
		[join(root, "missing.docx"), `Upload refused: ${JSON.stringify(join(root, "missing.docx"))} does not exist.`],
		[folder, `Upload refused: ${JSON.stringify(folder)} is not a regular file.`],
		[
			locked,
			`Upload refused: ${JSON.stringify(locked)} cannot be read.`,
			{
				access: async (path: string) => {
					if (path === locked) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
				},
			},
		],
	];
	for (const [path, message, deps] of cases) {
		const { calls, convert } = fakeConvert();
		await assert.rejects(prepareUpload([good, path], { convert, ...deps }), { message }, path);
		assert.deepEqual(calls, [], path);
	}
});

test("prepareUpload takes 1 to 10 paths", async () => {
	const { calls, convert } = fakeConvert();
	const one = file("one.txt");
	assert.equal(MAX_UPLOAD_FILES, 10);
	const message = "Upload refused: pass 1 to 10 local file paths.";
	await assert.rejects(prepareUpload([], { convert }), { message });
	await assert.rejects(prepareUpload(Array(11).fill(one), { convert }), { message });
	assert.deepEqual(calls, []);
	assert.equal((await prepareUpload(Array(10).fill(one), { convert })).files.length, 10);
});

test("prepareUpload always refuses sensitive files: folders, names and extensions, in any case", async () => {
	const paths = [
		".ssh/config",
		".gnupg/pubring.kbx",
		".aws/config",
		".azure/accessTokens.json",
		".kube/config",
		".docker/config.json",
		"secrets/plan.txt",
		".password-store/mail.txt",
		"keyrings/login.txt",
		"app/.env",
		"app/.env.local",
		"home/.netrc",
		"home/.npmrc",
		"home/.pypirc",
		"home/.git-credentials",
		"home/credentials",
		"home/credentials.json",
		"keys/id_rsa",
		"keys/id_rsa.pub",
		"keys/id_ed25519",
		"keys/id_ecdsa",
		"keys/id_dsa",
		"keys/known_hosts",
		"keys/authorized_keys",
		"certs/server.pem",
		"certs/server.key",
		"certs/client.p12",
		"certs/client.pfx",
		"certs/app.keystore",
		"certs/app.jks",
		"vault/passwords.kdbx",
		"keys/putty.ppk",
		"keys/backup.asc",
		"keys/backup.gpg",
		"certs/SERVER.PEM",
		".SSH/notes.txt",
		"app/.ENV",
	].map((relative) => file(relative));
	for (const path of paths) {
		const { calls, convert } = fakeConvert();
		await assert.rejects(prepareUpload([path], { convert }), { message: sensitive(path) }, path);
		assert.deepEqual(calls, [], path);
	}
	// A path that does not exist yet is refused as sensitive, before anything else.
	const ghost = join(root, "nowhere/.ssh/id_rsa");
	await assert.rejects(prepareUpload([ghost], fakeConvert()), { message: sensitive(ghost) });
});

test("prepareUpload refuses a harmless-looking symlink that resolves to a sensitive file", async () => {
	const key = file("vault/.ssh/key.txt");
	const link = join(root, "notes.txt");
	symlinkSync(key, link);
	const folderLink = join(root, "shared");
	symlinkSync(join(root, "vault/.ssh"), folderLink);
	const { calls, convert } = fakeConvert();
	await assert.rejects(prepareUpload([link], { convert }), { message: sensitive(link, key) });
	await assert.rejects(prepareUpload([join(folderLink, "key.txt")], { convert }), { message: sensitive(join(folderLink, "key.txt"), key) });
	assert.deepEqual(calls, []);
});

test("prepareUpload names files that only look sensitive as allowed", async () => {
	const paths = ["docs/environment.txt", "docs/keynote.pdf", "docs/my.env.notes", "docs/id.png", "docs/ssh-guide.md", "docs/credentials-howto.md"].map((relative) => file(relative));
	const { calls, convert } = fakeConvert();
	await prepareUpload(paths, { convert });
	assert.deepEqual(calls, paths);
});

test("windowsPath turns /mnt/<drive>/ paths into drive paths and asks wslpath -w for the rest", async () => {
	const runs: string[][] = [];
	const run = async (command: string, args: string[]) => {
		runs.push([command, ...args]);
		return "\\\\wsl.localhost\\Ubuntu\\srv\\a b.docx\n";
	};
	assert.equal(await windowsPath("/mnt/c/Users/you/Documents/a b.docx", run), "C:\\Users\\you\\Documents\\a b.docx");
	assert.equal(await windowsPath("/mnt/d/report.pdf", run), "D:\\report.pdf");
	assert.deepEqual(runs, []);
	assert.equal(await windowsPath("/srv/a b.docx", run), "\\\\wsl.localhost\\Ubuntu\\srv\\a b.docx");
	assert.deepEqual(runs, [["wslpath", "-w", "/srv/a b.docx"]]);
});

test("a path wslpath cannot convert is refused with the exact message", async () => {
	const path = file("odd.txt");
	const convert = (target: string) =>
		windowsPath(target, async () => {
			throw new Error("wslpath: not found");
		});
	await assert.rejects(prepareUpload([path], { convert }), { message: `Upload refused: ${JSON.stringify(path)} could not be converted to a path Chrome can read (wslpath: not found).` });
});
