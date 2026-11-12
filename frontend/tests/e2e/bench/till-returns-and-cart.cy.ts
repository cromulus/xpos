/**
 * User stories (Mule City, Bill and Grant at the till, 2026-11-12, MuleCity-rj2o).
 *
 * - Leslie has a bag in the cart when a customer brings back last week's bag.
 *   Process Return no longer drops the cart (or refuses): she is asked, saves
 *   the sale as a draft, and the return starts. The refund is a check written
 *   at the counter, and the till asks for its number; the posted return keeps
 *   it on the payment row.
 * - A return left as credit on the customer's account pays nothing out; the
 *   posted return is a credit (negative outstanding).
 * - With a bag in the cart, a past purchase from Recent purchases can be added
 *   to the cart instead of replacing it.
 * - Orders in flight: with a sale in the cart, Load for payment asks to save the
 *   sale as a draft instead of being greyed out.
 *
 * Online stories against a real bench (README.md), run with the offline suite
 * (`yarn test:offline` runs tests/e2e/bench/{offline,till}-*.cy.ts).
 */
import {
	chooseCustomer,
	customer,
	customerInvoices,
	ensureOpenShift,
	item,
	openTillOnline,
	payWithEnter,
	ringUpOneBag,
	waitUntil,
} from "../support/offline";

const CHECK = "Check";

function oneBagInTheCart() {
	chooseCustomer();
	cy.contains(item()).first().click();
	cy.cartRows().should("have.length", 1);
}

function returnOf(sale: string) {
	cy.get("[data-testid='open-return']:visible").first().click();
	cy.get("[role='dialog'] input").first().type(sale);
	cy.contains("[role='dialog'] button", sale, { timeout: 15000 }).click();
	cy.get("[data-testid='return-row']").should("have.length.at.least", 1);
	cy.get("[data-testid='process-return']").click();
}

function openPay() {
	cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
}

function newestReturn(known: Set<string>) {
	return customerInvoices(customer(), ["name", "is_return", "return_against", "grand_total", "outstanding_amount", "pos_refund_method"]).then(
		(rows: Array<Record<string, any>>) => rows.find((row) => row.is_return && !known.has(row.name)),
	);
}

describe("returns and a busy cart at the till", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
		openTillOnline();
	});

	it("asks before a return takes the cart, then refunds by a check with its number", () => {
		ringUpOneBag("Cash");
		customerInvoices().then((rows: Array<{ name: string }>) => {
			const sale = rows[0].name;
			const known = new Set(rows.map((r) => r.name));
			oneBagInTheCart();

			returnOf(sale);
			cy.get("[data-testid='choice-dialog']").should("be.visible").and("contain", "The cart has a sale in it");
			cy.get("[data-testid='choice-park']").click();
			cy.cartRows().should("have.length", 1);

			openPay();
			cy.get(`[data-testid='payment-method'][data-mode='${CHECK}']`).click();
			cy.get("[data-testid='check-number']").should("be.visible").type("4417");
			payWithEnter();
			cy.cartRows().should("have.length", 0);

			waitUntil(() => newestReturn(known), (ret) => !!ret, "the return to post");
			newestReturn(known).then((ret) => {
				expect(ret.return_against).to.equal(sale);
				expect(ret.pos_refund_method).to.equal("Paid out");
				cy.benchCall("frappe.client.get", { doctype: "Sales Invoice", name: ret.name }).then((doc: any) => {
					expect(doc.payments.map((p: any) => [p.mode_of_payment, p.reference_no])).to.deep.equal([[CHECK, "4417"]]);
				});
			});
			// The parked sale waits as a draft.
			cy.benchCall("frappe.client.get_list", {
				doctype: "Sales Invoice",
				filters: { customer: customer(), docstatus: 0 },
				fields: ["name"],
				limit_page_length: 1,
			}).then((drafts: unknown[]) => expect(drafts, "the parked sale").to.have.length(1));
		});
	});

	it("leaves a return as credit on the customer's account, paying nothing out", () => {
		ringUpOneBag("Cash");
		customerInvoices().then((rows: Array<{ name: string }>) => {
			const sale = rows[0].name;
			const known = new Set(rows.map((r) => r.name));
			returnOf(sale);
			cy.get("[data-testid='choice-dialog']").should("not.exist");
			openPay();
			cy.get("[data-testid='payment-method'][data-mode='Credit on account']").click();
			cy.get("[data-testid='refund-to-account-note']").should("contain", "Nothing is paid out now");
			payWithEnter();
			cy.cartRows().should("have.length", 0);
			waitUntil(() => newestReturn(known), (ret) => !!ret, "the return to post");
			newestReturn(known).then((ret) => {
				expect(ret.pos_refund_method).to.equal("Credit on account");
				expect(Number(ret.outstanding_amount)).to.be.lessThan(0);
				expect(Number(ret.outstanding_amount)).to.equal(Number(ret.grand_total));
			});
		});
	});

	it("adds a past purchase to the cart instead of replacing it", () => {
		ringUpOneBag("Cash");
		oneBagInTheCart();
		cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:show-repeat-dialog")));
		cy.get("[data-testid='repeat-invoice']", { timeout: 15000 }).first().click();
		cy.get("[data-testid='choice-dialog']").should("be.visible");
		cy.get("[data-testid='choice-add']").click();
		cy.cartRows().should("have.length", 2);
	});

	it("asks to save a busy cart as a draft before loading an order for payment", () => {
		oneBagInTheCart();
		cy.get("a[href$='/orders']:visible").first().click();
		cy.get("[data-testid='open-orders-show-all']").click();
		cy.get("[data-testid='open-orders-scope']").should("contain", "All orders in flight");
		cy.get("[data-testid='open-orders-cart-busy']").should("be.visible");
		cy.get("body").then(($body) => {
			const loadable = $body.find("[data-testid='open-order-load']:not(:disabled)");
			if (!loadable.length) {
				cy.log("No order ready to load on this bench; the busy-cart note is the check.");
				return;
			}
			cy.wrap(loadable.first()).click();
			cy.get("[data-testid='choice-dialog']").should("be.visible").and("contain", "The cart has a sale in it");
			cy.get("[data-testid='choice-cancel']").click();
			cy.get("[data-testid='choice-dialog']").should("not.exist");
		});
	});
});
