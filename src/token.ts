import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VALID_TOKEN = /^[A-Za-z0-9_-]{32,}$/;

/** Directory holding gentle-chrome's local state; nothing here is ever committed or shared. */
export function configDir(env: Record<string, string | undefined>, home: string): string {
	if (env.GENTLE_CHROME_CONFIG_DIR) return env.GENTLE_CHROME_CONFIG_DIR;
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "gentle-chrome");
}

/** Returns the stored bearer token, creating a random one (mode 0600) on first use. */
export function loadOrCreateToken(dir: string): string {
	const file = join(dir, "token");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (;;) {
		try {
			const stored = readFileSync(file, "utf8").trim();
			if (!VALID_TOKEN.test(stored)) {
				throw new Error(`gentle-chrome token file ${file} is invalid; delete it to generate a new one`);
			}
			return stored;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const token = randomBytes(32).toString("base64url");
		try {
			writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
			return token;
		} catch (error) {
			// Another session created it first; read theirs.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** Constant-time comparison that does not leak the expected length. */
export function tokensEqual(received: string, expected: string): boolean {
	if (!received || !expected) return false;
	const a = createHash("sha256").update(received).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}
