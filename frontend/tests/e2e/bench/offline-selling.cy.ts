/**
 * User story (Mule City, Bill 2026-09-29): the store's internet drops and the
 * counter keeps selling in the browser.
 *
 * Leslie opens XPOS while online (it caches items, customers and prices), the
 * internet goes down, and she rings up two tickets. Each prints XPOS's offline
 * receipt on the PC's printer. When the internet comes back, both reach the
 * server as Sales Invoices with the totals she charged.
 *
 * Negative: a sale the server refuses when it arrives (over the POS Profile's
 * discount cap) is not retried; it waits in the "need attention" list for a
 * manager, and no invoice is made. The screen stops such a discount as it is
 * typed, so the story queues that sale directly, as a till with an older
 * build could have.
 *
 * Runs against a real bench (tests/e2e/bench/README.md), never the stub.
 */

const item = () => Cypress.env("item") as string;
const customer = () => Cypress.env("customer") as string;
const secondMode = () => (Cypress.env("secondMode") as string) || "Cash";

/** The test customer's submitted Sales Invoices, newest first. */
function customerInvoices() {
	return cy.benchCall("frappe.client.get_list", {
		doctype: "Sales Invoice",
		filters: { customer: customer(), docstatus: 1 },
		fields: ["name", "grand_total"],
		order_by: "creation desc",
		limit_page_length: 50,
	});
}

/** Retry `read` until `ok(result)` or about a minute passes (sync runs on reconnect). */
function waitUntil<T>(read: () => Cypress.Chainable<T>, ok: (value: T) => boolean, message: string, tries = 60) {
	read().then((value) => {
		if (ok(value)) return;
		if (tries <= 0) throw new Error(`Timed out waiting: ${message}`);
		cy.wait(1000);
		waitUntil(read, ok, message, tries - 1);
	});
}

/** An open till for the bench user, as Leslie opens it in the morning. */
function ensureOpenShift() {
	cy.benchCall("xpos.api.shifts.check_open_shift").then((open) => {
		if (open) return;
		cy.benchCall("xpos.api.shifts.open_shift", {
			pos_profile: Cypress.env("profile"),
			company: Cypress.env("company"),
			balance_details: JSON.stringify([{ mode_of_payment: "Cash", amount: 100 }]),
		});
	});
}

function openXposOnline() {
	cy.visit("/xpos/", {
		onBeforeLoad(win) {
			// Start from an empty offline cache, so the story proves the warm-up.
			win.indexedDB.deleteDatabase("xpos_offline_v3");
		},
	});
	cy.contains(item(), { timeout: 30000 }).should("exist");
}

function chooseCustomer() {
	// The cart's customer button ("Click to change customer"); skip if the
	// customer is already the cart's (a new ticket starts on the profile's default).
	cy.contains("button", "Click to change customer").then(($button) => {
		if ($button.text().includes(customer())) return;
		cy.wrap($button).click();
		cy.get("[role='dialog'] input").first().type(customer());
		cy.contains("[role='dialog'] *", customer(), { timeout: 15000 }).first().click();
		cy.get("[role='dialog']").should("not.exist");
	});
}

/** One bag, paid in full with `mode`, Save & Print. Returns the till's total. */
function ringUpOneBag(mode: string) {
	chooseCustomer();
	cy.contains(item()).first().click();
	cy.cartRows().should("have.length", 1);
	cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
	cy.get(`[data-testid='payment-method'][data-mode='${mode}']`).click();
	// Selecting the tender fills the remaining amount; Enter is Save & Print.
	cy.get("[role='dialog']").type("{enter}");
	cy.get("[role='dialog']").should("not.exist");
	cy.cartRows().should("have.length", 0);
}

Cypress.Commands.add("cartRows", () => cy.get("[data-cart-index]:visible"));

describe("selling while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});

	// The network cut is the browser's, not the page's: always put it back, or a
	// failed story leaves the next one offline before it can even load.
	afterEach(() => {
		cy.wrap(null).then(() =>
			Cypress.automation("remote:debugger:protocol", {
				command: "Network.emulateNetworkConditions",
				params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
			}),
		);
	});

	it("sells two tickets offline, prints the offline receipts, and both post when the internet returns", () => {
		customerInvoices().then((before: Array<{ name: string }>) => {
			const known = new Set(before.map((i) => i.name));
			openXposOnline();
			// Warm-up: the item and customer lists reach the browser before the drop.
			cy.wait(3000);

			cy.capturePrints();
			cy.networkOff();

			ringUpOneBag("Cash");
			ringUpOneBag(secondMode());

			cy.pendingInvoices().should((rows) => {
				expect(rows.map((r) => r.status)).to.deep.equal(["pending", "pending"]);
			});
			cy.printedPages().should((pages) => {
				expect(pages, "two offline receipts").to.have.length(2);
				pages.forEach((page) => expect(page).to.contain(item()));
			});
			cy.pendingInvoices().then((rows) => {
				const charged = rows.map((r) => Number(r.grand_total)).sort();

				cy.networkOn();
				waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "both offline sales to sync");
				customerInvoices().then((after: Array<{ name: string; grand_total: number }>) => {
					const posted = after.filter((i) => !known.has(i.name));
					expect(posted, "two new Sales Invoices").to.have.length(2);
					expect(posted.map((i) => Number(i.grand_total)).sort()).to.deep.equal(charged);
				});
			});
		});
	});

	it("an offline sale over the discount cap is refused when it syncs and waits for a manager", () => {
		customerInvoices().then((before: Array<{ name: string }>) => {
			const known = new Set(before.map((i) => i.name));
			openXposOnline();
			cy.wait(3000);
			cy.networkOff();
			ringUpOneBag("Cash");

			// The queued sale, re-queued at 30% off: over Mule City's 25% cap.
			cy.pendingInvoices().then(([sale]) => {
				const data = structuredClone(sale.data);
				for (const line of data.items) {
					line.discount_percentage = 30;
					line.rate = Math.round(line.price_list_rate * 70) / 100;
				}
				const total = data.items.reduce((sum: number, l: any) => sum + l.rate * l.qty, 0);
				data.payments = [{ ...data.payments[0], amount: total }];
				const { id: _id, ...queued } = sale;
				cy.queueInvoice({ ...queued, data, local_id: `${sale.local_id}-over-cap`, grand_total: total });
			});

			cy.networkOn();
			waitUntil(
				() => cy.pendingInvoices(),
				(rows) => rows.length === 1 && rows[0].status === "dead_letter",
				"the good sale to sync and the refused one to wait",
			);
			cy.pendingInvoices().then(([refused]) => {
				// XPOS's own line cap or the fork's ticket cap, whichever sees it first.
				expect(refused.error).to.match(/at most 25|maximum allowed 25/);
			});
			cy.contains(/need attention/i).should("be.visible");
			customerInvoices().then((after: Array<{ name: string }>) => {
				expect(after.filter((i) => !known.has(i.name)), "only the good sale posted").to.have.length(1);
			});
		});
	});
});

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Cypress {
		interface Chainable {
			cartRows(): Chainable<JQuery<HTMLElement>>;
		}
	}
}

export {};
