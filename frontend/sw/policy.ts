/**
 * What the X POS service worker (sw/sw.ts) may serve and cache. Kept apart from the worker so the
 * rules are unit-tested (tests/offlineServiceWorker.spec.ts) and the build checks what it ships.
 *
 * MuleCity-q8aq: the till must start and reload with the network down, and nothing that carries a
 * session (the server-rendered /xpos page with its boot and CSRF token, or an API answer about the
 * session) may sit in a cache on a shared counter PC.
 */

/** Where Frappe serves the build (`yarn build --base=/assets/xpos/xpos/`). */
export const ASSET_PREFIX = "/assets/xpos/xpos/";

/**
 * The static app shell: the built index.html with no boot and no CSRF token (scripts/
 * offlineShell.ts), named after its content, offline-shell-<hash>.html. Precached; served only
 * for an /xpos navigation the network could not answer.
 *
 * Content-named because Frappe serves /assets with max-age one year and Cloudflare keeps it:
 * workbox precaches from the plain URL (its revision is only in the cache key), so mc30's fixed
 * name offline-shell.html came back from Cloudflare as mc29's shell, which ran mc29's code offline
 * (MuleCity-q8aq, mc30 staging walk). A new build has a new name, which no cache has seen.
 */
export const OFFLINE_SHELL_PREFIX = "offline-shell-";
export const OFFLINE_SHELL_PATTERN = /\/offline-shell-[0-9a-f]{12}\.html$/;
/** The glob the build precaches the shell by. */
export const OFFLINE_SHELL_GLOB = "offline-shell-*.html";

export function offlineShellFile(hash: string): string {
	return `${OFFLINE_SHELL_PREFIX}${hash}.html`;
}

/** The shell's URL in a precache manifest, or undefined. */
export function offlineShellUrl(manifest: ReadonlyArray<string | { url: string }>): string | undefined {
	return manifest.map((entry) => (typeof entry === "string" ? entry : entry.url)).find((url) => OFFLINE_SHELL_PATTERN.test(url));
}

/** The till's own pages (/xpos, /xpos/, /xpos/orders, ...): never Desk or any other route. */
export const NAVIGATION_ALLOWLIST: RegExp[] = [/^\/xpos(?:\/.*)?$/];

/**
 * GET /api/method/<name> answers the worker may keep (NetworkFirst, 24 h): none.
 *
 * Every read the till makes goes through services/api.ts as a POST, which a service worker cannot
 * cache; offline, the till reads its own IndexedDB copies (items, customers, prices, taxes, POS
 * data). The only GETs under /api/method/ are xpos.api.auth.get_csrf_token and
 * xpos.api.auth.get_session_boot, which return the session's CSRF token and boot: exactly what
 * must never be cached. A method added here must be a GET whose answer holds no token, session
 * or per-user secret, and the till must actually call it by GET.
 */
export const API_GET_CACHE_ALLOWLIST: readonly string[] = [];

/** Never cached, whatever the allowlist says: they answer with the session's token or boot. */
export const API_NEVER_CACHED: readonly string[] = [
	"xpos.api.auth.get_csrf_token",
	"xpos.api.auth.get_session_boot",
	"frappe.auth.get_logged_user",
	"frappe.sessions.get",
];

/** Caches earlier builds declared (the HTML one held boot + CSRF); removed on activate. */
export const RETIRED_CACHES: readonly string[] = ["xpos-html-cache", "xpos-api-cache"];

export const API_CACHE = "xpos-api-get-cache";
export const ASSETS_CACHE = "xpos-assets-cache";
export const FILES_CACHE = "xpos-files-cache";

export function isTillNavigation(pathname: string): boolean {
	return NAVIGATION_ALLOWLIST.some((pattern) => pattern.test(pathname));
}

/** The method name of a same-origin /api/method/ URL, or null. */
export function apiMethodOf(url: URL): string | null {
	const match = /^\/api\/method\/([^/?#]+)$/.exec(url.pathname);
	return match ? decodeURIComponent(match[1]) : null;
}

export function isCacheableApiGet(url: URL, method: string): boolean {
	if (method !== "GET") return false;
	const name = apiMethodOf(url);
	return !!name && !API_NEVER_CACHED.includes(name) && API_GET_CACHE_ALLOWLIST.includes(name);
}

/** Public build and app assets (not /private/...). */
export function isAsset(url: URL): boolean {
	return url.pathname.startsWith("/assets/");
}

/** Public files only: /private/files/ are permission-checked per user and stay out of the cache. */
export function isPublicFile(url: URL): boolean {
	return url.pathname.startsWith("/files/");
}
