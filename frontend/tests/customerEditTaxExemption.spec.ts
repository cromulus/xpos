/**
 * Bill (2026-09-29): "Tax exemption: it's in customer edit, that's it." In Edit
 * Customer, someone allowed to set it picks Farm, Reseller or None (taxable);
 * saving sends the reason (the server records who) and the cart looks the
 * customer's taxes up again. Nothing opens the desk any more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
	store: null as null | { showCustomerEditDialog: boolean },
	update: vi.fn(),
	recheckTax: vi.fn(),
	setCustomer: vi.fn(),
	cart: { customer: { name: "MC-CUST-4112", xpos_has_address: true }, muleTaxExemptReason: "" },
}));
vi.mock("@/stores/cartStore", () => ({
	useCartStore: () => ({ ...mocks.cart, setCustomer: mocks.setCustomer, recheckTax: mocks.recheckTax }),
}));
vi.mock("@/stores/customerStore", async () => {
	const { reactive } = await import("vue");
	return {
		useCustomerStore: () => {
			mocks.store ??= reactive({
				showCustomerEditDialog: false,
				getCustomerInfo: vi.fn().mockResolvedValue({ customer_name: "Ford Farms", customer_group: "Mule City Customers", territory: "All Territories" }),
				updateCustomer: mocks.update,
			});
			return mocks.store;
		},
	};
});
vi.mock("@/services/api", () => ({ call: vi.fn().mockResolvedValue([]), showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/dbBridge", () => ({
	getCachedCustomerGroups: vi.fn().mockResolvedValue([]), getCachedTerritories: vi.fn().mockResolvedValue([]), getCachedCountries: vi.fn().mockResolvedValue([]),
	cacheCustomerGroups: vi.fn(), cacheTerritories: vi.fn(), cacheCountries: vi.fn(),
}));

import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";

const reasons = ["Farm", "Reseller (resale certificate)"];
const button = (wrapper: ReturnType<typeof shallowMount>, text: string) =>
	wrapper.findAll("button-stub").find((b) => b.text().includes(text));

async function dialog() {
	const wrapper = shallowMount(CustomerEditDialog, { global: { renderStubDefaultSlot: true } });
	// Open it as the cart's pencil does: that is when the customer is loaded.
	mocks.store!.showCustomerEditDialog = true;
	await flushPromises();
	return wrapper;
}

beforeEach(() => {
	vi.clearAllMocks();
	if (mocks.store) mocks.store.showCustomerEditDialog = false;
	mocks.cart.muleTaxExemptReason = "";
	mocks.update.mockResolvedValue({ name: "MC-CUST-4112", customer_name: "Ford Farms" });
	(window as any).xpos = { boot: { xpos_customer_tax_exempt_reasons: reasons } };
});
afterEach(() => { delete (window as any).xpos; });

describe("Tax exemption in Edit Customer", () => {
	it("sets Farm on save and looks the cart's taxes up again", async () => {
		const wrapper = await dialog();
		expect(button(wrapper, "None (taxable)")!.attributes("aria-pressed")).toBe("true");
		await button(wrapper, "Farm")!.trigger("click");
		await button(wrapper, "Save")!.trigger("click");
		await flushPromises();
		expect(mocks.update).toHaveBeenCalledWith("MC-CUST-4112", expect.objectContaining({ mule_tax_exempt_reason: "Farm" }));
		expect(mocks.recheckTax).toHaveBeenCalled();
		// The customer's status flags survive the save.
		expect(mocks.setCustomer.mock.calls[0][0]).toMatchObject({ name: "MC-CUST-4112", xpos_has_address: true });
		wrapper.unmount();
	});

	it("makes an exempt customer taxable with None", async () => {
		mocks.cart.muleTaxExemptReason = "Farm";
		const wrapper = await dialog();
		expect(button(wrapper, "Farm")!.attributes("aria-pressed")).toBe("true");
		await button(wrapper, "None (taxable)")!.trigger("click");
		await button(wrapper, "Save")!.trigger("click");
		await flushPromises();
		expect(mocks.update).toHaveBeenCalledWith("MC-CUST-4112", expect.objectContaining({ mule_tax_exempt_reason: "" }));
		wrapper.unmount();
	});

	it("sends nothing about the exemption when it did not change", async () => {
		const wrapper = await dialog();
		await button(wrapper, "Save")!.trigger("click");
		await flushPromises();
		expect(mocks.update.mock.calls[0][1]).not.toHaveProperty("mule_tax_exempt_reason");
		expect(mocks.recheckTax).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("is not offered to someone who may not set it, and never opens the desk", async () => {
		(window as any).xpos = { boot: {} };
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const wrapper = await dialog();
		expect(button(wrapper, "Farm")).toBeUndefined();
		expect(wrapper.text()).not.toContain("Set tax exemption");
		expect(open).not.toHaveBeenCalled();
		open.mockRestore();
		wrapper.unmount();
	});
});
