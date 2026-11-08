import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXTENSION_ID } from "../src/host.ts";
import { buildId, hostBinding, installExtension, REPO_EXTENSION_DIR, recordedTarget } from "../src/update.ts";

// The tests without an injected platform describe the WSL install, whatever system runs them,
// so none of them writes into this account's Chrome folders.
process.env.GENTLE_CHROME_PLATFORM = "wsl";

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

test("installExtension also records the target in the durable folder, which a Gentle Shell update does not replace", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "config");
	const durableDir = join(scratch(), "durable");
	installExtension({ sourceDir, targetDir, configDir, durableDir });
	for (const dir of [configDir, durableDir]) {
		const record = join(dir, "extension-target");
		assert.equal(readFileSync(record, "utf8"), `${targetDir}\n`, dir);
		assert.equal(statSync(record).mode & 0o777, 0o600, dir);
		assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
	}
});

test("installExtension writes one record when the durable folder is the config folder", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "config");
	installExtension({ sourceDir, targetDir, configDir, durableDir: `${configDir}/` });
	assert.deepEqual(readdirSync(configDir), ["extension-target"]);
	assert.equal(readFileSync(join(configDir, "extension-target"), "utf8"), `${targetDir}\n`);
	assert.equal(recordedTarget(configDir, configDir), targetDir);
});

test("recordedTarget falls back to the durable record when a Gentle Shell update removed the config folder's, and prefers the config folder's", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "config");
	const durableDir = join(scratch(), "durable");
	installExtension({ sourceDir, targetDir, configDir, durableDir, deps: hostDeps(() => undefined, process.execPath).deps });
	// The update replaces the whole config folder.
	renameSync(configDir, `${configDir}-old`);
	assert.equal(recordedTarget(configDir, durableDir), targetDir);
	assert.deepEqual(hostBinding(configDir, durableDir), { state: "bound", hostDir: `${targetDir}-host` });
	assert.equal(recordedTarget(configDir), undefined);
	mkdirSync(configDir);
	writeFileSync(join(configDir, "extension-target"), "/mnt/c/Users/me/other\n");
	assert.equal(recordedTarget(configDir, durableDir), "/mnt/c/Users/me/other");
	assert.equal(recordedTarget(scratch(), scratch()), undefined);
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
function hostDeps(current: () => string | undefined, nodePath = "/usr/bin/node") {
	const registered: string[] = [];
	const deps = {
		nodePath,
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
	const configDir = scratch();
	const result = installExtension({ sourceDir, targetDir, configDir, deps });
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
	assert.equal(readFileSync(join(hostDir, "gentle-shell-host.bat"), "utf8"), `@echo off\r\n%SystemRoot%\\System32\\wsl.exe -d Ubuntu -e "/usr/bin/node" "/home/me/chrome/src/host.ts" --config-dir "${configDir}"\r\n`);
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

test("installExtension refuses a config folder the helper cannot be bound to and writes nothing", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "100%config");
	const { deps, registered } = hostDeps(() => undefined);
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir, deps }), { message: `Unsafe path for the native host: ${configDir}` });
	assert.equal(existsSync(targetDir), false);
	assert.equal(existsSync(`${targetDir}-host`), false);
	assert.equal(existsSync(configDir), false);
	assert.deepEqual(registered, []);
});

test("hostBinding reports absent when this config folder has no recorded install", () => {
	assert.deepEqual(hostBinding(scratch()), { state: "absent" });
	assert.deepEqual(hostBinding(join(scratch(), "missing")), { state: "absent" });
});

test("hostBinding reports bound when the recorded helper reads this config folder, also through a symlink", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	installExtension({ sourceDir, targetDir, configDir, deps: hostDeps(() => undefined, process.execPath).deps });
	assert.deepEqual(hostBinding(configDir), { state: "bound", hostDir: `${targetDir}-host` });
	const link = join(scratch(), "gentle-chrome");
	symlinkSync(configDir, link);
	assert.deepEqual(hostBinding(link), { state: "bound", hostDir: `${targetDir}-host` });
});

