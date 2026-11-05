/** Cashier story (MuleCity-1ptj): the picker says which person or number found the farm. */
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { shallowMount } from "@vue/test-utils";
import { Input } from "@/components/ui/input";
import CustomerSelect from "@/components/customer/CustomerSelect.vue";

const customers = [
	{ name: "MC-CUST-1001", customer_name: "Sharp Farms Inc", xpos_contacts: [
		{ name: "C-1", full_name: "Jane Sharp", phones: ["(919) 555-1234"], emails: [], is_primary_contact: true }] },
	{ name: "MC-CUST-2002", customer_name: "Jane Hill Farm" },
];
const searchCustomers = vi.fn();
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({ setCustomer: vi.fn() }) }));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => ({ customers, showCustomerDialog: true, searchCustomers }) }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({}) }));
vi.mock("@/services/api", () => ({ call: vi.fn().mockResolvedValue([]), showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/dbBridge", () => ({
	getCachedCountries: vi.fn().mockResolvedValue([]), cacheCountries: vi.fn().mockResolvedValue(undefined),
}));

async function typed(term: string) {
	const wrapper = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } });
	wrapper.findComponent(Input).vm.$emit("update:modelValue", term);
	await nextTick();
	return wrapper.findAll("button").filter((b) => b.text().includes("Farm")).map((b) => {
		const via = b.find('[data-testid="customer-match-via"]');
		return via.exists() ? via.text() : null;
	});
}

describe("Customer picker match line", () => {
	it("names the contact and number that matched", async () => {
		expect(await typed("1234")).toEqual(["via Jane Sharp · (919) 555-1234", null]);
	});
	it("names the contact found by name, not the farm found by its own name", async () => {
		expect(await typed("jane")).toEqual(["via Jane Sharp", null]);
	});
	it("negative: no search, no match line", async () => {
		expect(await typed("")).toEqual([null, null]);
	});
});
