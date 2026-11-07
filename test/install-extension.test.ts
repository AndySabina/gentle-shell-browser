import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

/**
 * Runs scripts/install-extension.sh the way a Gentle Shell session does: a
 * PATH without the Windows folders and no WSL_DISTRO_NAME. Windows is faked:
 * wslpath maps C:\ to a scratch folder, so nothing outside it is written and
 * the registry is never touched (the host folder is not on a Windows drive).
 */

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const script = join(root, "scripts", "install-extension.sh");

const scratches: string[] = [];
after(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** Maps C:\ to $FAKE_DRIVE and answers $FAKE_WSL_ROOT for the Windows path of /, like wslpath -w / in a distribution. */
const WSLPATH = String.raw`#!/bin/bash
case "$1" in
-u)
	path=${"$"}{2//\\//}
	case "$path" in
	[A-Za-z]:/*) printf '%s\n' "$FAKE_DRIVE/${"$"}{path:3}" ;;
	*) printf '%s\n' "$path" ;;
	esac ;;
-w)
	if [ "$2" = / ]; then printf '%s\n' "${"$"}{FAKE_WSL_ROOT:-/}"; else printf 'C:\\fake%s\n' "${"$"}{2//\//\\}"; fi ;;
*) exit 1 ;;
esac
`;

function executable(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, { mode: 0o755 });
}

/** A cmd.exe or powershell.exe that prints `profile` as %USERPROFILE%, with Windows' CRLF. */
function profileCommand(profile: string): string {
	return `#!/bin/sh\nprintf '%s\\r\\n' '${profile}'\n`;
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "gentle-chrome-script-"));
	scratches.push(dir);
	const paths = { bin: join(dir, "bin"), drive: join(dir, "c"), home: join(dir, "home"), config: join(dir, "config"), durable: join(dir, "durable") };
	mkdirSync(paths.drive);
	mkdirSync(paths.home);
	executable(join(paths.bin, "wslpath"), WSLPATH);
	symlinkSync(process.execPath, join(paths.bin, "node"));
	return paths;
}

/** Runs the script with only the given environment: no inherited PATH entries, no WSL_DISTRO_NAME unless passed. */
function run(paths: ReturnType<typeof setup>, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync("bash", [script, ...args], {
		env: { PATH: `${paths.bin}:/usr/bin:/bin`, HOME: paths.home, GENTLE_CHROME_CONFIG_DIR: paths.config, GENTLE_CHROME_DURABLE_DIR: paths.durable, FAKE_DRIVE: paths.drive, ...env },
		encoding: "utf8",
		// A fake that waits for input must fail the test, not leave it running.
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	assert.equal(result.error, undefined, `install-extension.sh failed to run: ${result.error}`);
	assert.equal(result.signal, null, `install-extension.sh killed by ${result.signal}; stderr: ${result.stderr}`);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function bat(target: string): string {
	return readFileSync(join(`${target}-host`, "gentle-shell-host.bat"), "utf8");
}

/** The .bat starts `distro` (or no -d) and the host of this checkout, bound to `config`. */
function assertBat(target: string, distro: string | undefined, config: string): void {
	const text = bat(target);
	assert.ok(text.startsWith(`@echo off\r\n%SystemRoot%\\System32\\wsl.exe ${distro ? `-d ${distro} ` : ""}-e "`), text);
	assert.ok(text.endsWith(`" "${root}/src/host.ts" --config-dir "${config}"\r\n`), text);
}

test("without cmd.exe on PATH the script finds it in the Windows System32 folder and installs into %USERPROFILE%", () => {
	const paths = setup();
	executable(join(paths.drive, "Windows", "System32", "cmd.exe"), profileCommand("C:\\Users\\you"));
	const { code, stdout, stderr } = run(paths, [], { WSL_DISTRO_NAME: "Ubuntu" });
	const target = join(paths.drive, "Users", "you", "gentle-shell-chrome");
	assert.equal(code, 0, stderr);
	assert.match(stdout, /^Copied Gentle Shell Browser /m);
	assert.ok(existsSync(join(target, "manifest.json")));
	assert.equal(readFileSync(join(paths.config, "extension-target"), "utf8"), `${target}\n`);
	assert.equal(readFileSync(join(paths.durable, "extension-target"), "utf8"), `${target}\n`);
	assertBat(target, "Ubuntu", paths.config);
});

test("without cmd.exe anywhere the script uses powershell.exe from System32", () => {
	const paths = setup();
	executable(join(paths.drive, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), profileCommand("C:\\Users\\you"));
	const { code, stderr } = run(paths, [], { WSL_DISTRO_NAME: "Ubuntu" });
	const target = join(paths.drive, "Users", "you", "gentle-shell-chrome");
	assert.equal(code, 0, stderr);
	assert.ok(existsSync(join(target, "manifest.json")));
	assertBat(target, "Ubuntu", paths.config);
});

test("a cmd.exe on PATH is still used before the System32 one", () => {
	const paths = setup();
	executable(join(paths.bin, "cmd.exe"), profileCommand("C:\\Users\\me"));
	executable(join(paths.drive, "Windows", "System32", "cmd.exe"), profileCommand("C:\\Users\\you"));
	const { code, stderr } = run(paths, [], { WSL_DISTRO_NAME: "Ubuntu" });
	assert.equal(code, 0, stderr);
	assert.ok(existsSync(join(paths.drive, "Users", "me", "gentle-shell-chrome", "manifest.json")));
	assert.equal(existsSync(join(paths.drive, "Users", "you")), false);
});

test("with neither cmd.exe nor powershell.exe the script still asks for the folder and writes nothing", () => {
	const paths = setup();
	const { code, stdout, stderr } = run(paths, [], { WSL_DISTRO_NAME: "Ubuntu" });
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.equal(stderr, "install-extension: neither cmd.exe nor powershell.exe found: pass the target folder explicitly.\n");
	assert.equal(existsSync(paths.config), false);
	assert.deepEqual(readdirSync(paths.drive), []);
});

test("without WSL_DISTRO_NAME the helper starts the distribution wslpath names for /, and the script says so", () => {
	const paths = setup();
	const target = join(paths.drive, "gentle-shell-chrome");
	const { code, stdout, stderr } = run(paths, [target], { FAKE_WSL_ROOT: "\\\\wsl.localhost\\Ubuntu-24.04\\" });
	assert.equal(code, 0, stderr);
	assertBat(target, "Ubuntu-24.04", paths.config);
	assert.ok(stdout.split("\n").includes("WSL_DISTRO_NAME is not set; the helper starts WSL distribution Ubuntu-24.04 (from wslpath -w /)."), stdout);
});

test("WSL_DISTRO_NAME still decides the distribution, and the script prints no assumption", () => {
	const paths = setup();
	const target = join(paths.drive, "gentle-shell-chrome");
	const { code, stdout, stderr } = run(paths, [target], { WSL_DISTRO_NAME: "Ubuntu", FAKE_WSL_ROOT: "\\\\wsl.localhost\\Other\\" });
	assert.equal(code, 0, stderr);
	assertBat(target, "Ubuntu", paths.config);
	assert.equal(stdout.includes("WSL_DISTRO_NAME is not set"), false);
});
