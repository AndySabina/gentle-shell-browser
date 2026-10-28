import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, nativeHostFiles } from "./host.ts";
import { configDir } from "./token.ts";

/**
 * Keeps the unpacked Chrome extension up to date. Chrome never updates an
 * unpacked extension, so install copies extension/ into a Windows folder,
 * stamps it with build.json (a hash of the files) and records the folder.
 * When the extension connects with another build, the controller copies the
 * files again and asks the extension to reload itself.
 *
 * Install also writes the native messaging host into <target>-host and points
 * the Windows registry at its manifest, so Chrome can start the host.
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
/** This checkout's host script, run by the .bat through wsl.exe. */
const HOST_SCRIPT = fileURLToPath(new URL("./host.ts", import.meta.url));
export const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const REG_EXE = "/mnt/c/Windows/System32/reg.exe";

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

/** The registry key's default value, or undefined when the key or value is missing. */
function queryRegistry(): string | undefined {
	try {
		if (existsSync(REG_EXE)) return /REG_SZ[ \t]+(.*?)\s*$/m.exec(windows(REG_EXE, ["query", REGISTRY_KEY, "/ve"]))?.[1] || undefined;
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

export interface InstallDeps {
	/** Absolute WSL path of node; defaults to the running one. */
	nodePath?: string;
	/** Absolute WSL path of src/host.ts; defaults to this checkout's. */
	hostScript?: string;
	/** WSL distribution the .bat starts; defaults to WSL_DISTRO_NAME. */
	distro?: string;
	windowsPath?(path: string): string;
	/** The registry key's current default value. */
	queryRegistry?(): string | undefined;
	register?(windowsManifestPath: string): void;
}

/** Throws with the install script's messages when `targetDir` must not be written. */
function checkTarget(sourceDir: string, targetDir: string): void {
	if (targetDir === "/" || /^\/mnt(\/[^/]+)?$/.test(targetDir)) throw new Error(`refusing to copy into ${targetDir}: choose a dedicated folder.`);
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

/**
 * Copies `sourceDir` into `targetDir` (overwriting, never deleting), writes
 * build.json and build.js, records `targetDir` for automatic updates, writes the native
 * host into `<targetDir>-host` and registers it when the registry differs.
 */
export function installExtension(options: { sourceDir: string; targetDir: string; configDir: string; deps?: InstallDeps }): {
	build: string;
	targetDir: string;
	hostDir: string;
	registered: boolean;
} {
	const deps = options.deps ?? {};
	const targetDir = resolve(options.targetDir);
	checkTarget(options.sourceDir, targetDir);
	const hostDir = `${targetDir}-host`;
	checkHostDir(hostDir);
	const build = buildId(options.sourceDir);
	mkdirSync(targetDir, { recursive: true });
	const generated = new Set([BUILD_FILE, BUILD_MODULE].map((name) => join(resolve(options.sourceDir), name)));
	cpSync(options.sourceDir, targetDir, { recursive: true, force: true, filter: (path) => !generated.has(resolve(path)) });
	writeFileSync(join(targetDir, BUILD_FILE), `${JSON.stringify({ build })}\n`);
	writeFileSync(join(targetDir, BUILD_MODULE), buildModule(build));
	mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
	const record = join(options.configDir, TARGET_FILE);
	writeFileSync(record, `${targetDir}\n`, { mode: 0o600 });
	chmodSync(record, 0o600);
	const hostDirWindows = (deps.windowsPath ?? windowsPath)(hostDir);
	const { manifest, bat } = nativeHostFiles({
		nodePath: deps.nodePath ?? process.execPath,
		hostScript: deps.hostScript ?? HOST_SCRIPT,
		extensionId: EXTENSION_ID,
		hostDirWindows,
		distro: deps.distro ?? process.env.WSL_DISTRO_NAME ?? "",
	});
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, HOST_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(join(hostDir, HOST_BAT), bat);
	let registered = false;
	const defaults = registersByDefault(hostDir);
	const query = deps.queryRegistry ?? (defaults ? queryRegistry : undefined);
	const write = deps.register ?? (defaults ? register : undefined);
	const manifestPath = `${hostDirWindows}\\${HOST_MANIFEST}`;
	if (query && write && query() !== manifestPath) {
		write(manifestPath);
		registered = true;
	}
	return { build, targetDir, hostDir, registered };
}

/** The folder the last install wrote to, if any. */
export function recordedTarget(dir: string): string | undefined {
	try {
		return readFileSync(join(dir, TARGET_FILE), "utf8").trim() || undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

// scripts/install-extension.sh resolves the folder, then runs: node src/update.ts install <wsl-path>
// (import.meta.main needs Node 24.2; the package supports 22.18.)
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, target] = process.argv.slice(2);
	if (command !== "install" || !target) {
		console.error("Usage: node src/update.ts install <target-dir>");
		process.exit(2);
	}
	try {
		const result = installExtension({ sourceDir: REPO_EXTENSION_DIR, targetDir: target, configDir: configDir(process.env, homedir()) });
		const registry = result.registered ? "updated" : registersByDefault(result.hostDir) ? "unchanged" : "skipped";
		console.log(`${result.build}\n${result.hostDir}\n${registry}`);
	} catch (error) {
		console.error(`install-extension: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
