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
 * The customer is made fresh for the story, so no browser can have looked
 * them up online. Runs against a real bench (README.md), never the stub.
 * Settings: XPOS_BENCH_EXEMPT_CATEGORY (default "Mule City Exempt").
 */
import {
	customer,
	customerInvoices,
	ensureOpenShift,
	openTillOnline,
	restoreNetworkAfterEach,
	ringUpOneBag,
	waitUntil,
} from "../support/offline";

const exemptCategory = () => (Cypress.env("exemptCategory") as string) || "Mule City Exempt";
// A site may require why a customer is exempt (Mule City: the reason sets the
// category), named by the Customer field it lives in.
const exemptFields = (): Record<string, string> => {
	const field = Cypress.env("exemptReasonField") as string;
	const reason = Cypress.env("exemptReason") as string;
	return field && reason ? { [field]: reason } : {};
};

describe("taxes while the store's internet is down", () => {
	beforeEach(() => {
		cy.benchLogin();
		ensureOpenShift();
	});
	restoreNetworkAfterEach();

	it("rings up a farm customer this till never saw online, untaxed, and the synced invoice is untaxed", () => {
		const name = `Offline Farm ${Date.now()}`;
		// In the bench customer's group, so the till's customer sync (which keeps
		// the profile's customer groups) includes them.
		cy.benchCall("frappe.client.get_value", {
			doctype: "Customer",
			filters: customer(),
			fieldname: "customer_group",
		}).then((row: { customer_group?: string } | null) => {
			cy.benchCall("frappe.client.insert", {
				doc: {
					doctype: "Customer",
					customer_name: name,
					customer_type: "Individual",
					...(row?.customer_group ? { customer_group: row.customer_group } : {}),
					tax_category: exemptCategory(),
					...exemptFields(),
				},
			}).then((created: { name: string }) => {
				// Warm-up while online: customers (with their category) and every category's taxes.
				openTillOnline();
				cy.wait(3000);
				cy.networkOff();

				ringUpOneBag("Cash", name);
				cy.pendingInvoices().should((rows) => expect(rows, "one queued sale").to.have.length(1));
				cy.contains(/Tax lookup failed|No tax information/).should("not.exist");

				cy.networkOn();
				waitUntil(
					() => cy.pendingInvoices(),
					(rows) => rows.length === 0,
					"the offline sale to sync",
				);
				customerInvoices(created.name, ["name", "tax_category", "total_taxes_and_charges"]).then(
					(posted: Array<{ tax_category: string; total_taxes_and_charges: number }>) => {
						expect(posted, "one Sales Invoice").to.have.length(1);
						expect(posted[0].tax_category).to.equal(exemptCategory());
						expect(Number(posted[0].total_taxes_and_charges)).to.equal(0);
					},
				);
			});
		});
	});
});

export {};
