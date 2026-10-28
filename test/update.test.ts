import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXTENSION_ID } from "../src/host.ts";
import { buildId, installExtension, REPO_EXTENSION_DIR, recordedTarget } from "../src/update.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "gentle-chrome-update-"));
}

/** A small extension folder shaped like extension/. */
function source(): string {
	const dir = join(scratch(), "extension");
	mkdirSync(join(dir, "lib"), { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "Gentle Shell Browser", version: "0.1.0" }));
	writeFileSync(join(dir, "background.js"), "// worker\n");
	writeFileSync(join(dir, "lib", "rpc.js"), "export {};\n");
	return dir;
}

test("buildId is a 16-character hex hash, the same for the same files", () => {
	const dir = source();
	const id = buildId(dir);
	assert.match(id, /^[0-9a-f]{16}$/);
	assert.equal(buildId(dir), id);
});

test("buildId changes when a file changes or is renamed, and ignores build.json and build.js", () => {
	const dir = source();
	const id = buildId(dir);
	writeFileSync(join(dir, "build.json"), '{"build":"x"}');
	writeFileSync(join(dir, "build.js"), 'export const BUILD = "x";\n');
	assert.equal(buildId(dir), id);
	writeFileSync(join(dir, "lib", "rpc.js"), "export {}; \n");
	const changed = buildId(dir);
	assert.notEqual(changed, id);
	renameSync(join(dir, "lib", "rpc.js"), join(dir, "lib", "peer.js"));
	assert.notEqual(buildId(dir), changed);
});

test("installExtension copies the files, writes build.json and records the target", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "config");
	const result = installExtension({ sourceDir, targetDir, configDir });
	assert.deepEqual(result, { build: buildId(sourceDir), targetDir, hostDir: `${targetDir}-host`, registered: false });
	assert.equal(readFileSync(join(targetDir, "lib", "rpc.js"), "utf8"), "export {};\n");
	assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// worker\n");
	assert.deepEqual(JSON.parse(readFileSync(join(targetDir, "build.json"), "utf8")), { build: result.build });
	// Part of the worker's code: a worker Chrome kept from an older copy reports that copy's build.
	assert.equal(readFileSync(join(targetDir, "build.js"), "utf8"), `// Written by install; the build this copy's code belongs to.\nexport const BUILD = "${result.build}";\n`);
	const record = join(configDir, "extension-target");
	assert.equal(readFileSync(record, "utf8"), `${targetDir}\n`);
	assert.equal(statSync(record).mode & 0o777, 0o600);
	assert.equal(recordedTarget(configDir), targetDir);
});

test("installExtension updates a previous copy without deleting its other files", () => {
	const sourceDir = source();
	const configDir = scratch();
	const { targetDir } = installExtension({ sourceDir, targetDir: join(scratch(), "copy"), configDir });
	writeFileSync(join(targetDir, "old.js"), "kept");
	writeFileSync(join(sourceDir, "background.js"), "// new worker\n");
	const { build } = installExtension({ sourceDir, targetDir, configDir });
	assert.equal(build, buildId(sourceDir));
	assert.equal(readFileSync(join(targetDir, "background.js"), "utf8"), "// new worker\n");
	assert.equal(readFileSync(join(targetDir, "old.js"), "utf8"), "kept");
	assert.deepEqual(JSON.parse(readFileSync(join(targetDir, "build.json"), "utf8")), { build });
	assert.equal(readFileSync(join(targetDir, "build.js"), "utf8"), `// Written by install; the build this copy's code belongs to.\nexport const BUILD = "${build}";\n`);
});

test("installExtension refuses a non-empty folder that is not a previous copy and leaves it untouched", () => {
	const sourceDir = source();
	const targetDir = scratch();
	const configDir = scratch();
	writeFileSync(join(targetDir, "notes.txt"), "mine");
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir }), {
		message: `${targetDir} is not empty and is not a previous copy of Gentle Shell Browser. Choose an empty or new folder.`,
	});
	assert.deepEqual(readdirSync(targetDir), ["notes.txt"]);
	assert.equal(recordedTarget(configDir), undefined);
});

