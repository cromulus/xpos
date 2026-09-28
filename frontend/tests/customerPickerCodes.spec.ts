/** Cashier stories: tell two same-named customers apart, and find a customer by code offline. */
import { describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import CustomerSelect from "@/components/customer/CustomerSelect.vue";

const customers = [
	{ name: "MC-CUST-2980", customer_name: "Southern Woods", mule_filepro_alias_codes: "2980",
		xpos_search_description: "Reseller", xpos_sales_12mo: 17812.11, xpos_sales_currency: "USD", mobile_no: "919-555-0199", email_id: "private@example.com",
		xpos_has_address: true, xpos_has_email: false, xpos_has_phone: true, xpos_customer_since: "2014-03-12" },
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
	it("shows one familiar code, business context and trailing sales", () => {
		const row = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } })
			.findAll("button").find(b => b.text().includes("Southern Woods"))!;
		expect(row.text()).toContain("2980");
		expect(row.text()).not.toContain("MC-CUST-2980");
		expect(row.text()).toContain("Reseller");
		expect(row.text()).toContain("17,812");
		expect(row.text()).toContain("past 12 months");
		expect(row.text()).not.toContain("919-555-0199");
		expect(row.text()).not.toContain("private@example.com");
		expect(row.find('[aria-label="Address on file"]').exists()).toBe(true);
		expect(row.find('[aria-label="Email missing"]').exists()).toBe(true);
		expect(row.find('[aria-label="Phone on file"]').exists()).toBe(true);
		expect(row.text()).toContain("Customer since 2014-03-12");
	});

	it("shows each customer's code under the name", () => {
		const text = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } }).text();
		expect(text).toContain("4112, Individual");
		expect(text).toContain("6, Individual");
		expect(text).not.toContain("919-555-0100");
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
