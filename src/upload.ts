import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { currentPlatform, type Platform } from "./platform.ts";

/**
 * The session side of browser_act upload: every path is checked here, before
 * anything reaches Chrome. Sensitive files (keys, passwords, credentials) are
 * refused always, by the path the agent gave and by the file it resolves to.
 * With Gentle Shell in WSL, Chrome runs on Windows while the files live in
 * WSL, so each real path is converted to one Chrome can read; a Chrome on the
 * same system reads the real path as it is.
 */

export const MAX_UPLOAD_FILES = 10;

/**
 * What the extension gets: Chrome-readable paths, and what the approval prompt
 * lists: each real file's name, the path the agent gave and the real path it
 * resolves to (shown too when a symlink makes them differ).
 */
export interface PreparedUpload {
	files: string[];
	names: string[];
	paths: string[];
	reals: string[];
}

/** Injectable for tests: the filesystem checks and the path converter. */
export interface UploadDeps {
	realpath: (path: string) => Promise<string>;
	stat: (path: string) => Promise<{ isFile(): boolean }>;
	access: (path: string) => Promise<void>;
	convert: (realPath: string) => Promise<string>;
}

/** Runs a program without a shell and answers its standard output. */
export type RunFile = (command: string, args: string[]) => Promise<string>;

const SENSITIVE_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "secrets", ".password-store", "keyrings"]);
/** Folders sensitive only as a pair of segments, such as `.config/gh`. */
const SENSITIVE_PAIRS = new Set([".config/gcloud", ".config/gh"]);
const SENSITIVE_NAMES = new Set([
	".env",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	"credentials",
	"credentials.json",
	"known_hosts",
	"authorized_keys",
	".pgpass",
	".my.cnf",
	".bash_history",
	".zsh_history",
	".python_history",
	".psql_history",
	"wallet.dat",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".kdb", ".ppk", ".asc", ".gpg", ".ovpn"]);
/** Saved passwords, cookies and card data: sensitive only inside a Chrome, Chromium, Edge or Brave profile. */
const BROWSER_NAMES = new Set(["login data", "cookies", "web data"]);
const BROWSER_PROFILES = new Set(["user data"]);
const BROWSER_PROFILE_PAIRS = new Set([".config/google-chrome", ".config/chromium", ".config/microsoft-edge", ".config/bravesoftware"]);
/** SSH key files and their .pub companions, whatever follows the key type. */
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)/;
/** A Windows drive as WSL mounts it. */
const DRIVE = /^\/mnt\/([a-z])(\/.*)?$/i;

/**
 * Whether `path` names a sensitive file: a sensitive folder anywhere in it, or
 * a sensitive name or extension. Case and trailing spaces or dots do not
 * count: Windows ignores the first and strips the others.
 */
export function isSensitivePath(path: string): boolean {
	const segments = path
		.toLowerCase()
		.split("/")
		.map((segment) => segment.replace(/[. ]+$/, ""))
		.filter(Boolean);
	if (segments.some((segment) => SENSITIVE_FOLDERS.has(segment))) return true;
	const pairs = segments.slice(1).map((segment, index) => `${segments[index]}/${segment}`);
	if (pairs.some((pair) => SENSITIVE_PAIRS.has(pair))) return true;
	const name = segments.at(-1) ?? "";
	if (SENSITIVE_NAMES.has(name) || name.startsWith(".env.") || SSH_KEY.test(name)) return true;
	const inBrowserProfile = segments.slice(0, -1).some((segment) => BROWSER_PROFILES.has(segment)) || pairs.slice(0, -1).some((pair) => BROWSER_PROFILE_PAIRS.has(pair));
	if (inBrowserProfile && BROWSER_NAMES.has(name)) return true;
	const dot = name.lastIndexOf(".");
	return dot > 0 && SENSITIVE_EXTENSIONS.has(name.slice(dot));
}

const runFile: RunFile = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
	});

/** A WSL path as Chrome on Windows reads it: a drive path for /mnt/<drive>/, otherwise what `wslpath -w` answers. */
export async function windowsPath(path: string, run: RunFile = runFile): Promise<string> {
	const drive = DRIVE.exec(path);
	if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").split("/").filter(Boolean).join("\\")}`;
	const converted = (await run("wslpath", ["-w", path])).replace(/\r?\n$/, "");
	if (!converted) throw new Error("wslpath answered nothing");
	return converted;
}

/** The path Chrome reads: converted for Windows Chrome on WSL, the same path elsewhere. */
export async function chromePath(path: string, platform: Platform = currentPlatform(), run: RunFile = runFile): Promise<string> {
	return platform === "wsl" ? windowsPath(path, run) : path;
}

const DEFAULT_DEPS: UploadDeps = {
	realpath,
	stat,
	access: (path) => access(path, constants.R_OK),
	convert: (path) => chromePath(path),
};

const refused = (text: string) => new Error(`Upload refused: ${text}`);
const sensitive = (shown: string) =>
	refused(`${shown} is a sensitive file (keys, passwords or credentials), which is never uploaded. Do not retry it or look for another way to upload it.`);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Checks one path and answers the real file it names. */
async function checkPath(path: string, deps: UploadDeps): Promise<string> {
	const shown = JSON.stringify(path);
	if (!isAbsolute(path)) throw refused(`${shown} is not an absolute path. Pass the file's full path.`);
	if (isSensitivePath(path)) throw sensitive(shown);
	let real: string;
	try {
		real = await deps.realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw refused(`${shown} does not exist.`);
		throw refused(`${shown} cannot be read.`);
	}
	if (isSensitivePath(real)) throw sensitive(real === path ? shown : `${shown} (resolves to ${JSON.stringify(real)})`);
	const info = await deps.stat(real).catch(() => undefined);
	if (!info) throw refused(`${shown} cannot be read.`);
	if (!info.isFile()) throw refused(`${shown} is not a regular file.`);
	await deps.access(real).catch(() => {
		throw refused(`${shown} cannot be read.`);
	});
	return real;
}

/**
 * Checks every path, then converts each real path for Chrome. Throws, before
 * converting anything, on the first path that is refused.
 */
export async function prepareUpload(paths: readonly unknown[], overrides: Partial<UploadDeps> = {}): Promise<PreparedUpload> {
	const deps = { ...DEFAULT_DEPS, ...overrides };
	if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_UPLOAD_FILES || !paths.every((path) => typeof path === "string" && path)) {
		throw refused(`pass 1 to ${MAX_UPLOAD_FILES} local file paths.`);
	}
	const given = paths as string[];
	const reals: string[] = [];
	for (const path of given) reals.push(await checkPath(path, deps));
	const files: string[] = [];
	for (const [index, real] of reals.entries()) {
		try {
			files.push(await deps.convert(real));
		} catch (error) {
			throw refused(`${JSON.stringify(given[index])} could not be converted to a path Chrome can read (${reason(error)}).`);
		}
	}
	// Named by the real file: that is the one Chrome reads and the page receives.
	return { files, names: reals.map((real) => basename(real)), paths: [...given], reals };
}
