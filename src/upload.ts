import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

/**
 * The session side of browser_act upload: every path is checked here, before
 * anything reaches Chrome. Sensitive files (keys, passwords, credentials) are
 * refused always, by the path the agent gave and by the file it resolves to.
 * Chrome runs on Windows while the files live in WSL, so each real path is
 * converted to one Chrome can read.
 */

export const MAX_UPLOAD_FILES = 10;

/** What the extension gets: Chrome-readable paths, and the names and paths the approval prompt lists. */
export interface PreparedUpload {
	files: string[];
	names: string[];
	paths: string[];
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
const SENSITIVE_NAMES = new Set([".env", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials", "credentials.json", "known_hosts", "authorized_keys"]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".ppk", ".asc", ".gpg"]);
/** SSH key files and their .pub companions, whatever follows the key type. */
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)/;
/** A Windows drive as WSL mounts it. */
const DRIVE = /^\/mnt\/([a-z])(\/.*)?$/i;

/**
 * Whether `path` names a sensitive file: a sensitive folder anywhere in it, or
 * a sensitive name or extension. Case does not count: Windows drives ignore it.
 */
export function isSensitivePath(path: string): boolean {
	const segments = path.toLowerCase().split("/").filter(Boolean);
	if (segments.some((segment) => SENSITIVE_FOLDERS.has(segment))) return true;
	const name = segments.at(-1) ?? "";
	if (SENSITIVE_NAMES.has(name) || name.startsWith(".env.") || SSH_KEY.test(name)) return true;
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

const DEFAULT_DEPS: UploadDeps = {
	realpath,
	stat,
	access: (path) => access(path, constants.R_OK),
	convert: (path) => windowsPath(path),
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
	return { files, names: given.map((path) => basename(path)), paths: [...given] };
}
