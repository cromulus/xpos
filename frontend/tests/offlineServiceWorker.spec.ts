/**
 * The till's service worker and app shell (MuleCity-q8aq): /xpos navigations go to the network and
 * fall back to the static shell only when the network cannot be reached; no HTML is cached; GET
 * API answers are cached only from an allowlist (empty) that can never hold the session's token or
 * boot; assets and public files are cached, private files are not. The last block checks the built
 * sw.js and offline-shell-<hash>.html when a build is present (`yarn build`; erp2's offline suite builds
 * first).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	API_GET_CACHE_ALLOWLIST,
	OFFLINE_SHELL_PATTERN,
	isCacheableApiGet,
	isPublicFile,
	isTillNavigation,
} from "../sw/policy";
import { toOfflineShell } from "../scripts/offlineShell";

const { routes, matchPrecache } = vi.hoisted(() => ({
	routes: [] as Array<{ match: unknown; handler: any; method?: string }>,
	matchPrecache: vi.fn(),
}));

vi.mock("workbox-precaching", () => ({
	precacheAndRoute: vi.fn(),
	cleanupOutdatedCaches: vi.fn(),
	matchPrecache,
}));
vi.mock("workbox-routing", () => ({
	NavigationRoute: class {
		constructor(
			public handler: (options: { request: Request }) => Promise<Response>,
			public options: { allowlist: RegExp[] },
		) {}
	},
	registerRoute: (match: unknown, handler?: unknown, method?: string) => routes.push({ match, handler, method }),
}));
vi.mock("workbox-strategies", () => ({
	NetworkFirst: class {
		constructor(public options: { cacheName: string }) {}
	},
	CacheFirst: class {
		constructor(public options: { cacheName: string }) {}
	},
}));
vi.mock("workbox-expiration", () => ({ ExpirationPlugin: class {} }));
vi.mock("workbox-cacheable-response", () => ({ CacheableResponsePlugin: class {} }));

const ORIGIN = "https://erp.mulecity.com";
const SHELL_URL = "/assets/xpos/xpos/offline-shell-0123456789ab.html";
const url = (path: string) => new URL(path, ORIGIN);

describe("what the worker may serve and cache", () => {
	it("serves the shell for the till's own pages only, never Desk or other routes", () => {
		for (const path of ["/xpos", "/xpos/", "/xpos/pos", "/xpos/orders", "/xpos/orders/SO-1"]) {
			expect(isTillNavigation(path), path).toBe(true);
		}
		for (const path of ["/app", "/app/sales-invoice", "/login", "/xposx", "/", "/printview"]) {
			expect(isTillNavigation(path), path).toBe(false);
		}
	});

	it("caches no GET API answer: the allowlist is empty, and the session's token and boot are never cached", () => {
		expect(API_GET_CACHE_ALLOWLIST).toEqual([]);
		for (const method of [
			"xpos.api.auth.get_csrf_token",
			"xpos.api.auth.get_session_boot",
			"frappe.auth.get_logged_user",
			"frappe.ping",
			"xpos.api.items.get_items",
		]) {
			expect(isCacheableApiGet(url(`/api/method/${method}`), "GET"), method).toBe(false);
		}
	});

	it("caches public files, not private ones", () => {
		expect(isPublicFile(url("/files/logo.png"))).toBe(true);
		expect(isPublicFile(url("/private/files/id-scan.pdf"))).toBe(false);
	});
});

describe("the worker (sw/sw.ts)", () => {
	let navigation: { handler: (o: { request: Request }) => Promise<Response>; options: { allowlist: RegExp[] } };
	const shell = new Response("<html>shell</html>", { status: 200 });

	beforeAll(async () => {
		(self as any).__WB_MANIFEST = [
			{ url: "/assets/xpos/xpos/assets/index-abc.js", revision: null },
			{ url: SHELL_URL, revision: null },
		];
		await import("../sw/sw");
		navigation = routes[0].match as typeof navigation;
	});

	it("registers the navigation route first and every cache route after it", () => {
		expect(navigation.options.allowlist.map(String)).toEqual([String(/^\/xpos(?:\/.*)?$/)]);
		const names = routes.slice(1).map((r) => r.handler.options.cacheName);
		expect(names).toEqual(["xpos-api-get-cache", "xpos-assets-cache", "xpos-files-cache"]);
		expect(names).not.toContain("xpos-html-cache");
	});

	it("online, answers a till navigation from the network, never the shell", async () => {
		const page = new Response("<html>server</html>", { status: 200 });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(page));
		matchPrecache.mockReset().mockResolvedValue(shell);

		expect(await navigation.handler({ request: new Request(`${ORIGIN}/xpos/orders`) })).toBe(page);
		expect(matchPrecache).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("passes a server error through rather than hiding it behind the shell", async () => {
		const unavailable = new Response("busy", { status: 503 });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable));
		matchPrecache.mockReset().mockResolvedValue(shell);

		expect(await navigation.handler({ request: new Request(`${ORIGIN}/xpos/`) })).toBe(unavailable);
		expect(matchPrecache).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("offline, answers with the precached shell", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		matchPrecache.mockReset().mockResolvedValue(shell);

		expect(await navigation.handler({ request: new Request(`${ORIGIN}/xpos/pos`) })).toBe(shell);
		expect(matchPrecache).toHaveBeenCalledWith(SHELL_URL);
		vi.unstubAllGlobals();
	});

	it("matches only same-origin requests, and no private files or session API answers", () => {
		const [api, assets, files] = routes.slice(1).map((r) => r.match as (o: any) => boolean);
		const req = (method = "GET") => ({ method });
		expect(api({ url: url("/api/method/xpos.api.auth.get_csrf_token"), request: req(), sameOrigin: true })).toBe(false);
		expect(assets({ url: url("/assets/xpos/xpos/assets/index.js"), sameOrigin: true })).toBe(true);
		expect(assets({ url: new URL("https://cdn.example/assets/x.js"), sameOrigin: false })).toBe(false);
		expect(files({ url: url("/files/logo.png"), sameOrigin: true })).toBe(true);
		expect(files({ url: url("/private/files/scan.pdf"), sameOrigin: true })).toBe(false);
	});
});

describe("the app shell", () => {
	const template = readFileSync(resolve(__dirname, "../index.html"), "utf8");

	it("is the page without the boot, the token or any template placeholder", () => {
		const html = toOfflineShell(template);
		expect(html).toContain("window.xpos = { offlineShell: true };");
		expect(html).not.toMatch(/\{\{|\{%|csrf|window\.xpos\.boot\s*=/i);
		expect(html).toContain('<html lang="en" dir="ltr">');
		expect(html).toContain("<title>X POS</title>");
	});

	it("fails the build when the page's boot script changes shape", () => {
		expect(() => toOfflineShell(template.replace("window.xpos.boot =", "window.xpos.bootInfo ="))).toThrow(
			/boot script was not found/,
		);
		expect(() => toOfflineShell(template.replace("<title>", "<title>{{ csrf_token }}"))).toThrow(/left in the shell/);
	});
});

const BUILD = resolve(__dirname, "../../xpos/public/xpos");
const shellFile = existsSync(BUILD) ? readdirSync(BUILD).find((name) => /^offline-shell-[0-9a-f]{12}\.html$/.test(name)) : undefined;
const built = existsSync(resolve(BUILD, "sw.js")) && !!shellFile;
if (!built) console.warn(`[offlineServiceWorker.spec] no build in ${BUILD}: run \`yarn build\` to check sw.js`);

describe.skipIf(!built)("the built sw.js and offline shell", () => {
	const sw = built ? readFileSync(resolve(BUILD, "sw.js"), "utf8") : "";
	const shellHtml = built ? readFileSync(resolve(BUILD, shellFile!), "utf8") : "";
	const precached = [...sw.matchAll(/["']?url["']?\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

	it("names the shell after its content, so no CDN or browser cache can hand back an older one", () => {
		// mc30 precached a fixed offline-shell.html; Cloudflare (Frappe's /assets max-age is a year)
		// returned mc29's shell, and the till started offline on mc29's code.
		expect(existsSync(resolve(BUILD, "offline-shell.html")), "no fixed-name shell").toBe(false);
		const hash = createHash("sha256").update(shellHtml).digest("hex").slice(0, 12);
		expect(shellFile).toBe(`offline-shell-${hash}.html`);
		expect(precached.filter((u) => OFFLINE_SHELL_PATTERN.test(u))).toEqual([`/assets/xpos/xpos/${shellFile}`]);
	});

	it("precaches the shell and never index.html", () => {
		// (workbox's own code still names createHandlerBoundToURL; the worker no longer binds a route to it)
		expect(precached.filter((u) => /index\.html$/.test(u))).toEqual([]);
	});

	it("has the navigation route for /xpos only", () => {
		expect(sw).toContain(String(/^\/xpos(?:\/.*)?$/));
	});

	it("has no HTML cache: the old cache name appears only in the list of caches it deletes", () => {
		expect(sw.match(/xpos-html-cache/g)).toHaveLength(1);
		expect(sw).toMatch(/\[\s*["'`]xpos-html-cache["'`]\s*,\s*["'`]xpos-api-cache["'`]\s*\]/);
		expect(sw).not.toContain(String(/^https?:\/\/[^/]+\/xpos\/?$/));
	});

	it("has the empty API allowlist and the never-cached session methods", () => {
		expect(sw).not.toContain(String(/^https?:\/\/.*\/api\/method\//));
		expect(sw).toContain("xpos.api.auth.get_session_boot");
		expect(sw).toContain("xpos.api.auth.get_csrf_token");
		for (const name of ["xpos-api-get-cache", "xpos-assets-cache", "xpos-files-cache"]) expect(sw).toContain(name);
	});

	it("declares the app at /xpos, the worker's scope (Frappe redirects /xpos/ there)", () => {
		const manifest = JSON.parse(readFileSync(resolve(BUILD, "manifest.webmanifest"), "utf8"));
		expect(manifest.scope).toBe("/xpos");
		expect(manifest.start_url).toBe("/xpos");
	});

	it("ships a shell with no boot, no token and no placeholder", () => {
		expect(shellHtml).toContain("offlineShell: true");
		expect(shellHtml).not.toMatch(/\{\{|\{%|csrf/i);
	});
});
