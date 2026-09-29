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

import {
	customerInvoices,
	ensureOpenShift,
	item,
	openTillOnline,
	restoreNetworkAfterEach,
	ringUpOneBag,
	secondMode,
	waitUntil,
} from "../support/offline";

describe("selling while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});

	// The network cut is the browser's, not the page's: always put it back, or a
	// failed story leaves the next one offline before it can even load.
	restoreNetworkAfterEach();

	it("sells two tickets offline, prints the offline receipts, and both post when the internet returns", () => {
		customerInvoices().then((before: Array<{ name: string }>) => {
			const known = new Set(before.map((i) => i.name));
			openTillOnline();
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
			openTillOnline();
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

export {};