test("hostBinding reports mismatched when a later install bound the helper to another config folder", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const session = scratch();
	const outside = scratch();
	installExtension({ sourceDir, targetDir, configDir: session, deps: hostDeps(() => undefined, process.execPath).deps });
	installExtension({ sourceDir, targetDir, configDir: outside, deps: hostDeps(() => undefined, process.execPath).deps });
	assert.deepEqual(hostBinding(session), { state: "mismatched", hostDir: `${targetDir}-host`, boundTo: outside });
	assert.deepEqual(hostBinding(outside), { state: "bound", hostDir: `${targetDir}-host` });
});

test("hostBinding reports unbound for a helper written before config binding, and unknown when the helper is missing", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	installExtension({ sourceDir, targetDir, configDir, deps: hostDeps(() => undefined, process.execPath).deps });
	const bat = join(`${targetDir}-host`, "gentle-shell-host.bat");
	writeFileSync(bat, `@echo off\r\n%SystemRoot%\\System32\\wsl.exe -d Ubuntu -e "${process.execPath}" "/home/me/chrome/src/host.ts"\r\n`);
	assert.deepEqual(hostBinding(configDir), { state: "unbound", hostDir: `${targetDir}-host` });
	renameSync(`${targetDir}-host`, `${targetDir}-moved`);
	assert.deepEqual(hostBinding(configDir), { state: "unknown", hostDir: `${targetDir}-host`, reason: `${bat} is missing` });
});

test("hostBinding reports stale when the recorded helper's Node no longer exists, before checking its config folder", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	// A Node from a runtime folder a later Gentle Shell install replaced.
	const gone = join(scratch(), "runtime", "node-v22.18.0", "bin", "node");
	installExtension({ sourceDir, targetDir, configDir, deps: hostDeps(() => undefined, gone).deps });
	const hostDir = `${targetDir}-host`;
	assert.deepEqual(hostBinding(configDir), { state: "stale", hostDir, nodePath: gone });
	// A helper from before config binding with the same stale Node: the Node is what stops Chrome first.
	writeFileSync(join(hostDir, "gentle-shell-host.bat"), `@echo off\r\n%SystemRoot%\\System32\\wsl.exe -e "${gone}" "/home/me/chrome/src/host.ts"\r\n`);
	assert.deepEqual(hostBinding(configDir), { state: "stale", hostDir, nodePath: gone });
});

/** Runs `fn` with WSL_DISTRO_NAME set to `value`, or unset, and restores it. */
function withDistroEnv<T>(value: string | undefined, fn: () => T): T {
	const saved = process.env.WSL_DISTRO_NAME;
	if (value === undefined) delete process.env.WSL_DISTRO_NAME;
	else process.env.WSL_DISTRO_NAME = value;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = saved;
	}
}

/** hostDeps without a distro, whose wslpath -w / answers `root` (what a WSL distribution reports for its own root). */
function rootDeps(root: string) {
	const { deps, registered } = hostDeps(() => undefined);
	const { distro: _, ...rest } = deps;
	return { deps: { ...rest, windowsPath: (path: string) => (path === "/" ? root : deps.windowsPath(path)) }, registered };
}

function batOf(targetDir: string): string {
	return readFileSync(join(`${targetDir}-host`, "gentle-shell-host.bat"), "utf8");
}

test("installExtension without WSL_DISTRO_NAME starts the distribution wslpath names for /", () => {
	const sourceDir = source();
	for (const [root, name] of [
		["\\\\wsl.localhost\\Ubuntu-22.04\\", "Ubuntu-22.04"],
		["\\\\wsl$\\Debian", "Debian"],
	]) {
		const targetDir = join(scratch(), "gentle-shell-chrome");
		withDistroEnv(undefined, () => installExtension({ sourceDir, targetDir, configDir: scratch(), deps: rootDeps(root).deps }));
		assert.match(batOf(targetDir), new RegExp(`System32\\\\wsl\\.exe -d ${name} -e "`), root);
	}
});

