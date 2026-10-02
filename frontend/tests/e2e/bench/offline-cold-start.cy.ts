/**
 * User story (Mule City, MuleCity-q8aq, mc29 staging walk 2026-10-02): the counter PC is switched
 * on with the store's internet down, and Leslie opens her X POS bookmark, /xpos (what Desk links
 * to; Frappe redirects /xpos/ there) or /xpos/.
 *
 * The browser ran X POS online once (fresh: no service worker, caches or offline data before).
 * Then the internet drops and the till is opened as a new page: a fresh document, nothing carried
 * over in memory (Cypress has one tab; this is what a new tab gets).
 *
 * - With a shift open on this till, it opens from the app shell as the saved user, she rings up a
 *   bag, it queues, and when the internet returns the till fetches a fresh boot and CSRF token
 *   before anything is sent, and the sale posts with that token.
 * - With no shift open, it says it is offline and that a shift needs the internet, instead of
 *   "Sign in" or "No profiles found". (The no-shift till is the server answering check_open_shift
 *   with no shift at the online start, stubbed so the bench's shared shift stays open.)
 *
 * Before mc30, /xpos and /xpos/ failed with "No internet": the worker's scope was /xpos/, and
 * Frappe's /xpos/ redirects to /xpos, outside it.
 *
 * Runs against a real bench (tests/e2e/bench/README.md).
 */
import {
	customerInvoices,
	ensureOpenShift,
	freshBrowser,
	interceptServer,
	internetBackAndSynced,
	internetDown,
	item,
	restoreNetworkAfterEach,
	ringUpOneBag,
	savedBoot,
	till,
} from "../support/offline";

const ENTRIES = ["/xpos", "/xpos/"];

/** First run of X POS in this browser, online, at `entry`; waits for the worker and the warm-up. */
function firstRunOnline(entry: string) {
	freshBrowser();
	cy.visit(entry);
	cy.window().then((win) => win.navigator.serviceWorker.ready).its("active").should("not.equal", null);
	cy.window().then((win) => win.navigator.serviceWorker.getRegistrations()).should((registrations) => {
		expect(registrations.map((r) => new URL(r.scope).pathname), "one worker, scope /xpos").to.deep.equal(["/xpos"]);
	});
}

/** The boot is saved for an offline start as soon as the till is up, without a token. */
function bootSaved() {
	savedBoot().then((saved) => {
		expect(saved?.user, "a boot is saved").to.be.a("string");
		expect(JSON.stringify(saved)).not.to.match(/csrf/i);
	});
}

/** Open the till as a new page (a fresh document, not a reload) while offline. */
function coldStart(entry: string) {
	cy.window().then((win) => win.location.assign(entry));
	cy.window().its("xpos.offlineShell", { timeout: 30000 }).should("equal", true);
	cy.window().should((win) => {
		expect(till(win).csrf_token, "no token in an offline-started page").to.equal(undefined);
		expect(till(win).boot?.user?.name, "the boot saved at the online start").to.be.a("string");
	});
	cy.location("pathname").should("not.equal", "/xpos/login");
}

describe("starting the till while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});

	restoreNetworkAfterEach();

	for (const entry of ENTRIES) {
		it(`opens ${entry} offline with a shift open, sells, and syncs with a fresh CSRF token`, () => {
			const server = interceptServer();
			customerInvoices().then((before: Array<{ name: string }>) => {
				const known = new Set(before.map((i) => i.name));

				firstRunOnline(entry);
				cy.contains(item(), { timeout: 30000 }).should("exist");
				bootSaved();
				cy.wait(3000); // warm-up: items, customers, prices and taxes reach the browser

				internetDown(server);
				coldStart(entry);
				cy.contains(item(), { timeout: 30000 }).should("exist");

				ringUpOneBag("Cash");
				cy.pendingInvoices().should((rows) => {
					expect(rows.map((r) => r.status)).to.deep.equal(["pending"]);
				});

				internetBackAndSynced(server);
				customerInvoices().then((after: Array<{ name: string }>) => {
					expect(after.filter((i) => !known.has(i.name)), "the offline sale posted").to.have.length(1);
				});
			});
		});

		it(`opens ${entry} offline with no shift open and says a shift needs the internet`, () => {
			const server = interceptServer();
			// This till has no open shift (the server's answer when none is open: no message).
			cy.intercept("POST", "/api/method/xpos.api.shifts.check_open_shift", { body: {} });

			firstRunOnline(entry);
			cy.contains("Open your shift", { timeout: 30000 }).should("be.visible");
			bootSaved();

			internetDown(server);
			coldStart(entry);
			cy.get("[data-testid='opening-offline']", { timeout: 30000 })
				.should("be.visible")
				.and("contain", "You are offline")
				.and("contain", "a shift can only be opened with the internet on");
			cy.contains("No profiles found").should("not.exist");
			cy.contains("Sign in").should("not.exist");
		});
	}
});
