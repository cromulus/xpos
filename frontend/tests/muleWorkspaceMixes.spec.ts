/** Counter stories: Customer Mixes says which of a customer's mixes is current, and shows its recipe. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import MuleWorkspace from "@/components/MuleWorkspace.vue";

// Shaped like mulecity_erpnext.pos_workspace.find_mixes: item_name is the product's own
// (generated) title; display_name and owner_name are what the server prepared for people.
const rows = [
	{ name: "CF-4112-A846", item_name: "ALBERT ADKINS Formula A846D90316", display_name: "CORN, OATS, SOYBEAN MEAL", owner_name: "ALBERT ADKINS", mule_mix_owner_search: "ALBERT ADKINS / 4112", last_used: "2026-05-22", usage_count: 1,
		last_purchase: { invoice: "ACC-SINV-1", date: "2026-05-20", customer_name: "ALBERT ADKINS", currency: "USD", pounds: 500, bags: 10, amount: 162.5 } },
	{ name: "CF-4112-91AB", item_name: "ALBERT ADKINS Formula 91AB163D1E", display_name: "CORN, BARLEY", owner_name: "ALBERT ADKINS", mule_mix_owner_search: "ALBERT ADKINS / 4112", last_used: "2025-11-05", usage_count: 4, last_purchase: null },
	{ name: "CF-4112-NONE", item_name: "ALBERT ADKINS Formula 0000000000", display_name: "Custom mix — recipe not recorded", owner_name: null, mule_mix_owner_search: "", last_used: null, usage_count: 0, last_purchase: null },
];
const recipe = { item: "CF-4112-A846", bom: "BOM-1", quantity: 500, uom: "Pound", ingredients: [{ item_name: "CORN", qty: 400, uom: "Pound" }], available: 0, stock_uom: "Pound", bag_weight: 50 };

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

async function openMixes() {
	HTMLDialogElement.prototype.showModal ??= function () {};
	const request = vi.fn((method: string) => Promise.resolve(method.endsWith("find_mixes") ? { rows, has_more: false } : recipe));
	const wrapper = mount(MuleWorkspace, { props: { customer: "MC-CUST-4112", profile: "Till", request }, attachTo: document.body });
	mounted = wrapper;
	await wrapper.findAll("button").find(b => b.text() === "Customer Mixes")!.trigger("click");
	await flushPromises();
	return { wrapper, request };
}

describe("Customer Mixes", () => {
	// Before: "ALBERT ADKINS Formula A846D90316" / "ALBERT ADKINS / 4112". After: the prepared name and owner.
	it("names each mix by what is in it and whose recipe it is, not by its generated code", async () => {
		await openMixes();
		const titles = [...document.body.querySelectorAll(".mule-results strong")].map(t => t.textContent);
		expect(titles).toEqual(["CORN, OATS, SOYBEAN MEAL", "CORN, BARLEY", "Custom mix — recipe not recorded"]);
		const text = document.body.textContent || "";
		expect(text).toContain("Recipe of ALBERT ADKINS");
		expect(text).not.toContain("Formula A846D90316");
		expect(text).not.toContain("ALBERT ADKINS / 4112");
		expect(text).toContain("Owner not recorded");
	});

	// Before: "Last made 2026-05-22 · made once". The recall index counts orders and sales, not batches.
	it("says when each mix was last ordered and how often", async () => {
		await openMixes();
		const text = document.body.textContent || "";
		expect(text).toContain("Last ordered 2026-05-22 · ordered once");
		expect(text).toContain("Last ordered 2025-11-05 · ordered 4 times");
	});

	it("shows the latest invoiced purchase: date, buyer, quantity and amount", async () => {
		await openMixes();
		expect(document.body.textContent).toContain("Last bought 2026-05-20 by ALBERT ADKINS · 10 bags / 500 lb · ");
		expect(document.body.textContent).toContain("162.50");
	});

	// Negative: order history alone is not manufacture evidence.
	it("never says a mix was made when all it has is order or sales history", async () => {
		await openMixes();
		const text = document.body.textContent || "";
		expect(text).not.toContain("Last made");
		expect(text).not.toMatch(/\bmade\b/);
	});

	it("says so when a mix has no orders or sales on record", async () => {
		await openMixes();
		expect(document.body.textContent).toContain("No orders or sales recorded");
	});

	it("scrolls the recipe into view when View recipe is pressed", async () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		await openMixes();
		const view = [...document.body.querySelectorAll("button")].find(b => b.textContent === "View recipe")!;
		view.click();
		await flushPromises();
		expect(document.body.querySelector(".mule-recipe")?.textContent).toContain("CORN");
		expect(scroll).toHaveBeenCalled();
	});
});

describe("The register's shared login only sells (Bill, 2026-09-29, MuleCity-fb00)", () => {
	it("offers no desk shortcuts: no new order, account payment, prepare order, formula editor or library", async () => {
		Element.prototype.scrollIntoView = vi.fn();
		const { request } = await openMixes();
		[...document.body.querySelectorAll("button")].find(b => b.textContent === "View recipe")!.click();
		await flushPromises();
		const text = document.body.textContent || "";
		expect(text).toContain("CORN");
		for (const gone of ["New order", "Account payment", "Prepare order", "Edit in formula editor", "Full formula library"]) {
			expect(text).not.toContain(gone);
		}
		expect(document.querySelectorAll('a[href^="/desk/sales-order/new"], a[href^="/desk/payment-entry"]').length).toBe(0);
		expect(request.mock.calls.map(c => c[0])).not.toContain("mulecity_erpnext.pos_workspace.create_mix_order");
	});
});