test("installExtension keeps an explicit distro and WSL_DISTRO_NAME over what wslpath names", () => {
	const sourceDir = source();
	const fromEnv = join(scratch(), "gentle-shell-chrome");
	withDistroEnv("Ubuntu", () => installExtension({ sourceDir, targetDir: fromEnv, configDir: scratch(), deps: rootDeps("\\\\wsl.localhost\\Other\\").deps }));
	assert.match(batOf(fromEnv), /System32\\wsl\.exe -d Ubuntu -e "/);
	const explicit = join(scratch(), "gentle-shell-chrome");
	withDistroEnv("Ubuntu", () => installExtension({ sourceDir, targetDir: explicit, configDir: scratch(), deps: { ...rootDeps("\\\\wsl.localhost\\Other\\").deps, distro: "Arch" } }));
	assert.match(batOf(explicit), /System32\\wsl\.exe -d Arch -e "/);
});

test("installExtension outside a Windows drive keeps a helper without -d when the distribution cannot be told", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	withDistroEnv(undefined, () => installExtension({ sourceDir, targetDir, configDir: scratch(), deps: rootDeps("/").deps }));
	assert.match(batOf(targetDir), /System32\\wsl\.exe -e "/);
});

/** Every file and folder under `dir` with the bytes of each file, to prove a run changed nothing. */
function snapshot(dir: string): [string, string | null][] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.map((entry): [string, string | null] => {
			const path = join(entry.parentPath, entry.name);
			return [path, entry.isFile() ? readFileSync(path, "utf8") : null];
		})
		.sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Calls installExtension in a child Node under the permission model: it may
 * read anything but write only inside `writable`, and may not start processes,
 * so the registry and wslpath are injected. A build that does not refuse
 * fails on its first write outside `writable` instead of writing there.
 */
const CONFINED_INSTALL = String.raw`
const { installExtension } = await import(process.env.UPDATE_URL);
const registered = [];
const deps = {
	nodePath: "/usr/bin/node",
	hostScript: "/home/me/chrome/src/host.ts",
	windowsPath: (path) => (path === "/" ? "/" : "C:\\win" + path.replaceAll("/", "\\")),
	queryRegistry: () => undefined,
	register: (path) => registered.push(path),
};
try {
	installExtension({ sourceDir: process.env.SOURCE_DIR, targetDir: process.env.TARGET_DIR, configDir: process.env.CONFIG_DIR, deps });
	console.log(JSON.stringify({ installed: true, registered }));
} catch (error) {
	console.log(JSON.stringify({ message: error.message, registered }));
}
`;

test("installExtension refuses a Windows-drive install when the distribution cannot be told, and writes nothing", () => {
	const sourceDir = source();
	const configDir = scratch();
	// Only read (stat) by the child: the permission model forbids any write there.
	const targetDir = `/mnt/z/gentle-shell-test-${process.pid}-${Date.now()}`;
	const before = [snapshot(sourceDir), snapshot(configDir)];
	const result = spawnSync(process.execPath, ["--no-warnings", "--permission", "--allow-fs-read=*", `--allow-fs-write=${configDir}`, "--input-type=module", "-e", CONFINED_INSTALL], {
		// No WSL_DISTRO_NAME: the child's environment holds only what it is given.
		env: { UPDATE_URL: new URL("../src/update.ts", import.meta.url).href, SOURCE_DIR: sourceDir, TARGET_DIR: targetDir, CONFIG_DIR: configDir },
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	assert.equal(result.error, undefined, `child failed to run: ${result.error}`);
	assert.equal(result.signal, null, `child killed by ${result.signal}`);
	assert.equal(result.stderr, "");
	assert.equal(result.status, 0);
	assert.deepEqual(JSON.parse(result.stdout), {
		message: "could not tell which WSL distribution this is; set WSL_DISTRO_NAME to its name (wsl.exe -l -q lists them) and run again.",
		registered: [],
	});
	assert.deepEqual([snapshot(sourceDir), snapshot(configDir)], before);
	assert.equal(existsSync(targetDir), false);
	assert.equal(existsSync(`${targetDir}-host`), false);
});

test("the worker reports the build its own code was installed with, not the build.json on disk", () => {
	const worker = readFileSync(join(REPO_EXTENSION_DIR, "background.js"), "utf8");
	assert.match(worker, /^import \{ BUILD \} from "\.\/build\.js";$/m);
	assert.equal(worker.includes("build.json"), false);
	assert.equal(readFileSync(join(REPO_EXTENSION_DIR, "build.js"), "utf8"), '// Written by install; the build this copy\'s code belongs to.\nexport const BUILD = "unknown";\n');
});

/** The helper's manifest for the launcher at `path`, keys in the order install writes them. */
function manifestFor(path: string) {
	return { name: "dev.gentle.shell", description: "Gentle Shell browser bridge", path, type: "stdio", allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] };
}

/** Install deps for a native Linux or macOS Chrome, with `home` as the account's home. */
function nativeDeps(platform: "linux" | "darwin", home: string, env: Record<string, string | undefined> = {}, nodePath = "/usr/bin/node") {
	return { platform, home, env, nodePath, hostScript: "/home/me/it's/src/host.ts" };
}

test("installExtension on Linux writes a shell launcher and the manifest into Chrome's folder, and Chromium's when it is there", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	const home = scratch();
	mkdirSync(join(home, ".config", "chromium"), { recursive: true });
	const deps = nativeDeps("linux", home);
	const result = installExtension({ sourceDir, targetDir, configDir, deps });
	const hostDir = `${targetDir}-host`;
	assert.deepEqual(result, { build: buildId(sourceDir), targetDir, hostDir, registered: true });
	assert.deepEqual(readdirSync(hostDir).sort(), ["dev.gentle.shell.json", "gentle-shell-host.sh"]);
	const launcher = join(hostDir, "gentle-shell-host.sh");
	assert.equal(readFileSync(launcher, "utf8"), `#!/bin/sh\nexec '/usr/bin/node' '/home/me/it'\\''s/src/host.ts' --config-dir '${configDir}'\n`);
	assert.equal(statSync(launcher).mode & 0o777, 0o755);
	const manifest = `${JSON.stringify(manifestFor(launcher), null, 2)}\n`;
	assert.equal(readFileSync(join(hostDir, "dev.gentle.shell.json"), "utf8"), manifest);
	for (const dir of [".config/google-chrome/NativeMessagingHosts", ".config/chromium/NativeMessagingHosts"]) {
		assert.equal(readFileSync(join(home, dir, "dev.gentle.shell.json"), "utf8"), manifest, dir);
	}
	assert.equal(recordedTarget(configDir), targetDir);
	// The same manifests again: nothing to register.
	assert.equal(installExtension({ sourceDir, targetDir, configDir, deps }).registered, false);
});

test("installExtension on Linux writes the manifest only into GENTLE_CHROME_NATIVE_HOSTS_DIR when it is set", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const home = scratch();
	const brave = join(scratch(), "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
	const result = installExtension({ sourceDir, targetDir, configDir: scratch(), deps: nativeDeps("linux", home, { GENTLE_CHROME_NATIVE_HOSTS_DIR: brave }) });
	assert.equal(result.registered, true);
	assert.deepEqual(readdirSync(brave), ["dev.gentle.shell.json"]);
	assert.equal(JSON.parse(readFileSync(join(brave, "dev.gentle.shell.json"), "utf8")).path, join(`${targetDir}-host`, "gentle-shell-host.sh"));
	assert.deepEqual(readdirSync(home), []);
});

test("installExtension on macOS writes the manifest into Chrome's Application Support folder", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const home = scratch();
	installExtension({ sourceDir, targetDir, configDir: scratch(), deps: nativeDeps("darwin", home) });
	const manifest = join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "dev.gentle.shell.json");
	assert.equal(JSON.parse(readFileSync(manifest, "utf8")).path, join(`${targetDir}-host`, "gentle-shell-host.sh"));
	assert.equal(existsSync(join(home, "Library", "Application Support", "Chromium")), false);
});

