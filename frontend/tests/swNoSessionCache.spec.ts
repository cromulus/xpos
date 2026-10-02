/**
 * MuleCity-68mo: no entry the till's service worker caches may hold a body with the session's CSRF
 * token or boot. Checked here on the BUILT precache manifest (every URL resolved as the worker
 * fetches it, against /xpos/sw.js) and on the runtime routes' URL rules; the bench story
 * tests/e2e/bench/offline-no-session-cache.cy.ts reads the real caches back after a logged-in run.
 *
 * Frappe answers /xpos and every /xpos/<anything> with the till page, which carries the boot and
 * the token (xpos/www/xpos.py), and /app, /api/... are session pages too. mc31's precache held bare
 * icon names that resolved to /xpos/<name>: the logged-in page, cached three times.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { precacheEntries } from "../scripts/checkAssetNames.mjs";
import {
	API_NEVER_CACHED,
	ASSET_PREFIX,
	isAsset,
	isCacheableApiGet,
	isPublicFile,
	isTillNavigation,
	OFFLINE_SHELL_PATTERN,
} from "../sw/policy";

const ORIGIN = "https://bench.example";
const SW_URL = `${ORIGIN}/xpos/sw.js`;
const BUILD = resolve(__dirname, "../../xpos/public/xpos");

/** Where the worker fetches a precache entry from (workbox: new Request(url), relative to the worker). */
const fetched = (url: string) => new URL(url, SW_URL);

/** Paths Frappe answers with a page or API response that can carry the session. */
const SESSION_PAGE = /^\/(xpos(\/|$)|app(\/|$)|api\/|login|desk|me(\/|$))/;

/** A precached URL is safe when it is a static build file: under /assets/xpos/xpos/, never a page. */
function precacheProblems(urls: string[]): string[] {
	const problems: string[] = [];
	for (const url of urls) {
		const { pathname, origin } = fetched(url);
		if (origin !== ORIGIN) problems.push(`${url}: another origin`);
		if (SESSION_PAGE.test(pathname)) problems.push(`${url}: fetched as ${pathname}, a Frappe page that carries the session`);
		else if (!pathname.startsWith(ASSET_PREFIX)) problems.push(`${url}: fetched as ${pathname}, outside ${ASSET_PREFIX}`);
	}
	return problems;
}

const SESSION_BODY = [/csrf_token\s*=\s*["'][0-9a-f]{8,}/, /xpos\.boot\s*=\s*\{/, /\{\{\s*(boot|csrf_token)/];

describe("mc31's precache (the bad case)", () => {
	const urls = JSON.parse(readFileSync(resolve(__dirname, "fixtures/assetNames/mc31/precache.json"), "utf8")).map(
		(entry: { url: string }) => entry.url,
	);

	it("is caught fetching the till page as icons and as the manifest", () => {
		const problems = precacheProblems(urls);
		for (const path of ["/xpos/pwa-192x192.svg", "/xpos/pwa-512x512.svg", "/xpos/apple-touch-icon.svg", "/xpos/manifest.webmanifest"]) {
			expect(problems.some((p) => p.includes(`fetched as ${path}, a Frappe page`)), path).toBe(true);
		}
	});
});

const built = existsSync(resolve(BUILD, "sw.js"));
if (!built) console.warn(`[swNoSessionCache.spec] no build in ${BUILD}: run \`yarn build\``);

describe.skipIf(!built)("the built precache", () => {
	const entries = built ? precacheEntries(readFileSync(resolve(BUILD, "sw.js"), "utf8")) : [];

	it("fetches every entry from a static build file under /assets/xpos/xpos/, never a Frappe page", () => {
		expect(entries.length).toBeGreaterThan(10);
		expect(precacheProblems(entries.map((entry) => entry.url))).toEqual([]);
	});

	it("precaches exactly one HTML file, the content-named shell, and never index.html", () => {
		const html = entries.filter((entry) => /\.html$/.test(entry.url));
		expect(html).toHaveLength(1);
		expect(html[0].url).toMatch(OFFLINE_SHELL_PATTERN);
	});

	it("has no body with a CSRF token, the boot, or a template placeholder for them", () => {
		for (const entry of entries) {
			const file = resolve(BUILD, fetched(entry.url).pathname.slice(ASSET_PREFIX.length));
			expect(existsSync(file), `${entry.url} is a file in the build`).toBe(true);
			const body = readFileSync(file, "utf8");
			for (const pattern of SESSION_BODY) expect(body, `${entry.url} ${pattern}`).not.toMatch(pattern);
		}
	});
});

describe("the runtime caches", () => {
	const SESSION_URLS = [
		"/xpos",
		"/xpos/",
		"/xpos/pos",
		"/xpos/pwa-192x192.svg",
		"/xpos/manifest.webmanifest",
		"/xpos/sw.js",
		"/app",
		"/app/pos-invoice",
		"/login",
		...API_NEVER_CACHED.map((name) => `/api/method/${name}`),
		"/api/method/xpos.api.pos.get_pos_data",
		"/api/resource/User/pos@mulecity.com",
		"/private/files/scan.pdf",
	];

	it("cache none of the pages or API answers that carry the session", () => {
		for (const path of SESSION_URLS) {
			const url = new URL(path, ORIGIN);
			const cached = isCacheableApiGet(url, "GET") || isAsset(url) || isPublicFile(url);
			expect(cached, path).toBe(false);
		}
	});

	it("let the navigation route pass pages through without caching them", () => {
		// The till's own pages go to the network; offline the worker answers with the precached shell.
		expect(isTillNavigation("/xpos")).toBe(true);
		const sw = readFileSync(resolve(__dirname, "../sw/sw.ts"), "utf8");
		const navigation = sw.slice(sw.indexOf("new NavigationRoute"), sw.indexOf("{ allowlist: NAVIGATION_ALLOWLIST }"));
		expect(navigation).toContain("return await fetch(request);");
		expect(navigation).not.toMatch(/cache\.put|caches\.open|NetworkFirst|StaleWhileRevalidate|CacheFirst/);
	});

	it("cache only static paths: /assets/ and public /files/", () => {
		expect(isAsset(new URL("/assets/xpos/xpos/assets/index-sDFGewAf.js", ORIGIN))).toBe(true);
		expect(isPublicFile(new URL("/files/logo.png", ORIGIN))).toBe(true);
		expect(isAsset(new URL("/xpos/assets/x.js", ORIGIN))).toBe(false);
	});
});
