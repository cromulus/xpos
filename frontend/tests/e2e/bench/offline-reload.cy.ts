/**
 * User story (Mule City, MuleCity-q8aq): the store's internet is down and Leslie presses F5 on the
 * till, or the counter PC is switched on before the internet is back. Before this, the browser
 * showed "No internet" (ERR_INTERNET_DISCONNECTED): the service worker crashed while starting up
 * and served nothing offline.
 *
 * Leslie opens XPOS online (the service worker installs, the till caches items, customers, prices
 * and taxes, and the page saves its boot without the CSRF token). The server goes out of reach for
 * the browser, page and service worker alike. She reloads: the till opens from the app shell, with
 * no CSRF token anywhere. She opens the Orders page (a cold start of another route), comes back and
 * rings up a bag; it queues. When the internet returns, the till first fetches a fresh boot and
 * CSRF token from the server, and the queued sale posts with that token.
 *
 * Online, the service worker never serves the shell: a reload gets the server's page with its own
 * boot and token.
 *
 * Runs against a real bench (tests/e2e/bench/README.md). Chrome treats the bench origin as secure
 * (cypress.bench.config.ts), so the page has its service worker as on https.
 */
import {
	customerInvoices,
	ensureOpenShift,
	interceptServer,
	internetBackAndSynced,
	internetDown,
	item,
	openTillOnline,
	restoreNetworkAfterEach,
	ringUpOneBag,
	savedBoot,
	till,
} from "../support/offline";

/** The page came from the server (fresh boot + token), not from the shell. */
function expectServerPage() {
	cy.window().should((win) => {
		expect(win.navigator.serviceWorker.controller, "the service worker controls the page").to.not.equal(null);
		expect(till(win).offlineShell, "not the offline shell").to.not.equal(true);
		expect(till(win).csrf_token, "the server's token").to.be.a("string").and.not.equal("");
		expect(till(win).boot?.user?.name, "the server's boot").to.be.a("string");
	});
}

describe("reloading and starting the till while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});

	restoreNetworkAfterEach();

	it("reloads offline from the app shell, sells, and syncs with a fresh CSRF token when the internet returns", () => {
		const server = interceptServer();

		customerInvoices().then((before: Array<{ name: string }>) => {
			const known = new Set(before.map((i) => i.name));

			openTillOnline();
			cy.window().then((win) => win.navigator.serviceWorker.ready).its("active").should("not.equal", null);
			cy.wait(3000); // warm-up: items, customers, prices and taxes reach the browser

			// Online, a reload is the server's page, through the worker.
			cy.reload();
			cy.contains(item(), { timeout: 30000 }).should("exist");
			expectServerPage();
			cy.window().its("xpos.csrf_token").then((pageToken: string) => {
				// The boot saved for an offline start holds no token.
				savedBoot().then((saved) => {
					expect(saved?.user, "a boot is saved").to.be.a("string");
					const text = JSON.stringify(saved);
					expect(text).not.to.contain(pageToken);
					expect(text).not.to.match(/csrf/i);
				});
			});

			// The internet drops, then Leslie presses F5.
			internetDown(server);
			cy.reload();
			cy.window().its("xpos.offlineShell", { timeout: 30000 }).should("equal", true);
			cy.contains(item(), { timeout: 30000 }).should("exist");
			cy.window().should((win) => {
				expect(till(win).csrf_token, "no token in an offline-started page").to.equal(undefined);
				expect(till(win).boot?.user?.name, "the saved boot").to.be.a("string");
				expect(JSON.stringify(till(win).boot)).not.to.match(/csrf/i);
			});

			// A cold start of another till page, then back to the till.
			cy.window().then((win) => win.location.assign("/xpos/orders"));
			cy.location("pathname", { timeout: 30000 }).should("equal", "/xpos/orders");
			cy.window().its("xpos.offlineShell", { timeout: 30000 }).should("equal", true);
			cy.window().then((win) => win.location.assign("/xpos/"));
			cy.contains(item(), { timeout: 30000 }).should("exist");
			cy.window().its("xpos.offlineShell").should("equal", true);

			ringUpOneBag("Cash");
			cy.pendingInvoices().should((rows) => {
				expect(rows.map((r) => r.status)).to.deep.equal(["pending"]);
			});

			// The internet returns: a fresh boot and token first, then the sale, with that token.
			internetBackAndSynced(server);
			customerInvoices().then((after: Array<{ name: string }>) => {
				expect(after.filter((i) => !known.has(i.name)), "the offline sale posted").to.have.length(1);
			});

			// Back online, a reload is the server's page again, never the shell.
			cy.reload();
			cy.contains(item(), { timeout: 30000 }).should("exist");
			expectServerPage();
		});
	});
});
