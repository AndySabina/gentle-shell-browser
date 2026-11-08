import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Where Chrome runs relative to this checkout, which decides how the
 * extension and its native helper are installed: "wsl" is Windows Chrome
 * with Gentle Shell inside WSL; the others are Chrome on the same system.
 */
export type Platform = "wsl" | "linux" | "darwin" | "win32";

const PLATFORMS: readonly Platform[] = ["wsl", "linux", "darwin", "win32"];
const FOLDER = "gentle-shell-chrome";

type Env = Record<string, string | undefined>;

/** The platform, from GENTLE_CHROME_PLATFORM when set (e.g. a Linux Chrome inside WSL), else detected. */
export function detectPlatform(options: { os: string; exists(path: string): boolean; readFile(path: string): string; env: Env }): Platform {
	const forced = options.env.GENTLE_CHROME_PLATFORM;
	if (forced) {
		if (!(PLATFORMS as readonly string[]).includes(forced)) throw new Error(`GENTLE_CHROME_PLATFORM must be one of ${PLATFORMS.join(", ")} (got ${forced}).`);
		return forced as Platform;
	}
	if (options.os === "darwin" || options.os === "win32") return options.os;
	if (options.exists("/proc/sys/fs/binfmt_misc/WSLInterop") || options.exists("/proc/sys/fs/binfmt_misc/WSLInterop-late")) return "wsl";
	try {
		if (/microsoft/i.test(options.readFile("/proc/version"))) return "wsl";
	} catch {}
	return "linux";
}

/** The platform of this process, from the real filesystem and environment. */
export function currentPlatform(): Platform {
	return detectPlatform({ os: process.platform, exists: existsSync, readFile: (path) => readFileSync(path, "utf8"), env: process.env });
}

/** The extension folder used when none is given; on WSL the install script asks Windows for it instead. */
export function defaultTarget(platform: Platform, home: string, env: Env): string | undefined {
	if (platform === "linux") return posix.join(home, ".local", "share", FOLDER);
	if (platform === "darwin") return posix.join(home, "Library", "Application Support", FOLDER);
	if (platform === "win32") return win32.join(env.USERPROFILE || home, FOLDER);
	return undefined;
}

/**
 * The folders Chrome (and Chromium, when it is there) reads native messaging
 * host manifests from; GENTLE_CHROME_NATIVE_HOSTS_DIR replaces the list, for
 * another Chromium browser. Empty on WSL and Windows, which use the registry.
 */
export function nativeHostDirs(platform: Platform, home: string, env: Env, exists: (path: string) => boolean): string[] {
	if (platform !== "linux" && platform !== "darwin") return [];
	if (env.GENTLE_CHROME_NATIVE_HOSTS_DIR) return [env.GENTLE_CHROME_NATIVE_HOSTS_DIR];
	const [chrome, chromium] =
		platform === "linux"
			? [posix.join(home, ".config", "google-chrome"), posix.join(home, ".config", "chromium")]
			: [posix.join(home, "Library", "Application Support", "Google", "Chrome"), posix.join(home, "Library", "Application Support", "Chromium")];
	return [chrome, ...(exists(chromium) ? [chromium] : [])].map((dir) => posix.join(dir, "NativeMessagingHosts"));
}