test("installExtension on Linux refuses a path the launcher cannot hold and writes nothing", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "line\nbreak");
	const home = scratch();
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir, deps: nativeDeps("linux", home) }), { message: `Unsafe path for the native host: ${configDir}` });
	assert.equal(existsSync(targetDir), false);
	assert.equal(existsSync(`${targetDir}-host`), false);
	assert.equal(existsSync(configDir), false);
	assert.deepEqual(readdirSync(home), []);
});

test("installExtension on Linux refuses a foreign host folder and leaves everything untouched", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const home = scratch();
	const hostDir = `${targetDir}-host`;
	mkdirSync(hostDir);
	writeFileSync(join(hostDir, "notes.txt"), "mine");
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir: scratch(), deps: nativeDeps("linux", home) }), {
		message: `${hostDir} is not empty and is not a previous Gentle Shell native host folder. Move it away or choose another extension folder.`,
	});
	assert.deepEqual(readdirSync(hostDir), ["notes.txt"]);
	assert.equal(existsSync(targetDir), false);
	assert.deepEqual(readdirSync(home), []);
});

/** Install deps for native Windows Chrome, recording registry writes instead of touching the registry. */
function windowsDeps(current: () => string | undefined, nodePath = "C:\\Program Files\\nodejs\\node.exe") {
	const registered: string[] = [];
	const deps = {
		platform: "win32" as const,
		home: scratch(),
		env: {},
		nodePath,
		hostScript: "C:\\Users\\me\\gentle-shell-browser\\src\\host.ts",
		queryRegistry: current,
		register: (path: string) => {
			registered.push(path);
		},
	};
	return { deps, registered };
}