test("installExtension refuses the source folder, a file and the drive roots", () => {
	const sourceDir = source();
	const configDir = scratch();
	assert.throws(() => installExtension({ sourceDir, targetDir: sourceDir, configDir }), { message: "the target is the source extension/ folder itself." });
	assert.equal(readdirSync(sourceDir).includes("build.json"), false);
	const file = join(scratch(), "file");
	writeFileSync(file, "x");
	assert.throws(() => installExtension({ sourceDir, targetDir: file, configDir }), { message: `${file} exists and is not a folder.` });
	for (const root of ["/", "/mnt", "/mnt/", "/mnt/c", "/mnt/c/"]) {
		assert.throws(() => installExtension({ sourceDir, targetDir: root, configDir }), { message: `refusing to copy into ${root.length > 1 ? root.replace(/\/$/, "") : root}: choose a dedicated folder.` }, root);
	}
	assert.equal(recordedTarget(configDir), undefined);
});

/** Install deps that record registry writes instead of touching Windows. */
function hostDeps(current: () => string | undefined) {
	const registered: string[] = [];
	const deps = {
		nodePath: "/usr/bin/node",
		hostScript: "/home/me/chrome/src/host.ts",
		distro: "Ubuntu",
		windowsPath: (path: string) => `C:\\win${path.replaceAll("/", "\\")}`,
		queryRegistry: current,
		register: (path: string) => {
			registered.push(path);
		},
	};
	return { deps, registered };
}

test("installExtension writes the native host files next to the target and registers the manifest", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const { deps, registered } = hostDeps(() => undefined);
	const result = installExtension({ sourceDir, targetDir, configDir: scratch(), deps });
	const hostDir = `${targetDir}-host`;
	const hostDirWindows = `C:\\win${hostDir.replaceAll("/", "\\")}`;
	assert.deepEqual(result, { build: buildId(sourceDir), targetDir, hostDir, registered: true });
	assert.deepEqual(readdirSync(hostDir).sort(), ["dev.gentle.shell.json", "gentle-shell-host.bat"]);
	const manifest = {
		name: "dev.gentle.shell",
		description: "Gentle Shell browser bridge",
		path: `${hostDirWindows}\\gentle-shell-host.bat`,
		type: "stdio",
		allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
	};
	assert.equal(readFileSync(join(hostDir, "dev.gentle.shell.json"), "utf8"), `${JSON.stringify(manifest, null, 2)}\n`);
	assert.equal(readFileSync(join(hostDir, "gentle-shell-host.bat"), "utf8"), '@echo off\r\n%SystemRoot%\\System32\\wsl.exe -d Ubuntu -e "/usr/bin/node" "/home/me/chrome/src/host.ts"\r\n');
	assert.deepEqual(registered, [`${hostDirWindows}\\dev.gentle.shell.json`]);
});

test("installExtension does not register again when the registry already points at the manifest", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	const first = hostDeps(() => undefined);
	installExtension({ sourceDir, targetDir, configDir, deps: first.deps });
	const second = hostDeps(() => first.registered[0]);
	const result = installExtension({ sourceDir, targetDir, configDir, deps: second.deps });
	assert.equal(result.registered, false);
	assert.deepEqual(second.registered, []);
});

test("installExtension refuses a non-empty host folder that is not a previous host folder and leaves everything untouched", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	const hostDir = `${targetDir}-host`;
	mkdirSync(hostDir);
	writeFileSync(join(hostDir, "dev.gentle.shell.json"), JSON.stringify({ name: "someone.else" }));
	const { deps, registered } = hostDeps(() => undefined);
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir, deps }), {
		message: `${hostDir} is not empty and is not a previous Gentle Shell native host folder. Move it away or choose another extension folder.`,
	});
	assert.deepEqual(readdirSync(hostDir), ["dev.gentle.shell.json"]);
	assert.equal(readFileSync(join(hostDir, "dev.gentle.shell.json"), "utf8"), JSON.stringify({ name: "someone.else" }));
	assert.equal(existsSync(targetDir), false);
	assert.equal(recordedTarget(configDir), undefined);
	assert.deepEqual(registered, []);
});

test("the worker reports the build its own code was installed with, not the build.json on disk", () => {
	const worker = readFileSync(join(REPO_EXTENSION_DIR, "background.js"), "utf8");
	assert.match(worker, /^import \{ BUILD \} from "\.\/build\.js";$/m);
	assert.equal(worker.includes("build.json"), false);
	assert.equal(readFileSync(join(REPO_EXTENSION_DIR, "build.js"), "utf8"), '// Written by install; the build this copy\'s code belongs to.\nexport const BUILD = "unknown";\n');
});
