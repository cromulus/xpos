/**
 * Security story (MuleCity-68mo, staging audit of mc31 2026-10-02): a counter PC is shared, so no
 * cache the till's service worker fills may hold the session: not the CSRF token, not the boot.
 *
 * On mc31 the precache held the logged-in till page three times, under /xpos/pwa-192x192.svg,
 * /xpos/pwa-512x512.svg and /xpos/apple-touch-icon.svg: bare icon names in the precache resolved
 * against /xpos/sw.js, and Frappe answers any /xpos/<path> with the till page.
 *
 * Here the till runs online once on a real bench as the logged-in user (fresh browser), the worker
 * installs and fills its precache, the till warms up and loads its assets (runtime caches). Then
 * every entry of every cache is read back: each URL must be under /assets/ or /files/ (never a
 * Frappe page such as /xpos/<anything>, /app or /api), and no body may contain the page's CSRF
 * token, a csrf_token assignment or the boot.
 */
import { ensureOpenShift, freshBrowser, till } from "../support/offline";

type Entry = { cache: string; url: string; body: string };

describe("the till's caches never hold the session", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});

	it("caches only /assets and /files URLs, and no cached body carries the CSRF token or the boot", () => {
		freshBrowser();
		cy.visit("/xpos");
		cy.window().its("xpos.boot.user.name", { timeout: 30000 }).should("be.a", "string");
		cy.window().then((win) => win.navigator.serviceWorker.ready).its("active.state", { timeout: 30000 }).should("eq", "activated");
		// The precache is complete once the worker is activated; give the warm-up time to load
		// lazily imported chunks (runtime asset cache), then reload once so the worker controls the page.
		cy.wait(3000);
		cy.reload();
		cy.window().its("xpos.boot.user.name", { timeout: 30000 }).should("be.a", "string");
		cy.wait(3000);

		cy.window().then(async (win) => {
			const token = String(till(win).csrf_token || "");
			expect(token, "the page has a CSRF token to look for").to.have.length.greaterThan(8);

			const entries: Entry[] = [];
			for (const name of await win.caches.keys()) {
				const cache = await win.caches.open(name);
				for (const request of await cache.keys()) {
					const response = await cache.match(request);
					entries.push({ cache: name, url: request.url, body: response ? await response.text() : "" });
				}
			}

			const precache = entries.filter((entry) => entry.cache.startsWith("workbox-precache"));
			expect(precache.length, "the worker precached the build").to.be.greaterThan(10);
			expect(
				precache.filter((entry) => /\/offline-shell-[0-9a-f]{12}\.html/.test(entry.url)),
				"the content-named shell is precached",
			).to.have.length(1);

			for (const entry of entries) {
				const { pathname } = new URL(entry.url);
				expect(pathname, `${entry.cache}: ${entry.url} is a static file`).to.match(/^\/(assets|files)\//);
				expect(entry.body.includes(token), `${entry.cache}: ${entry.url} holds the CSRF token`).to.equal(false);
				expect(entry.body, `${entry.cache}: ${entry.url} sets a CSRF token`).not.to.match(/csrf_token\s*=\s*["'][0-9a-f]{8,}/);
				expect(entry.body, `${entry.cache}: ${entry.url} carries the boot`).not.to.match(/xpos\.boot\s*=\s*\{/);
			}
		});
	});
});
