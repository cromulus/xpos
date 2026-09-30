/**
 * User story (Mule City, Bill 2026-09-29, MuleCity-6nb1): the internet is down
 * and a customer wants a bag delivered to a new place.
 *
 * Leslie presses "Add delivery" on the customer card, types the new street, town
 * and the one-way driving miles, and the till prices the delivery itself from
 * the policy it cached (the same arithmetic as the site). On reconnect the
 * server makes the Address (miles flagged "manual_offline" until Google looks it
 * up), ships the Sales Invoice there, keeps the delivery line's amount, and
 * flags the sale with a Comment for review.
 *
 * Runs against a real bench whose site quotes delivery (the Mule app's
 * xpos_delivery_* hooks); on a site without them the story is skipped.
 */
import { deliveryCharge, type DeliveryPolicy } from "../../../src/services/delivery";
import {
	chooseCustomer,
	customer,
	customerInvoices,
	ensureOpenShift,
	item,
	openTillOnline,
	payWithEnter,
	restoreNetworkAfterEach,
	waitUntil,
} from "../support/offline";

describe("delivery while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});
	restoreNetworkAfterEach();

	it("prices a delivery to an address typed offline, and the synced sale ships there, flagged, at that price", function () {
		cy.benchCall("xpos.api.delivery.get_delivery_policy").then((policy: DeliveryPolicy | null) => {
			if (!policy?.item) this.skip();
			const name = `Offline Delivery ${Date.now()}`;
			const street = `${Date.now() % 10000} New Ground Rd`;
			cy.benchCall("frappe.client.get_value", { doctype: "Customer", filters: customer(), fieldname: "customer_group" })
				.then((row: { customer_group?: string } | null) =>
					// In the bench customer's group, so the till's customer sync includes them.
					cy.benchCall("frappe.client.insert", {
						doc: {
							doctype: "Customer",
							customer_name: name,
							customer_type: "Individual",
							...(row?.customer_group ? { customer_group: row.customer_group } : {}),
						},
					}),
				)
				.then((created: { name: string }) => {
					// One address on file, so the card offers delivery.
					cy.benchCall("xpos.api.customers.make_address", {
						args: JSON.stringify({ customer: created.name, address_line1: "4410 Old Fairground Rd", city: "Dunn" }),
					});
					cy.benchCall("frappe.client.get_value", { doctype: "Item", filters: item(), fieldname: "weight_per_unit" }).then(
						(weight: { weight_per_unit?: number } | null) => {
							const expected = deliveryCharge(policy!, 12.5, Number(weight?.weight_per_unit) || 0);

							openTillOnline();
							cy.wait(3000);
							cy.networkOff();

							chooseCustomer(name);
							cy.contains(item()).first().click();
							cy.get("[data-testid='add-delivery']:visible").first().click();
							cy.get("[data-testid='delivery-new-address'] input[placeholder='Street address']").type(street);
							cy.get("[data-testid='delivery-new-address'] input[placeholder='City']").type("Coats");
							cy.get("[data-testid='delivery-new-address'] input[placeholder='Miles one way']").type("12.5");
							cy.get("[data-testid='delivery-new-address-use']").click();
							cy.cartRows().should("have.length", 2);

							cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
							cy.get("[data-testid='payment-method'][data-mode='Cash']").click();
							payWithEnter();
							cy.get("[role='dialog']").should("not.exist");
							cy.pendingInvoices().should((rows) => expect(rows, "one queued sale").to.have.length(1));

							cy.networkOn();
							waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "the offline sale to sync");
							customerInvoices(created.name, ["name", "shipping_address_name"]).then(
								(posted: Array<{ name: string; shipping_address_name: string }>) => {
									expect(posted, "one Sales Invoice").to.have.length(1);
									cy.benchCall("frappe.client.get", { doctype: "Sales Invoice", name: posted[0].name }).then(
										(sale: { items: Array<{ item_code: string; rate: number; description: string }> }) => {
											const lines = sale.items.filter((row) => row.item_code === policy!.item!.item_code);
											expect(lines, "one delivery line").to.have.length(1);
											expect(Number(lines[0].rate)).to.equal(expected);
											expect(lines[0].description).to.contain("12.5 mi").and.to.contain("miles typed offline");
										},
									);
									cy.benchCall("frappe.client.get_value", {
										doctype: "Address",
										filters: posted[0].shipping_address_name,
										fieldname: "address_line1",
									}).then((address: { address_line1: string }) => expect(address.address_line1).to.equal(street));
									// The sale's comments as its form shows them (the cashier may read the sale, not list Comments).
									cy.benchCall("frappe.desk.form.load.get_comments", {
										doctype: "Sales Invoice",
										name: posted[0].name,
									}).then((comments: Array<{ content: string }>) =>
										expect(comments.map((c) => c.content).join(" ")).to.contain("12.5 mi typed there (manual_offline)"),
									);
								},
							);
						},
					);
				});
		});
	});
});

export {};
