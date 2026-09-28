/**
 * Counter story (Mule City): front desk sets a customer's tax exemption as the
 * Customer's Tax Category on the desk (the Customer history records who).
 * "Set tax exemption" on Edit Customer opens that form's tax field in a new
 * tab; it creates nothing itself (no Customer Tax Change Request).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";
import { customerTaxUrl } from "@/services/customerTax";

const mocks = vi.hoisted(() => ({ call: vi.fn(), showError: vi.fn() }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({ customer: { name: "SMITH/J 1" }, setCustomer: vi.fn() }) }));
vi.mock("@/stores/customerStore", () => ({
	useCustomerStore: () => ({ showCustomerEditDialog: true, getCustomerInfo: vi.fn().mockResolvedValue({ customer_name: "J Smith" }), updateCustomer: vi.fn() }),
}));
vi.mock("@/services/api", () => ({ call: mocks.call, showSuccess: vi.fn(), showError: mocks.showError }));
vi.mock("@/services/dbBridge", () => ({
	getCachedCustomerGroups: vi.fn().mockResolvedValue([]), getCachedTerritories: vi.fn().mockResolvedValue([]), getCachedCountries: vi.fn().mockResolvedValue([]),
	cacheCustomerGroups: vi.fn(), cacheTerritories: vi.fn(), cacheCountries: vi.fn(),
}));

async function dialog() {
	const wrapper = shallowMount(CustomerEditDialog, { global: { renderStubDefaultSlot: true } });
	await flushPromises();
	return wrapper;
}

describe("Set tax exemption", () => {
	beforeEach(() => vi.clearAllMocks());

	it("links to the customer's Tax Category field on the desk, name encoded", () => {
		expect(customerTaxUrl("SMITH/J 1")).toBe("/desk/customer/SMITH%2FJ%201#tax_category");
	});

	it("opens the selected customer's tax section in a new tab and creates nothing", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
		const wrapper = await dialog();
		await wrapper.find('[data-testid="set-tax-exemption"]').trigger("click");
		expect(open).toHaveBeenCalledWith("/desk/customer/SMITH%2FJ%201#tax_category", "_blank");
		expect(mocks.call).not.toHaveBeenCalledWith(expect.stringContaining("tax_change"), expect.anything());
		expect(mocks.showError).not.toHaveBeenCalled();
		open.mockRestore();
		wrapper.unmount();
	});

	it("says how to continue when the browser blocks the new tab", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const wrapper = await dialog();
		await wrapper.find('[data-testid="set-tax-exemption"]').trigger("click");
		expect(mocks.showError).toHaveBeenCalledWith(expect.stringContaining("Tax Category"));
		open.mockRestore();
		wrapper.unmount();
	});
});
