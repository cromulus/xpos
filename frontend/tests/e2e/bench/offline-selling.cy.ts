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
 * Change (MuleCity-ztb9): the customer hands Leslie a $50 bill for one bag
 * while the internet is down. The till queues the sale with the change it
 * owes, and when the internet returns the Sales Invoice posts showing the $50
 * paid and the change handed back. Before the fix the server refused every
 * such sale ("POS Change Leg Row #1: Value missing for: Currency") and it sat
 * in "need attention", never posted.
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
	ringUpOneBagTendering,
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
				// To the cent: the queue keeps the cart's float (11.069999999999999), the
				// server posts 11.07.
				const cents = (amount: unknown) => Math.round(Number(amount) * 100);
				const charged = rows.map((r) => cents(r.grand_total)).sort();

				cy.networkOn();
				waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "both offline sales to sync");
				customerInvoices().then((after: Array<{ name: string; grand_total: number }>) => {
					const posted = after.filter((i) => !known.has(i.name));
					expect(posted, "two new Sales Invoices").to.have.length(2);
					expect(posted.map((i) => cents(i.grand_total)).sort()).to.deep.equal(charged);
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

	it("a customer pays $50 cash offline for one bag, and the synced invoice shows the $50 paid and the change", () => {
		const TENDERED = 50;
		const cents = (amount: unknown) => Math.round(Number(amount) * 100);
		customerInvoices().then((before: Array<{ name: string }>) => {
			const known = new Set(before.map((i) => i.name));
			openTillOnline();
			cy.wait(3000);
			cy.networkOff();

			ringUpOneBagTendering("Cash", TENDERED);

			cy.pendingInvoices().then((rows) => {
				expect(rows, "one queued sale").to.have.length(1);
				const [sale] = rows;
				const total = cents(sale.grand_total);
				const change = cents(TENDERED) - total;
				expect(change, "the $50 covers the bag with change to give").to.be.greaterThan(0);
				// What the server needs for the change: a Cash row in the till's currency.
				const legs = sale.data.pos_change_legs as Array<Record<string, unknown>>;
				expect(legs, "one change row").to.have.length(1);
				expect(legs[0].mode_of_payment).to.equal("Cash");
				expect(legs[0].currency, "the change row's currency").to.be.a("string").and.not.be.empty;
				expect(cents(legs[0].amount)).to.equal(change);

				cy.networkOn();
				waitUntil(
					() => cy.pendingInvoices(),
					(pending) => {
						// A refused sale never syncs: fail now, with the server's reason.
						const refused = pending.find((r) => r.status === "dead_letter");
						if (refused) throw new Error(`the offline sale was refused: ${refused.error}`);
						return pending.length === 0;
					},
					"the offline sale with change to sync",
				);
				customerInvoices(undefined, ["name", "grand_total", "paid_amount", "change_amount"]).then(
					(after: Array<{ name: string; grand_total: number; paid_amount: number; change_amount: number }>) => {
						const posted = after.filter((i) => !known.has(i.name));
						expect(posted, "one new Sales Invoice").to.have.length(1);
						expect(cents(posted[0].grand_total)).to.equal(total);
						expect(cents(posted[0].paid_amount), "the $50 paid").to.equal(cents(TENDERED));
						expect(cents(posted[0].change_amount), "the change handed back").to.equal(change);
						cy.benchCall("frappe.client.get", { doctype: "Sales Invoice", name: posted[0].name }).then(
							(invoice: { pos_change_legs: Array<{ mode_of_payment: string; currency: string; amount: number }> }) => {
								expect(invoice.pos_change_legs, "the change row posted").to.have.length(1);
								expect(invoice.pos_change_legs[0].mode_of_payment).to.equal("Cash");
								expect(invoice.pos_change_legs[0].currency).to.equal(legs[0].currency);
								expect(cents(invoice.pos_change_legs[0].amount)).to.equal(change);
							},
						);
					},
				);
			});
		});
	});
});

export {};
