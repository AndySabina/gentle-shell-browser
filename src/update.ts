import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, type HostManifest, nativeHostFiles, posixHostFiles, windowsHostFiles } from "./host.ts";
import { currentPlatform, defaultTarget, nativeHostDirs, type Platform } from "./platform.ts";
import { configDir } from "./token.ts";

/**
 * Keeps the unpacked Chrome extension up to date. Chrome never updates an
 * unpacked extension, so install copies extension/ into a folder Chrome can
 * load (a Windows folder when Gentle Shell runs in WSL), stamps it with build.json (a hash of the files) and records the folder.
 * When the extension connects with another build, the controller copies the
 * files again and asks the extension to reload itself.
 *
 * The folder is also recorded in the user's real ~/.config/gentle-chrome: a
 * Gentle Shell session points HOME and XDG_CONFIG_HOME into its install, and
 * a Gentle Shell update replaces that config folder with its record.
 *
 * Install also writes the native messaging host into <target>-host and points
 * Chrome at its manifest, so Chrome can start the host: through the Windows
 * registry on WSL and Windows, and through a copy of the manifest in Chrome's
 * NativeMessagingHosts folders on Linux and macOS.
 */

export const NAME = "Gentle Shell Browser";
/** The extension/ folder of this checkout. */
export const REPO_EXTENSION_DIR = fileURLToPath(new URL("../extension", import.meta.url));
const BUILD_FILE = "build.json";
/** The worker imports its build from here, so a worker Chrome kept from an older copy reports that copy's build. */
const BUILD_MODULE = "build.js";
const TARGET_FILE = "extension-target";
const HOST_MANIFEST = `${HOST_NAME}.json`;
const HOST_BAT = "gentle-shell-host.bat";
const HOST_SH = "gentle-shell-host.sh";
/** This checkout's host script, run by the launcher. */
const HOST_SCRIPT = fileURLToPath(new URL("./host.ts", import.meta.url));
export const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const REG_EXE = "/mnt/c/Windows/System32/reg.exe";

/**
 * Where the extension folder is also recorded: the account's home from the
 * password database, which a Gentle Shell session's HOME does not change.
 */
export function durableConfigDir(): string {
	return join(userInfo().homedir, ".config", "gentle-chrome");
}

/** Writes `targetDir` as the extension-target record in `dir` (0600, in a 0700 folder). */
function writeRecord(dir: string, targetDir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const record = join(dir, TARGET_FILE);
	writeFileSync(record, `${targetDir}\n`, { mode: 0o600 });
	chmodSync(record, 0o600);
}

/** Every file under `dir`, as sorted relative POSIX paths. */
function files(dir: string): string[] {
	const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter((path) => path !== BUILD_FILE && path !== BUILD_MODULE)
		.sort();
}

/** The build.js install writes: part of the worker's code, unlike build.json. */
export function buildModule(build: string): string {
	return `// Written by install; the build this copy's code belongs to.\nexport const BUILD = ${JSON.stringify(build)};\n`;
}

/** First 16 hex characters of a sha256 over every file's path and bytes; build.json and build.js do not count. */
export function buildId(extensionDir: string): string {
	const hash = createHash("sha256");
	for (const path of files(extensionDir)) {
		hash.update(`${path}\0`);
		hash.update(readFileSync(join(extensionDir, path)));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

function isPreviousCopy(dir: string): boolean {
	try {
		return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))?.name === NAME;
	} catch {
		return false;
	}
}

function isPreviousHost(dir: string): boolean {
	try {
		return JSON.parse(readFileSync(join(dir, HOST_MANIFEST), "utf8"))?.name === HOST_NAME;
	} catch {
		return false;
	}
}

