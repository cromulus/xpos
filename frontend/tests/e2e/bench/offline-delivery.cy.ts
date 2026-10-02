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
					// Made the way the counter's "Create New Customer" makes one (the cashier
					// may only read customers), with the one address on file that makes the
					// card offer delivery.
					cy.benchCall("xpos.api.customers.create_customer", {
						customer_name: name,
						customer_type: "Individual",
						...(row?.customer_group ? { customer_group: row.customer_group } : {}),
						address_line1: "4410 Old Fairground Rd",
						city: "Dunn",
					}),
				)
				.then((created: { name: string }) => {
					expect(created.name, "the cashier created the customer").to.be.a("string").and.not.be.empty;
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
							customerInvoices(created.name, ["name", "shipping_address_name", "_comments"]).then(
								(posted: Array<{ name: string; shipping_address_name: string; _comments?: string }>) => {
									expect(posted, "one Sales Invoice").to.have.length(1);
									// The review flag: Frappe keeps a sale's latest comments on it (_comments),
									// which the cashier may read (Comment itself they may not list).
									const comments = JSON.parse(posted[0]._comments || "[]") as Array<{ comment: string }>;
									expect(comments.map((c) => c.comment).join(" ")).to.contain("12.5 mi typed there (manual_offline)");
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
								},
							);
						},
					);
				});
		});
	});

	/**
	 * Bill 2026-10-01 (MuleCity-qajl.3, qajl.4): the internet is down and a customer
	 * with three places on file wants a delivery to the back shed, which has no
	 * miles yet. The till cached the addresses when it opened: the picker opens on
	 * their primary shipping address (the yard), Leslie searches "back", picks the
	 * shed, types its miles (priced by the cached policy) and the day. The synced
	 * sale ships to the shed and keeps the day and the typed miles, flagged manual.
	 */
	it("offline, the picker opens on the primary shipping address; a searched address with no miles is priced from typed miles and the sale keeps them", function () {
		cy.benchCall("xpos.api.delivery.get_delivery_policy").then((policy: DeliveryPolicy | null) => {
			if (!policy?.item) this.skip();
			const stamp = Date.now();
			const name = `Offline Picker ${stamp}`;
			const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
			cy.benchCall("frappe.client.get_value", { doctype: "Customer", filters: customer(), fieldname: "customer_group" })
				.then((row: { customer_group?: string } | null) =>
					cy.benchCall("xpos.api.customers.create_customer", {
						customer_name: name,
						customer_type: "Individual",
						...(row?.customer_group ? { customer_group: row.customer_group } : {}),
						address_line1: "4410 Old Fairground Rd",
						city: "Dunn",
					}),
				)
				.then((created: { name: string }) => {
					// The counter's own address calls (Edit Customer): the yard is the primary shipping address.
					cy.benchCall("xpos.api.customers.make_address", { args: JSON.stringify({ customer: created.name,
						address_title: `Yard ${stamp}`, address_line1: "77 Feed Lot Ln", city: "Benson",
						is_primary_address: 1, is_shipping_address: 1 }) });
					cy.benchCall("xpos.api.customers.make_address", { args: JSON.stringify({ customer: created.name,
						address_title: `Shed ${stamp}`, address_line1: "5 Back Rd", city: "Coats" }) });
					cy.benchCall("frappe.client.get_value", { doctype: "Item", filters: item(), fieldname: "weight_per_unit" }).then(
						(weight: { weight_per_unit?: number } | null) => {
							const expected = deliveryCharge(policy!, 12.5, Number(weight?.weight_per_unit) || 0);

							openTillOnline();
							cy.wait(3000);
							cy.networkOff();

							chooseCustomer(name);
							cy.contains(item()).first().click();
							cy.get("[data-testid='add-delivery']:visible").first().click();
							cy.get("[data-testid='delivery-address']").should("have.length", 3);
							cy.get("[data-testid='delivery-address'][data-selected='true']").should("have.length", 1).and("contain", "77 Feed Lot Ln");
							cy.get("[data-testid='delivery-address-miles']").each(($miles) => expect($miles.text().trim()).to.equal("no miles"));
							cy.get("[data-testid='delivery-search']").type("back");
							cy.get("[data-testid='delivery-address']").should("have.length", 1).click();
							cy.get("[data-testid='delivery-miles']").type("12.5");
							cy.get("[data-testid='delivery-address-cost']").should("contain", expected.toFixed(2));
							cy.get("[data-testid='delivery-day']").clear().type(day);
							cy.get("[data-testid='delivery-use']").click();
							cy.cartRows().should("have.length", 2);

							cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
							cy.get("[data-testid='payment-method'][data-mode='Cash']").click();
							payWithEnter();
							cy.get("[role='dialog']").should("not.exist");
							cy.pendingInvoices().should((rows) => expect(rows, "one queued sale").to.have.length(1));

							cy.networkOn();
							waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "the offline sale to sync");
							customerInvoices(created.name, ["name", "shipping_address_name", "pos_delivery_date", "pos_delivery_miles",
								"pos_delivery_miles_source", "_comments"]).then(
								(posted: Array<{ name: string; shipping_address_name: string; pos_delivery_date: string;
									pos_delivery_miles: number; pos_delivery_miles_source: string; _comments?: string }>) => {
									expect(posted, "one Sales Invoice").to.have.length(1);
									const sale = posted[0];
									expect([sale.pos_delivery_date, Number(sale.pos_delivery_miles), sale.pos_delivery_miles_source])
										.to.deep.equal([day, 12.5, "manual"]);
									const comments = JSON.parse(sale._comments || "[]") as Array<{ comment: string }>;
									expect(comments.map((c) => c.comment).join(" ")).to.contain("12.5 mi typed there (manual)");
									cy.benchCall("frappe.client.get_value", { doctype: "Address", filters: sale.shipping_address_name,
										fieldname: "address_line1" }).then((address: { address_line1: string }) =>
										expect(address.address_line1).to.equal("5 Back Rd"));
									cy.benchCall("frappe.client.get", { doctype: "Sales Invoice", name: sale.name }).then(
										(doc: { shipping_address?: string; items: Array<{ item_code: string; rate: number }> }) => {
											expect(doc.shipping_address || "").to.contain("5 Back Rd");
											const lines = doc.items.filter((row) => row.item_code === policy!.item!.item_code);
											expect(lines.map((row) => Number(row.rate))).to.deep.equal([expected]);
										},
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
