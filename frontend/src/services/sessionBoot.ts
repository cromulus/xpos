/**
 * The till's boot when it starts offline, and a fresh boot + CSRF token before it writes again
 * (MuleCity-q8aq).
 *
 * Online, Frappe renders /xpos with the session's boot and CSRF token (xpos/www/xpos.py). Each such
 * start saves a copy of the boot in IndexedDB with the token and any other secret removed
 * (sanitizeBoot). With the network down, the service worker serves the static app shell instead
 * (no boot, no token, window.xpos.offlineShell); the page restores that saved boot and runs offline.
 *
 * Whenever the page may hold a stale session (it started from the shell, or the network dropped),
 * the session is marked stale, and services/api.ts asks ensureFreshSession() before any write: one
 * GET of xpos.api.auth.get_session_boot replaces window.xpos.boot and the token. If the session
 * has expired, nothing is written, "xpos:session-expired" is announced (the till shows its login)
 * and the offline queue stays as it is.
 */
import { getApiBaseUrlSync, isElectron } from "@/services/electronBridge";

export const OFFLINE_BOOT_KEY = "offline_boot";
export const SESSION_EXPIRED_EVENT = "xpos:session-expired";
const SESSION_BOOT_METHOD = "xpos.api.auth.get_session_boot";

/** Key names never stored on the device, at any depth. */
const SECRET_KEY = /csrf|token|secret|password|passwd|api_?key|^sid$|sentry_dsn|^ipinfo$/i;
/** Translations: keys are source texts ("Password"), values are text. Kept whole. */
const TEXT_ONLY_KEYS = new Set(["__messages", "lang_dict"]);

export interface SavedBoot {
	boot: Record<string, unknown>;
	user: string;
	saved_at: string;
}

export class SessionExpiredError extends Error {
	excType = "SessionExpired";
	status: number;
	constructor(status: number) {
		super("Your session has expired. Please sign in again.");
		this.name = "SessionExpiredError";
		this.status = status;
	}
}

export function isSessionExpired(error: unknown): boolean {
	return (
		error instanceof SessionExpiredError ||
		(error as { excType?: string } | null)?.excType === "SessionExpired"
	);
}

function clean(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clean);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY.test(key)) continue;
		out[key] = TEXT_ONLY_KEYS.has(key) ? item : clean(item);
	}
	return out;
}

/** A deep copy of `boot` without the CSRF token or any key that names a secret. */
export function sanitizeBoot(boot: Record<string, unknown>): Record<string, unknown> {
	return clean(JSON.parse(JSON.stringify(boot))) as Record<string, unknown>;
}

/** The boot's user, or "" for none / Guest. */
export function bootUser(boot: Record<string, unknown> | null | undefined): string {
	const user = boot?.user as { name?: string; email?: string } | undefined;
	const name = user?.name || user?.email || "";
	return name && name !== "Guest" ? name : "";
}

async function idb() {
	return import("@/services/idbService");
}

/** Save the sanitized boot for an offline start; a Guest boot is never saved. */
export async function saveOfflineBoot(boot: Record<string, unknown> | null | undefined): Promise<void> {
	if (isElectron() || !boot) return;
	const user = bootUser(boot);
	if (!user) return;
	const saved: SavedBoot = { boot: sanitizeBoot(boot), user, saved_at: new Date().toISOString() };
	const { setMeta } = await idb();
	await setMeta(OFFLINE_BOOT_KEY, saved);
}

export async function loadOfflineBoot(): Promise<SavedBoot | null> {
	const { getMeta } = await idb();
	const saved = (await getMeta(OFFLINE_BOOT_KEY)) as SavedBoot | undefined;
	return saved?.boot && saved.user ? saved : null;
}

export async function clearOfflineBoot(): Promise<void> {
	if (isElectron()) return;
	const { deleteMeta } = await idb();
	await deleteMeta(OFFLINE_BOOT_KEY);
}

/** Started from the static shell (the network could not serve /xpos). */
export function startedFromShell(): boolean {
	return !!(window.xpos as { offlineShell?: boolean } | undefined)?.offlineShell;
}

/**
 * Called first thing at startup. From the shell: put the saved boot in place (no token) and mark
 * the session stale. From the server: save this boot for the next offline start.
 */
export async function initSessionBoot(): Promise<void> {
	if (isElectron()) return;
	// Back from a network drop the session may have ended or its token changed.
	window.addEventListener("offline", markSessionStale);
	if (startedFromShell()) {
		markSessionStale();
		try {
			// The database's own open gives up after DB_OPEN_TIMEOUT_MS (idbService), so this
			// cannot hang the start; no extra, shorter timeout that would drop a slow read.
			const saved = await loadOfflineBoot();
			if (saved) applyBoot(saved.boot);
			else console.warn("[XPOS] Offline start: no boot saved on this device");
		} catch (error) {
			console.warn("[XPOS] Could not read the saved boot for an offline start", error);
		}
		return;
	}
	saveOfflineBoot(window.xpos?.boot).catch((error) =>
		console.warn("[XPOS] Could not save the boot for an offline start", error),
	);
}

function applyBoot(boot: Record<string, unknown>, csrfToken?: string): void {
	window.xpos = window.xpos || ({} as XPosGlobal);
	window.xpos.boot = boot as XPosGlobal["boot"];
	window.xpos._messages = (boot.__messages as Record<string, string>) || window.xpos._messages || {};
	if (csrfToken !== undefined) window.xpos.csrf_token = csrfToken;
}

let stale = false;
let inflight: Promise<void> | null = null;

/** The page may hold an old boot or token: refresh both before the next write. */
export function markSessionStale(): void {
	if (!isElectron()) stale = true;
}

export function sessionIsStale(): boolean {
	return stale;
}

/** For tests. */
export function resetSessionState(): void {
	stale = false;
	inflight = null;
}

/**
 * Before a write: when the session is stale, fetch the server's boot and token and put them in
 * place. Throws Error("__offline__") when the server cannot be reached (the session stays stale)
 * and SessionExpiredError when it answers that nobody is logged in.
 */
export function ensureFreshSession(): Promise<void> {
	if (!stale || isElectron()) return Promise.resolve();
	if (!inflight) {
		inflight = refreshSession().finally(() => {
			inflight = null;
		});
	}
	return inflight;
}

async function refreshSession(): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`${getApiBaseUrlSync()}/api/method/${SESSION_BOOT_METHOD}`, {
			method: "GET",
			headers: { Accept: "application/json" },
			credentials: "same-origin",
			cache: "no-store",
		});
	} catch {
		throw new Error("__offline__");
	}

	const data = (await response.json().catch(() => ({}))) as {
		message?: { boot?: Record<string, unknown>; csrf_token?: string };
		exc_type?: string;
	};
	const expired =
		response.status === 401 ||
		response.status === 403 ||
		data.exc_type === "AuthenticationError" ||
		data.exc_type === "SessionExpired";
	if (expired) {
		window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
		throw new SessionExpiredError(response.status);
	}
	if (!response.ok) {
		// The server or a proxy failed (502/503/504...): try again before the next write.
		throw new Error("__offline__");
	}

	const boot = data.message?.boot;
	const token = data.message?.csrf_token;
	if (!boot || !bootUser(boot) || typeof token !== "string" || !token) {
		window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
		throw new SessionExpiredError(response.status);
	}

	applyBoot(boot, token);
	stale = false;
	saveOfflineBoot(boot).catch((error) =>
		console.warn("[XPOS] Could not save the refreshed boot", error),
	);
}
