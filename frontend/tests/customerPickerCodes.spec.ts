/** Cashier stories: tell two same-named customers apart, and find a customer by code offline. */
import { describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import CustomerSelect from "@/components/customer/CustomerSelect.vue";

const customers = [
	{ name: "MC-CUST-4112", customer_name: "DONALD BYRD", xpos_search_description: "4112, Individual" },
	{ name: "MC-CUST-6", customer_name: "DONALD BYRD", xpos_search_description: "6, Individual", mobile_no: "919-555-0100" },
	{ name: "CURTIS ADAMS", customer_name: "CURTIS ADAMS" },
];
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({ setCustomer: vi.fn() }) }));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => ({ customers, showCustomerDialog: true }) }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({}) }));
vi.mock("@/services/api", () => ({ call: vi.fn().mockResolvedValue([]), showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/dbBridge", () => ({
	getCachedCustomerGroups: vi.fn().mockResolvedValue([]), getCachedCountries: vi.fn().mockResolvedValue([]),
	cacheCustomerGroups: vi.fn().mockResolvedValue(undefined), cacheCountries: vi.fn().mockResolvedValue(undefined),
}));

describe("Customer picker", () => {
	it("shows each customer's code under the name", () => {
		const text = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } }).text();
		expect(text).toContain("4112, Individual");
		expect(text).toContain("6, Individual");
		expect(text).toContain("919-555-0100");
		expect(text).toContain("MC-CUST-4112");
		expect(text).toContain("MC-CUST-6");
	});

	it("shows no code line for a customer named by its ID with no search fields", () => {
		const rows = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } })
			.findAll("button").filter(b => b.text().includes("CURTIS ADAMS"));
		expect(rows).toHaveLength(1);
		expect(rows[0].text()).not.toMatch(/[,•]|Individual/);
	});
});
