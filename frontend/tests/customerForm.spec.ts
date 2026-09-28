/** Cashier story: record an address without entering demographic/territory fields. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import CustomerSelect from "@/components/customer/CustomerSelect.vue";
const mocks = vi.hoisted(() => ({ create: vi.fn(), select: vi.fn() }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({ setCustomer: mocks.select }) }));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => ({ customers: [], showCustomerDialog: true, createCustomer: mocks.create }) }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({}) }));
vi.mock("@/services/api", () => ({ call: vi.fn().mockResolvedValue(["Individual"]), showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/dbBridge", () => ({
	getCachedCustomerGroups: vi.fn().mockResolvedValue([]), getCachedCountries: vi.fn().mockResolvedValue([]),
	cacheCustomerGroups: vi.fn().mockResolvedValue(undefined), cacheCountries: vi.fn().mockResolvedValue(undefined),
}));

async function form() {
	const wrapper = shallowMount(CustomerSelect, { global: { renderStubDefaultSlot: true } });
	await wrapper.findAll("button-stub").find(b => b.text().includes("Create New Customer"))!.trigger("click");
	await flushPromises();
	return wrapper;
}

describe("New Customer", () => {
	beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ name: "NEW-1", customer_name: "Test Buyer" }); });
	it("saves street, line 2, city, state and ZIP and omits gender/territory", async () => {
		const wrapper = await form();
		expect(wrapper.text()).not.toContain("Gender");
		expect(wrapper.text()).not.toContain("Territory");
		expect(wrapper.text()).not.toContain("Customer Group");
		expect(wrapper.text()).not.toContain("Referral Code");
		for (const [placeholder, value] of Object.entries({ "Full name": "Test Buyer", "Address line 1": "123 Main St", "Apartment, suite, etc.": "Suite 2", City: "Benson", State: "NC", "ZIP / Postal code": "27504" })) {
			wrapper.findComponent(`[placeholder="${placeholder}"]`).vm.$emit("update:modelValue", value);
		}
		await flushPromises();
		await wrapper.findAll("button-stub").find(b => b.text().includes("Create & Select"))!.trigger("click");
		await flushPromises();
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ address_line1: "123 Main St", address_line2: "Suite 2", city: "Benson", state: "NC", pincode: "27504" }));
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("gender");
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("territory");
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("customer_group");
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("referral_code");
		wrapper.unmount();
	});
	it("prevents losing a partial address", async () => {
		const wrapper = await form();
		wrapper.findComponent('[placeholder="Full name"]').vm.$emit("update:modelValue", "Test Buyer");
		wrapper.findComponent('[placeholder="Address line 1"]').vm.$emit("update:modelValue", "123 Main St");
		await flushPromises();
		expect(wrapper.text()).toContain("Enter both street address and city");
		const create = wrapper.findAll("button-stub").find(b => b.text().includes("Create & Select"))!;
		expect(create.attributes("disabled")).toBeDefined();
		await create.trigger("click");
		expect(mocks.create).not.toHaveBeenCalled();
		wrapper.unmount();
	});
});

/** Cashier story (Mule City): a new farm or reseller customer is exempt from the first ticket. */
describe("New Customer tax exemption reason", () => {
	const reasons = ["Farm", "Reseller (resale certificate)"];
	beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ name: "NEW-1", customer_name: "Test Farmer" }); });
	afterEach(() => { delete (window as any).xpos; });
	const button = (wrapper: Awaited<ReturnType<typeof form>>, text: string) =>
		wrapper.findAll("button-stub").find(b => b.text() === text);

	it("sends the reason the cashier picks", async () => {
		(window as any).xpos = { boot: { xpos_customer_tax_exempt_reasons: reasons } };
		const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
		const wrapper = await form();
		expect(wrapper.text()).toContain("Tax exemption reason");
		expect(wrapper.text()).not.toContain("Set tax exemption");
		wrapper.findComponent('[placeholder="Full name"]').vm.$emit("update:modelValue", "Test Farmer");
		await button(wrapper, "Farm")!.trigger("click");
		await flushPromises();
		expect(button(wrapper, "Farm")!.attributes("aria-pressed")).toBe("true");
		await wrapper.findAll("button-stub").find(b => b.text().includes("Create & Select"))!.trigger("click");
		await flushPromises();
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ customer_name: "Test Farmer", mule_tax_exempt_reason: "Farm" }));
		// The reason is saved with the customer: no desk tab to finish it in.
		expect(open).not.toHaveBeenCalled();
		open.mockRestore();
		wrapper.unmount();
	});

	it("is optional: no reason, nothing sent", async () => {
		(window as any).xpos = { boot: { xpos_customer_tax_exempt_reasons: reasons } };
		const wrapper = await form();
		expect(button(wrapper, "None (taxable)")!.attributes("aria-pressed")).toBe("true");
		wrapper.findComponent('[placeholder="Full name"]').vm.$emit("update:modelValue", "Test Buyer");
		await flushPromises();
		await wrapper.findAll("button-stub").find(b => b.text().includes("Create & Select"))!.trigger("click");
		await flushPromises();
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("mule_tax_exempt_reason");
		wrapper.unmount();
	});

	it("is not shown on a site without the field", async () => {
		const wrapper = await form();
		expect(wrapper.text()).not.toContain("Tax exemption reason");
		expect(button(wrapper, "Farm")).toBeUndefined();
		wrapper.unmount();
	});
});