test("installExtension on Windows writes a .bat that runs node.exe and registers the manifest under HKCU", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	const { deps, registered } = windowsDeps(() => undefined);
	const result = installExtension({ sourceDir, targetDir, configDir, deps });
	const hostDir = `${targetDir}-host`;
	assert.deepEqual(result, { build: buildId(sourceDir), targetDir, hostDir, registered: true });
	assert.deepEqual(readdirSync(hostDir).sort(), ["dev.gentle.shell.json", "gentle-shell-host.bat"]);
	assert.equal(readFileSync(join(hostDir, "gentle-shell-host.bat"), "utf8"), `@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\gentle-shell-browser\\src\\host.ts" --config-dir "${configDir}"\r\n`);
	assert.equal(readFileSync(join(hostDir, "dev.gentle.shell.json"), "utf8"), `${JSON.stringify(manifestFor(`${hostDir}\\gentle-shell-host.bat`), null, 2)}\n`);
	assert.deepEqual(registered, [`${hostDir}\\dev.gentle.shell.json`]);
	const again = windowsDeps(() => registered[0]);
	assert.equal(installExtension({ sourceDir, targetDir, configDir, deps: again.deps }).registered, false);
	assert.deepEqual(again.registered, []);
});

test("installExtension on Windows refuses an unsafe path and registers nothing", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = join(scratch(), "100%config");
	const { deps, registered } = windowsDeps(() => undefined);
	assert.throws(() => installExtension({ sourceDir, targetDir, configDir, deps }), { message: `Unsafe path for the native host: ${configDir}` });
	assert.equal(existsSync(targetDir), false);
	assert.equal(existsSync(`${targetDir}-host`), false);
	assert.deepEqual(registered, []);
});

test("hostBinding reads a Linux or macOS shell launcher: bound, mismatched, unbound and stale", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const home = scratch();
	const session = join(scratch(), "it's config");
	const outside = scratch();
	const hostDir = `${targetDir}-host`;
	installExtension({ sourceDir, targetDir, configDir: session, deps: nativeDeps("linux", home, {}, process.execPath) });
	assert.deepEqual(hostBinding(session), { state: "bound", hostDir });
	installExtension({ sourceDir, targetDir, configDir: outside, deps: nativeDeps("linux", home, {}, process.execPath) });
	assert.deepEqual(hostBinding(session), { state: "mismatched", hostDir, boundTo: outside });
	writeFileSync(join(hostDir, "gentle-shell-host.sh"), `#!/bin/sh\nexec '${process.execPath}' '/x/src/host.ts'\n`);
	assert.deepEqual(hostBinding(outside), { state: "unbound", hostDir });
	const gone = join(scratch(), "runtime", "bin", "node");
	installExtension({ sourceDir, targetDir, configDir: session, deps: nativeDeps("darwin", home, {}, gone) });
	assert.deepEqual(hostBinding(session), { state: "stale", hostDir, nodePath: gone });
});

