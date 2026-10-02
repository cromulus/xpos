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
 * Two things from the mc30 staging walk (real Chromium, new tab) are reproduced here:
 * - Cloudflare keeps /assets for a year, and handed the worker an older build's shell for the
 *   fixed URL offline-shell.html, so the till started offline on old code. Every story here runs
 *   behind such a cache: the fixed URL answers with a shell from "an earlier build".
 * - The browser offline while its service worker still reaches the server (Chromium's offline
 *   switch for a page does not cover its worker): the worker returns the server's page, whose
 *   calls then fail. It must carry on as the till, not drop to the login.
 *
 * MuleCity-yn4b (mc31 staging, pos@, 2026-10-02): started offline in a new tab, the till had no
 * customer and its search did not find "Walk-In Customer" (the profile syncs only its sale group;
 * the walk-in sits outside it), so the test sale went to a named customer. A walk-in cash sale
 * must work offline: the cold start is on the profile's walk-in, "walk" finds it, the sale queues
 * and posts to it on reconnect, and it is never offered a delivery.
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
	payWithEnter,
	restoreNetworkAfterEach,
	ringUpOneBag,
	savedBoot,
	till,
} from "../support/offline";

const ENTRIES = ["/xpos", "/xpos/"];

/** What a year-long CDN cache hands back for the fixed shell URL: an earlier build's shell. */
const STALE_SHELL =
	"<!doctype html><html><body><script>window.xpos = { offlineShell: true, staleShell: true };</script>" +
	"<p>X POS shell from an earlier build</p></body></html>";

/** First run of X POS in this browser, online, at `entry`; waits for the worker and the warm-up. */
function firstRunOnline(entry: string) {
	freshBrowser();
	cy.intercept({ method: "GET", pathname: "/assets/xpos/xpos/offline-shell.html" }, {
		body: STALE_SHELL,
		headers: { "content-type": "text/html", "cache-control": "max-age=31536000", "cf-cache-status": "HIT" },
	});
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

/**
 * Open the till as a new page (a fresh document, not a reload) while offline. `shell`: whether
 * the worker had to answer from its precached shell (server out of reach) or passed the server's
 * page through (browser offline, worker still reaching the server).
 */
function coldStart(entry: string, shell = true) {
	cy.window().then((win) => win.location.assign(entry));
	cy.window().its("xpos.boot.user.name", { timeout: 30000 }).should("be.a", "string");
	cy.window().should((win) => {
		const globals = till(win) as ReturnType<typeof till> & { staleShell?: boolean };
		expect(globals.staleShell, "not an earlier build's shell").to.equal(undefined);
		if (shell) {
			expect(globals.offlineShell, "started from the app shell").to.equal(true);
			expect(globals.csrf_token, "no token in an offline-started page").to.equal(undefined);
		}
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

		it(`opens ${entry} offline on the walk-in customer, finds it by "walk", and its cash sale syncs to it`, function () {
			cy.benchCall("frappe.client.get_value", {
				doctype: "POS Profile",
				filters: Cypress.env("profile"),
				fieldname: "customer",
			}).then((profile: { customer?: string } | null) => {
				if (!profile?.customer) this.skip();
				const walkIn = profile!.customer!;
				cy.benchCall("frappe.client.get_value", { doctype: "Customer", filters: walkIn, fieldname: "customer_name" }).then(
					(row: { customer_name?: string } | null) => {
						const shown = row?.customer_name || walkIn;
						const server = interceptServer();
						customerInvoices(walkIn).then((before: Array<{ name: string }>) => {
							const known = new Set(before.map((i) => i.name));

							firstRunOnline(entry);
							cy.contains(item(), { timeout: 30000 }).should("exist");
							cy.wait(3000); // warm-up: the customer cache must carry the walk-in

							internetDown(server);
							coldStart(entry);
							cy.contains(item(), { timeout: 30000 }).should("exist");
							cy.get("[data-testid='cart-customer']:visible", { timeout: 15000 })
								.first()
								.should("contain", shown);

							// The offline search finds it by "walk"; picking it keeps it.
							cy.get("[data-testid='cart-customer']:visible").first().click();
							cy.get("[role='dialog'] input").first().type("walk");
							cy.contains("[role='dialog'] *", shown, { timeout: 15000 }).first().click();
							cy.get("[role='dialog']").should("not.exist");
							cy.get("[data-testid='cart-customer']:visible").first().should("contain", shown);

							cy.contains(item()).first().click();
							cy.cartRows().should("have.length", 1);
							cy.get("[data-testid='add-delivery']").should("not.exist"); // mc23: no delivery for walk-ins
							cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
							cy.get("[data-testid='payment-method'][data-mode='Cash']").click();
							payWithEnter();
							cy.get("[role='dialog']").should("not.exist");
							cy.cartRows().should("have.length", 0);
							cy.pendingInvoices().should((rows) => {
								expect(rows.map((r) => r.status)).to.deep.equal(["pending"]);
							});
							// The next ticket starts on the walk-in again.
							cy.get("[data-testid='cart-customer']:visible").first().should("contain", shown);

							internetBackAndSynced(server);
							customerInvoices(walkIn).then((after: Array<{ name: string }>) => {
								expect(after.filter((i) => !known.has(i.name)), "the walk-in sale posted to the walk-in").to.have.length(1);
							});
						});
					},
				);
			});
		});

		it(`opens ${entry} as the till when the browser is offline but its worker still reaches the server`, () => {
			const server = interceptServer();
			customerInvoices().then((before: Array<{ name: string }>) => {
				const known = new Set(before.map((i) => i.name));

				firstRunOnline(entry);
				cy.contains(item(), { timeout: 30000 }).should("exist");
				cy.wait(3000);

				// The page's network only: the worker's fetch of the page still succeeds.
				cy.networkOff();
				coldStart(entry, false);
				cy.contains(item(), { timeout: 30000 }).should("exist");
				cy.contains("Sign in").should("not.exist");

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