/** Throws when `hostDir` exists and is not an empty folder or a previous host folder. */
function checkHostDir(hostDir: string): void {
	let stats;
	try {
		stats = statSync(hostDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stats.isDirectory()) throw new Error(`${hostDir} exists and is not a folder.`);
	if (readdirSync(hostDir).length > 0 && !isPreviousHost(hostDir)) {
		throw new Error(`${hostDir} is not empty and is not a previous Gentle Shell native host folder. Move it away or choose another extension folder.`);
	}
}

/** Windows commands run from C: so they do not warn about a WSL working directory. */
function windows(command: string, args: string[]): string {
	return execFileSync(command, args, { cwd: "/mnt/c", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function powershellQuote(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

const PS_KEY = powershellQuote(REGISTRY_KEY.replace(/^HKCU\\/, "HKCU:\\"));

/** The default value in what `reg.exe query <key> /ve` printed. */
function registryDefault(output: string): string | undefined {
	return /REG_SZ[ \t]+(.*?)\s*$/m.exec(output)?.[1] || undefined;
}

/** The registry key's default value, or undefined when the key or value is missing. */
function queryRegistry(): string | undefined {
	try {
		if (existsSync(REG_EXE)) return registryDefault(windows(REG_EXE, ["query", REGISTRY_KEY, "/ve"]));
		return windows("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath ${PS_KEY} -ErrorAction Stop).GetValue('')`]).trim() || undefined;
	} catch {
		return undefined;
	}
}

function register(windowsManifestPath: string): void {
	if (existsSync(REG_EXE)) {
		windows(REG_EXE, ["add", REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", windowsManifestPath, "/f"]);
		return;
	}
	windows("powershell.exe", ["-NoProfile", "-Command", `New-Item -Path ${PS_KEY} -Force | Out-Null; Set-ItemProperty -LiteralPath ${PS_KEY} -Name '(default)' -Value ${powershellQuote(windowsManifestPath)}`]);
}

/** reg.exe on native Windows, from System32 like the WSL helper's wsl.exe. */
function nativeReg(args: string[]): string {
	return execFileSync(`${process.env.SystemRoot || "C:\\Windows"}\\System32\\reg.exe`, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function queryNativeRegistry(): string | undefined {
	try {
		return registryDefault(nativeReg(["query", REGISTRY_KEY, "/ve"]));
	} catch {
		return undefined;
	}
}

function registerNative(manifestPath: string): void {
	nativeReg(["add", REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
}

/** `wslpath -w`; outside WSL the path is kept as it is. */
function windowsPath(path: string): string {
	try {
		return execFileSync("wslpath", ["-w", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || path;
	} catch {
		return path;
	}
}

/**
 * The registry is only touched by default for a host folder on a Windows
 * drive (/mnt/<drive>/...): a folder inside WSL is a test or a mistake, and
 * must never replace the real registration.
 */
export function registersByDefault(hostDir: string): boolean {
	return /^\/mnt\/[a-z]\//.test(hostDir);
}

/**
 * The distribution in the Windows path of this distribution's root, as `wslpath -w /`
 * prints it (\\wsl.localhost\<name>\ or \\wsl$\<name>): the one actually running,
 * unlike /etc/os-release or the default distribution. "" when the path names none.
 */
function distroFromRoot(root: string): string {
	return /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?$/i.exec(root)?.[1] ?? "";
}

const UNKNOWN_DISTRO = "could not tell which WSL distribution this is; set WSL_DISTRO_NAME to its name (wsl.exe -l -q lists them) and run again.";

export interface InstallDeps {
	/** Where Chrome runs; defaults to currentPlatform(). */
	platform?: Platform;
	/** The account's real home, whose Chrome folders get the manifest on Linux and macOS; defaults to the password database's. */
	home?: string;
	/** Read for GENTLE_CHROME_NATIVE_HOSTS_DIR on Linux and macOS; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Absolute path of node (in WSL on WSL); defaults to the running one. */
	nodePath?: string;
	/** Absolute path of src/host.ts; defaults to this checkout's. */
	hostScript?: string;
	/**
	 * WSL distribution the .bat starts; defaults to WSL_DISTRO_NAME, then to the one
	 * `windowsPath("/")` names (a Gentle Shell session does not pass WSL_DISTRO_NAME).
	 */
	distro?: string;
	windowsPath?(path: string): string;
	/** The registry key's current default value (WSL and Windows). */
	queryRegistry?(): string | undefined;
	register?(windowsManifestPath: string): void;
}

/** Throws with the install script's messages when `targetDir` must not be written. */
function checkTarget(sourceDir: string, targetDir: string): void {
	if (targetDir === "/" || /^\/mnt(\/[^/]+)?$/.test(targetDir) || /^[A-Za-z]:[\\/]?$/.test(targetDir)) throw new Error(`refusing to copy into ${targetDir}: choose a dedicated folder.`);
	let stats;
	try {
		stats = statSync(targetDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stats.isDirectory()) throw new Error(`${targetDir} exists and is not a folder.`);
	if (realpathSync(targetDir) === realpathSync(sourceDir)) throw new Error("the target is the source extension/ folder itself.");
	if (readdirSync(targetDir).length > 0 && !isPreviousCopy(targetDir)) {
		throw new Error(`${targetDir} is not empty and is not a previous copy of ${NAME}. Choose an empty or new folder.`);
	}
}

/** The helper's files for one platform, and how to point Chrome at its manifest. */
interface NativeHost {
	manifest: HostManifest;
	launcherName: string;
	launcher: string;
	/** Points Chrome at the manifest; true when that changed anything. */
	register(): boolean;
}

/** Windows Chrome with this checkout in WSL: a .bat that runs wsl.exe, registered when the folder is on a Windows drive. */
function wslHost(hostDir: string, configDir: string, deps: InstallDeps): NativeHost {
	const toWindows = deps.windowsPath ?? windowsPath;
	const hostDirWindows = toWindows(hostDir);
	const distro = deps.distro ?? (process.env.WSL_DISTRO_NAME || distroFromRoot(toWindows("/")));
	// Without -d, wsl.exe starts the default distribution, which may not hold this checkout or this Node.
	if (!distro && registersByDefault(hostDir)) throw new Error(UNKNOWN_DISTRO);
	const { manifest, bat } = nativeHostFiles({
		nodePath: deps.nodePath ?? process.execPath,
		hostScript: deps.hostScript ?? HOST_SCRIPT,
		extensionId: EXTENSION_ID,
		hostDirWindows,
		distro,
		configDir,
	});
	return {
		manifest,
		launcherName: HOST_BAT,
		launcher: bat,
		register: () => {
			const defaults = registersByDefault(hostDir);
			const query = deps.queryRegistry ?? (defaults ? queryRegistry : undefined);
			const write = deps.register ?? (defaults ? register : undefined);
			const manifestPath = `${hostDirWindows}\\${HOST_MANIFEST}`;
			if (!query || !write || query() === manifestPath) return false;
			write(manifestPath);
			return true;
		},
	};
}

/** Native Windows Chrome: a .bat that runs node.exe, registered under HKCU. */
function windowsHost(hostDir: string, configDir: string, deps: InstallDeps): NativeHost {
	const { manifest, bat } = windowsHostFiles({ nodePath: deps.nodePath ?? process.execPath, hostScript: deps.hostScript ?? HOST_SCRIPT, extensionId: EXTENSION_ID, hostDir, configDir });
	return {
		manifest,
		launcherName: HOST_BAT,
		launcher: bat,
		register: () => {
			const manifestPath = `${hostDir}\\${HOST_MANIFEST}`;
			if ((deps.queryRegistry ?? queryNativeRegistry)() === manifestPath) return false;
			(deps.register ?? registerNative)(manifestPath);
			return true;
		},
	};
}

/** Where Chrome on Linux or macOS finds the manifest: one copy in each of its NativeMessagingHosts folders. */
export function chromeManifests(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
	return nativeHostDirs(platform, home, env, existsSync).map((dir) => join(dir, HOST_MANIFEST));
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Linux or macOS Chrome: a shell launcher, and the manifest copied into Chrome's folders. */
function posixHost(platform: Platform, hostDir: string, configDir: string, deps: InstallDeps): NativeHost {
	const manifests = chromeManifests(platform, deps.home ?? userInfo().homedir, deps.env ?? process.env);
	const { manifest, launcher } = posixHostFiles({ nodePath: deps.nodePath ?? process.execPath, hostScript: deps.hostScript ?? HOST_SCRIPT, extensionId: EXTENSION_ID, hostDir, configDir });
	return {
		manifest,
		launcherName: HOST_SH,
		launcher,
		register: () => {
			const text = manifestText(manifest);
			let changed = false;
			for (const path of manifests) {
				if (readOptional(path) === text) continue;
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, text);
				changed = true;
			}
			return changed;
		},
	};
}

function manifestText(manifest: HostManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Copies `sourceDir` into `targetDir` (overwriting, never deleting), writes
 * build.json and build.js, records `targetDir` for automatic updates (in
 * `configDir`, and in `durableDir` when given), writes the native host into
 * `<targetDir>-host` and points Chrome at it when that is not done yet.
 */
export function installExtension(options: { sourceDir: string; targetDir: string; configDir: string; durableDir?: string; deps?: InstallDeps }): {
	build: string;
	targetDir: string;
	hostDir: string;
	registered: boolean;
} {
	const deps = options.deps ?? {};
	const platform = deps.platform ?? currentPlatform();
	const targetDir = resolve(options.targetDir);
	checkTarget(options.sourceDir, targetDir);
	const hostDir = `${targetDir}-host`;
	checkHostDir(hostDir);
	// Built before anything is written, so a path the helper cannot use leaves everything untouched.
	// Chrome starts the helper with its own environment, so it is told this folder explicitly.
	const config = resolve(options.configDir);
	const host = platform === "wsl" ? wslHost(hostDir, config, deps) : platform === "win32" ? windowsHost(hostDir, config, deps) : posixHost(platform, hostDir, config, deps);
	const build = buildId(options.sourceDir);
	mkdirSync(targetDir, { recursive: true });
	const generated = new Set([BUILD_FILE, BUILD_MODULE].map((name) => join(resolve(options.sourceDir), name)));
	cpSync(options.sourceDir, targetDir, { recursive: true, force: true, filter: (path) => !generated.has(resolve(path)) });
	writeFileSync(join(targetDir, BUILD_FILE), `${JSON.stringify({ build })}\n`);
	writeFileSync(join(targetDir, BUILD_MODULE), buildModule(build));
	writeRecord(options.configDir, targetDir);
	if (options.durableDir !== undefined && resolve(options.durableDir) !== resolve(options.configDir)) writeRecord(options.durableDir, targetDir);
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, HOST_MANIFEST), manifestText(host.manifest));
	const launcher = join(hostDir, host.launcherName);
	writeFileSync(launcher, host.launcher, { mode: 0o755 });
	if (host.launcherName === HOST_SH) chmodSync(launcher, 0o755);
	return { build, targetDir, hostDir, registered: host.register() };
}

function readRecord(dir: string): string | undefined {
	try {
		return readFileSync(join(dir, TARGET_FILE), "utf8").trim() || undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The folder the last install wrote to, if any: `dir`'s record, else `durableDir`'s when given. */
export function recordedTarget(dir: string, durableDir?: string): string | undefined {
	return readRecord(dir) ?? (durableDir === undefined ? undefined : readRecord(durableDir));
}

/**
 * Whether the helper recorded for `dir` reads `dir`, from the files the last
 * install wrote. It says nothing about whether Chrome runs that helper.
 */
export type HostBinding =
	| { state: "absent" }
	| { state: "bound"; hostDir: string }
	| { state: "mismatched"; hostDir: string; boundTo: string }
	/** A helper written before installs recorded the folder: it uses its own environment's. */
	| { state: "unbound"; hostDir: string }
	/** The Node the helper starts is gone (a Gentle Shell reinstall or Node upgrade removed it), so Chrome cannot start it. */
	| { state: "stale"; hostDir: string; nodePath: string }
	| { state: "unknown"; hostDir?: string; reason: string };

function samePath(a: string, b: string): boolean {
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}

export function hostBinding(dir: string, durableDir?: string): HostBinding {
	let target: string | undefined;
	try {
		target = recordedTarget(dir, durableDir);
	} catch (error) {
		return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
	}
	if (!target) return { state: "absent" };
	const hostDir = `${target}-host`;
	const launcherPath = join(hostDir, launcherName(hostDir));
	let launcher: string;
	try {
		launcher = readFileSync(launcherPath, "utf8");
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? `${launcherPath} is missing` : error instanceof Error ? error.message : String(error);
		return { state: "unknown", hostDir, reason };
	}
	const { nodePath, boundTo } = launcherPath.endsWith(HOST_SH) ? shellLauncher(launcher) : batLauncher(launcher);
	// The launcher pins the Node that ran the install; a missing one stops the helper before any folder matters.
	if (nodePath && !existsSync(nodePath)) return { state: "stale", hostDir, nodePath };
	if (!boundTo) return { state: "unbound", hostDir };
	return samePath(boundTo, dir) ? { state: "bound", hostDir } : { state: "mismatched", hostDir, boundTo };
}

/** The launcher the folder's manifest names, else the shell launcher when only it exists, else the .bat. */
function launcherName(hostDir: string): string {
	try {
		const path = JSON.parse(readFileSync(join(hostDir, HOST_MANIFEST), "utf8"))?.path;
		if (typeof path === "string") for (const name of [HOST_SH, HOST_BAT]) if (path.endsWith(name)) return name;
	} catch {}
	return existsSync(join(hostDir, HOST_SH)) && !existsSync(join(hostDir, HOST_BAT)) ? HOST_SH : HOST_BAT;
}

/** The Node and folder in a .bat: after wsl.exe's -e on WSL, the first quoted word on Windows. */
function batLauncher(bat: string): { nodePath?: string; boundTo?: string } {
	return { nodePath: / -e "([^"]+)"/.exec(bat)?.[1] ?? /^"([^"]+)"/m.exec(bat)?.[1], boundTo: / --config-dir "([^"]+)"\r?$/m.exec(bat)?.[1] };
}

/** The Node and folder in the shell launcher's exec line, unquoted. */
function shellLauncher(script: string): { nodePath?: string; boundTo?: string } {
	const line = /^exec (.*)$/m.exec(script)?.[1] ?? "";
	const words = [...line.matchAll(/(?:'[^']*'|\\.|[^\s'\\])+/g)].map(([word]) => word.replace(/'([^']*)'|\\(.)/g, (_, quoted?: string, escaped?: string) => quoted ?? escaped ?? ""));
	const at = words.indexOf("--config-dir");
	return { nodePath: words[0], boundTo: at === -1 ? undefined : words[at + 1] };
}

function failed(error: unknown): never {
	console.error(`install-extension: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

/** `install <target>`: what scripts/install-extension.sh reads on WSL (build, host folder, registry state). */
function install(target: string): void {
	try {
		const durableDir = process.env.GENTLE_CHROME_DURABLE_DIR || durableConfigDir();
		const result = installExtension({ sourceDir: REPO_EXTENSION_DIR, targetDir: target, configDir: configDir(process.env, homedir()), durableDir });
		const registry = result.registered ? "updated" : registersByDefault(result.hostDir) ? "unchanged" : "skipped";
		console.log(`${result.build}\n${result.hostDir}\n${registry}`);
	} catch (error) {
		failed(error);
	}
}

/** `setup [folder]` (npm run install-extension): installs for the Chrome on this system and says what it did. */
function setup(folder: string | undefined): void {
	try {
		const platform = currentPlatform();
		const home = userInfo().homedir;
		const target = folder || defaultTarget(platform, home, process.env);
		if (!target) throw new Error("on WSL run scripts/install-extension.sh: it finds your Windows profile folder.");
		const durableDir = process.env.GENTLE_CHROME_DURABLE_DIR || durableConfigDir();
		const result = installExtension({ sourceDir: REPO_EXTENSION_DIR, targetDir: target, configDir: configDir(process.env, homedir()), durableDir, deps: { platform, home, env: process.env } });
		const version = JSON.parse(readFileSync(join(REPO_EXTENSION_DIR, "manifest.json"), "utf8")).version;
		const lines = [`Copied ${NAME} ${version} (build ${result.build}) to ${result.targetDir}`, `Native host written to ${result.hostDir}`];
		if (platform === "linux" || platform === "darwin") {
			for (const path of chromeManifests(platform, home, process.env)) lines.push(`${result.registered ? "Registered" : "Already registered"} for Chrome: ${path}`);
		} else if (result.registered) lines.push(`Registry updated: ${REGISTRY_KEY}`);
		else if (platform === "win32" || registersByDefault(result.hostDir)) lines.push(`Registry already up to date: ${REGISTRY_KEY}`);
		else console.error("Registry not updated: the host folder is not on a Windows drive.");
		lines.push(
			"",
			"First time: open chrome://extensions in Chrome, turn on Developer mode,",
			'press "Load unpacked" and choose:',
			`  ${result.targetDir}`,
			"",
			"After that first load, Gentle Shell updates the extension by itself whenever it",
			"connects with an older build.",
		);
		console.log(lines.join("\n"));
	} catch (error) {
		failed(error);
	}
}

// scripts/install-extension.sh resolves the folder, then runs: node src/update.ts install <wsl-path>
// npm run install-extension runs: node src/update.ts setup [folder]
// (import.meta.main needs Node 24.2; the package supports 22.18.)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, target, ...rest] = process.argv.slice(2);
	if (command === "install" && target) install(target);
	else if (command === "setup" && rest.length === 0) setup(target);
	else {
		console.error("Usage: node src/update.ts install <target-dir>\n       node src/update.ts setup [folder]");
		process.exit(2);
	}
}
