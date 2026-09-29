/** Counter stories: Customer Mixes says which of a customer's mixes is current, and shows its recipe. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import MuleWorkspace from "@/components/MuleWorkspace.vue";

const rows = [
	{ name: "CF-4112-A846", item_name: "ALBERT ADKINS Formula A846D90316", mule_mix_owner_search: "ALBERT ADKINS / 4112", last_used: "2026-05-22", usage_count: 1 },
	{ name: "CF-4112-91AB", item_name: "ALBERT ADKINS Formula 91AB163D1E", mule_mix_owner_search: "ALBERT ADKINS / 4112", last_used: "2025-11-05", usage_count: 4 },
	{ name: "CF-4112-NONE", item_name: "ALBERT ADKINS Formula 0000000000", mule_mix_owner_search: "ALBERT ADKINS / 4112", last_used: null, usage_count: 0 },
];
const recipe = { item: "CF-4112-A846", bom: "BOM-1", quantity: 500, uom: "Pound", ingredients: [{ item_name: "CORN", qty: 400, uom: "Pound" }], available: 0, stock_uom: "Pound", bag_weight: 50 };

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; vi.restoreAllMocks(); });

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
	it("says when each mix was last made and how often", async () => {
		await openMixes();
		const text = document.body.textContent || "";
		expect(text).toContain("Last made 2026-05-22 · made once");
		expect(text).toContain("Last made 2025-11-05 · made 4 times");
	});

	it("says so when a mix has no sales on record", async () => {
		await openMixes();
		expect(document.body.textContent).toContain("No sales recorded");
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
	it("opens a native revision without creating a scratchpad or changing the basket", async () => {
		const opened = vi.spyOn(window, "open").mockReturnValue(null);
		Element.prototype.scrollIntoView = vi.fn();
		const { wrapper, request } = await openMixes();
		await wrapper.setProps({ cartHasItems: true });
		([...document.body.querySelectorAll("button")].find(b => b.textContent === "View recipe") as HTMLButtonElement).click();
		await flushPromises();
		request.mockClear();
		([...document.body.querySelectorAll("button")].find(b => b.textContent === "Edit in formula editor") as HTMLButtonElement).click();
		expect(opened).toHaveBeenCalledWith("/desk/new-formula?bom=BOM-1&customer=MC-CUST-4112", "_blank", "noopener");
		expect(request).not.toHaveBeenCalled();
		expect(wrapper.emitted("pickup")).toBeUndefined();
	});

	it("offers a new native mix with the selected customer", async () => {
		const { wrapper } = await openMixes();
		const link = wrapper.findAll("a").find(a => a.text() === "New mix")!;
		expect(link.attributes("href")).toBe("/desk/new-formula?customer=MC-CUST-4112");
		const library = [...document.body.querySelectorAll("a")].find(a => a.textContent === "Full formula library")!;
		expect(library.getAttribute("href")).toBe("/desk/item?mule_product_class=customer_formula");
		await wrapper.setProps({ customer: undefined });
		expect(link.attributes("href")).toBe("/desk/new-formula?customer=");
	});

});
