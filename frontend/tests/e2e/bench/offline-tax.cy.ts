/**
 * User story (Mule City, Bill 2026-09-29, MuleCity-ispl): the internet is down and
 * a farm customer this till has never rung up walks in.
 *
 * Before the fix the till only knew the taxes of customers it had looked up
 * online, so it said "Tax lookup failed" and Leslie could not take payment.
 * Now the offline sync keeps every tax category's taxes and each customer's
 * category, so Leslie rings the farm customer up offline, untaxed, and the
 * Sales Invoice the server makes on reconnect is untaxed too.
 *
 * The farm customer is seeded server-side by an administrator before the till
 * opens (the erp2 slot's offline_fixtures.py: "Offline Test Farm", exempt by
 * reason Farm); the counter cashier may only read customers. openTillOnline
 * starts from an empty offline store, so this till never quoted their tax
 * online. Runs against a real bench (README.md), never the stub.
 * Settings: XPOS_BENCH_FARM_CUSTOMER (default "Offline Test Farm"),
 * XPOS_BENCH_EXEMPT_CATEGORY (default "Mule City Exempt").
 */
import {
	customerInvoices,
	ensureOpenShift,
	openTillOnline,
	restoreNetworkAfterEach,
	ringUpOneBag,
	waitUntil,
} from "../support/offline";

const exemptCategory = () => (Cypress.env("exemptCategory") as string) || "Mule City Exempt";
const farmCustomer = () => (Cypress.env("farmCustomer") as string) || "Offline Test Farm";

describe("taxes while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});
	restoreNetworkAfterEach();

	it("rings up a farm customer this till never saw online, untaxed, and the synced invoice is untaxed", () => {
		cy.benchCall("frappe.client.get_value", {
			doctype: "Customer",
			filters: { customer_name: farmCustomer() },
			fieldname: ["name", "tax_category"],
		}).then((farm: { name?: string; tax_category?: string } | null) => {
			expect(farm?.name, `the seeded farm customer ${farmCustomer()}`).to.be.a("string");
			expect(farm!.tax_category, "seeded exempt").to.equal(exemptCategory());
			// A bench that is not restored between runs keeps earlier runs' sales.
			customerInvoices(farm!.name!, ["name"]).then((before: Array<{ name: string }>) => {
				// Warm-up while online: customers (with their category) and every category's taxes.
				openTillOnline();
				cy.wait(3000);
				cy.networkOff();

				ringUpOneBag("Cash", farmCustomer());
				cy.pendingInvoices().should((rows) => expect(rows, "one queued sale").to.have.length(1));
				cy.contains(/Tax lookup failed|No tax information/).should("not.exist");

				cy.networkOn();
				waitUntil(
					() => cy.pendingInvoices(),
					(rows) => rows.length === 0,
					"the offline sale to sync",
				);
				customerInvoices(farm!.name!, ["name", "tax_category", "total_taxes_and_charges"]).then(
					(posted: Array<{ tax_category: string; total_taxes_and_charges: number }>) => {
						expect(posted, "one new Sales Invoice").to.have.length(before.length + 1);
						expect(posted[0].tax_category).to.equal(exemptCategory());
						expect(Number(posted[0].total_taxes_and_charges)).to.equal(0);
					},
				);
			});
		});
	});
});

export {};
