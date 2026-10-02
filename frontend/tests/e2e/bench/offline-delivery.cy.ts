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

/** The add-address form (Bill 2026-10-01 22:52): street, city, state (NC by default), ZIP, miles. */
function typeNewAddress(fields: { line1: string; city: string; zip: string; miles?: string }) {
	cy.get("[data-testid='delivery-new-line1']").type(fields.line1);
	cy.get("[data-testid='delivery-new-city']").type(fields.city);
	cy.get("[data-testid='delivery-new-state']").should("have.value", "NC");
	cy.get("[data-testid='delivery-new-zip']").type(fields.zip);
	if (fields.miles) cy.get("[data-testid='delivery-new-miles']").type(fields.miles);
}

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
							// Their one address has no miles, so the picker opens on it; Leslie adds the new place.
							cy.get("[data-testid='delivery-add-address']").click();
							typeNewAddress({ line1: street, city: "Coats", zip: "27521", miles: "12.5" });
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

	/**
	 * Bill 2026-10-01 22:52 (MuleCity-qajl): a named customer with no address on
	 * file still gets a delivery. The internet is down; Leslie presses "Add
	 * delivery", which opens the add-address form straight away, types the farm
	 * and its miles, and sells. On reconnect the till first makes the Address on
	 * the site (a Shipping address of the customer, miles typed offline), then
	 * posts the sale shipped there: one Address, never two.
	 */
	it("offline, a customer with no address adds one at the till, sells with delivery, and the address syncs before the sale", function () {
		cy.benchCall("xpos.api.delivery.get_delivery_policy").then((policy: DeliveryPolicy | null) => {
			if (!policy?.item) this.skip();
			const stamp = Date.now();
			const name = `Offline No Address ${stamp}`;
			const street = `${stamp % 10000} Long Branch Rd`;
			cy.benchCall("frappe.client.get_value", { doctype: "Customer", filters: customer(), fieldname: "customer_group" })
				.then((row: { customer_group?: string } | null) =>
					cy.benchCall("xpos.api.customers.create_customer", {
						customer_name: name,
						customer_type: "Individual",
						...(row?.customer_group ? { customer_group: row.customer_group } : {}),
					}),
				)
				.then((created: { name: string }) => {
					cy.benchCall("frappe.client.get_value", { doctype: "Item", filters: item(), fieldname: "weight_per_unit" }).then(
						(weight: { weight_per_unit?: number } | null) => {
							const expected = deliveryCharge(policy!, 12.5, Number(weight?.weight_per_unit) || 0);

							openTillOnline();
							cy.wait(3000);
							cy.networkOff();

							chooseCustomer(name);
							cy.contains(item()).first().click();
							cy.get("[data-testid='add-delivery']:visible").first().click();
							cy.get("[data-testid='delivery-address']").should("not.exist");
							typeNewAddress({ line1: street, city: "Dunn", zip: "28334", miles: "12.5" });
							cy.get("[data-testid='delivery-new-address-use']").click();
							cy.cartRows().should("have.length", 2);

							cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
							cy.get("[data-testid='payment-method'][data-mode='Cash']").click();
							payWithEnter();
							cy.get("[role='dialog']").should("not.exist");
							cy.pendingInvoices().should((rows) => expect(rows, "one queued sale").to.have.length(1));

							cy.networkOn();
							waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "the offline sale to sync");
							customerInvoices(created.name, ["name", "shipping_address_name", "pos_delivery_miles", "pos_delivery_miles_source"]).then(
								(posted: Array<{ name: string; shipping_address_name: string; pos_delivery_miles: number;
									pos_delivery_miles_source: string }>) => {
									expect(posted, "one Sales Invoice").to.have.length(1);
									const sale = posted[0];
									expect([Number(sale.pos_delivery_miles), sale.pos_delivery_miles_source]).to.deep.equal([12.5, "manual"]);
									cy.benchCall("frappe.client.get", { doctype: "Address", name: sale.shipping_address_name }).then(
										(address: { address_line1: string; city: string; state: string; pincode: string; address_type: string;
											mule_delivery_miles?: number; mule_delivery_miles_source?: string;
											links: Array<{ link_doctype: string; link_name: string }> }) => {
											expect([address.address_line1, address.city, address.state, address.pincode, address.address_type])
												.to.deep.equal([street, "Dunn", "NC", "28334", "Shipping"]);
											expect(address.links.map((link) => [link.link_doctype, link.link_name]))
												.to.deep.equal([["Customer", created.name]]);
											// The clerk's miles, flagged as typed offline (Google replaces them when it can).
											expect(address.mule_delivery_miles_source).to.be.oneOf(["manual_offline", "routes"]);
											if (address.mule_delivery_miles_source === "manual_offline")
												expect(Number(address.mule_delivery_miles)).to.equal(12.5);
										},
									);
									cy.benchCall("frappe.client.get_list", { doctype: "Address", fields: ["name"],
										filters: { address_line1: street } }).then((rows: Array<{ name: string }>) =>
										expect(rows, "one Address, made once").to.have.length(1));
									cy.benchCall("frappe.client.get", { doctype: "Sales Invoice", name: sale.name }).then(
										(doc: { items: Array<{ item_code: string; rate: number }> }) => {
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

	/** Bill 2026-10-01 22:52: no delivery for the walk-in account, online or offline. */
	it("the walk-in customer is never offered Add delivery, online or offline", function () {
		cy.benchCall("xpos.api.delivery.get_delivery_policy").then((policy: DeliveryPolicy | null) => {
			if (!policy?.item) this.skip();
			cy.benchCall("frappe.client.get_value", { doctype: "POS Profile", filters: Cypress.env("profile"), fieldname: "customer" }).then(
				(profile: { customer?: string } | null) => {
					if (!profile?.customer) this.skip();
					expect(policy!.walk_in_customers || [], "the till caches the walk-ins with the policy").to.include(profile!.customer);
					openTillOnline();
					chooseCustomer(profile!.customer);
					cy.contains(item()).first().click();
					cy.cartRows().should("have.length", 1);
					cy.get("[data-testid='add-delivery']").should("not.exist");
					cy.networkOff();
					cy.wait(500);
					cy.get("[data-testid='add-delivery']").should("not.exist");
				},
			);
		});
	});
});

export {};