test("hostBinding reads a native Windows .bat: bound, and stale when its node.exe is gone", () => {
	const sourceDir = source();
	const targetDir = join(scratch(), "gentle-shell-chrome");
	const configDir = scratch();
	const hostDir = `${targetDir}-host`;
	installExtension({ sourceDir, targetDir, configDir, deps: windowsDeps(() => undefined, process.execPath).deps });
	assert.deepEqual(hostBinding(configDir), { state: "bound", hostDir });
	const gone = join(scratch(), "nodejs", "node.exe");
	installExtension({ sourceDir, targetDir, configDir, deps: windowsDeps(() => undefined, gone).deps });
	assert.deepEqual(hostBinding(configDir), { state: "stale", hostDir, nodePath: gone });
});

/** Runs `node src/update.ts <args>` with only scratch folders in its environment. */
function cli(args: string[], env: Record<string, string>) {
	const result = spawnSync(process.execPath, [new URL("../src/update.ts", import.meta.url).pathname, ...args], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	assert.equal(result.error, undefined, `update.ts failed to run: ${result.error}`);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("setup on Linux installs into the given folder and says where the helper is registered and how to load the extension", () => {
	const dir = scratch();
	const env = {
		GENTLE_CHROME_PLATFORM: "linux",
		GENTLE_CHROME_NATIVE_HOSTS_DIR: join(dir, "nmh"),
		GENTLE_CHROME_CONFIG_DIR: join(dir, "cfg"),
		GENTLE_CHROME_DURABLE_DIR: join(dir, "durable"),
	};
	const target = join(dir, "ext");
	const { code, stdout, stderr } = cli(["setup", target], env);
	assert.equal(stderr, "");
	assert.equal(code, 0);
	const version = JSON.parse(readFileSync(join(REPO_EXTENSION_DIR, "manifest.json"), "utf8")).version;
	assert.equal(
		stdout,
		[
			`Copied Gentle Shell Browser ${version} (build ${buildId(REPO_EXTENSION_DIR)}) to ${target}`,
			`Native host written to ${target}-host`,
			`Registered for Chrome: ${join(dir, "nmh", "dev.gentle.shell.json")}`,
			"",
			"First time: open chrome://extensions in Chrome, turn on Developer mode,",
			'press "Load unpacked" and choose:',
			`  ${target}`,
			"",
			"After that first load, Gentle Shell updates the extension by itself whenever it",
			"connects with an older build.",
			"",
		].join("\n"),
	);
	assert.equal(statSync(join(`${target}-host`, "gentle-shell-host.sh")).mode & 0o777, 0o755);
	assert.equal(readFileSync(join(dir, "cfg", "extension-target"), "utf8"), `${target}\n`);
	assert.equal(readFileSync(join(dir, "durable", "extension-target"), "utf8"), `${target}\n`);
	// Run again: the helper is already registered there.
	assert.match(cli(["setup", target], env).stdout, new RegExp(`^Already registered for Chrome: ${join(dir, "nmh", "dev.gentle.shell.json").replaceAll("/", "\\/")}$`, "m"));
});

test("setup on WSL without a folder points to the install script and writes nothing", () => {
	const dir = scratch();
	const env = { GENTLE_CHROME_PLATFORM: "wsl", GENTLE_CHROME_NATIVE_HOSTS_DIR: join(dir, "nmh"), GENTLE_CHROME_CONFIG_DIR: join(dir, "cfg"), GENTLE_CHROME_DURABLE_DIR: join(dir, "durable") };
	assert.deepEqual(cli(["setup"], env), { code: 1, stdout: "", stderr: "install-extension: on WSL run scripts/install-extension.sh: it finds your Windows profile folder.\n" });
	assert.deepEqual(readdirSync(dir), []);
});
