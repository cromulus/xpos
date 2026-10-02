/**
 * User story (Mule City, Bill 2026-09-30/10-01, MuleCity-zstm.23, mxwy.10): the
 * store's internet goes down and Leslie presses "Orders" to see what is waiting
 * for pickup.
 *
 * Online, the top-bar Orders view opens on Sales Orders in flight (every one,
 * nobody chosen) and the till keeps that list. Offline it shows the same list,
 * marked "last known" with its time, and loading an order for payment waits for
 * the internet. It never says "No orders in flight" from the offline side: an
 * empty last-known list says "None in the last known list (as of ...)".
 *
 * The bench may or may not have orders in flight (the VFD fixture's pickup
 * order usually is): the story compares the offline list with the online one,
 * whatever it holds. Runs against a real bench (README.md), never the stub.
 */
import { ensureOpenShift, openTillOnline, restoreNetworkAfterEach } from "../support/offline";

const ordersLink = () => cy.get("a[href$='/orders']:visible").first();
const tillLink = () => cy.get("a[href$='/pos']:visible").first();

describe("orders in flight while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});
	restoreNetworkAfterEach();

	it("shows the last known list with its time, never 'no orders', and cannot load one for payment", () => {
		openTillOnline();
		ordersLink().click();
		cy.get("[data-testid='open-orders-scope']", { timeout: 20000 }).should("contain", "All orders in flight");
		cy.get("[data-testid='open-orders-last-known']").should("not.exist");
		cy.get("[data-testid='open-orders-unknown']").should("not.exist");
		// Online: either orders or the honest empty answer, never an error.
		cy.get("[data-testid='open-order'], [data-testid='open-orders-empty']", { timeout: 20000 }).should("exist");
		cy.get("[data-testid='open-orders'] [role='alert']").should("not.exist");
		cy.get("body").then(($body) => {
			const online = [...$body.find("[data-testid='open-order']")].map((row) => row.textContent?.trim() ?? "");

			cy.networkOff();
			tillLink().click();
			ordersLink().click();
			cy.get("[data-testid='open-orders-last-known']", { timeout: 20000 })
				.should("contain", "last known")
				.and("contain", "as of");
			cy.get("[data-testid='open-orders-unknown']").should("not.exist");
			cy.contains("No orders in flight").should("not.exist");
			if (online.length) {
				cy.get("[data-testid='open-order']").should("have.length", online.length);
				cy.get("[data-testid='open-order-load']").each(($button) => cy.wrap($button).should("be.disabled"));
				// Searching works on the kept list.
				const first = online[0].split(/\s+/)[0];
				cy.get("[data-testid='open-orders-search']").type(first + "{enter}");
				cy.get("[data-testid='open-order']").should("have.length.at.least", 1);
			} else {
				cy.get("[data-testid='open-orders-empty']").should("contain", "None in the last known list");
			}

			cy.networkOn();
			cy.get("[data-testid='open-orders-last-known']", { timeout: 20000 }).should("not.exist");
		});
	});
});
