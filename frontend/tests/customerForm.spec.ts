/** Cashier story: record an address without entering demographic/territory fields. */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

	// Mule City intake: the customer type is a label; a tax exemption is a request for Brandy.
	async function createWith(fill: (wrapper: Awaited<ReturnType<typeof form>>) => Promise<void>) {
		const wrapper = await form();
		wrapper.findComponent('[placeholder="Full name"]').vm.$emit("update:modelValue", "Test Buyer");
		await fill(wrapper);
		await flushPromises();
		await wrapper.findAll("button-stub").find(b => b.text().includes("Create & Select"))!.trigger("click");
		await flushPromises();
		return wrapper;
	}
	it("sends the chosen customer type", async () => {
		const wrapper = await createWith(async w => { await w.find("#mule-customer-kind").setValue("Reseller"); });
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ mule_customer_kind: "Reseller" }));
		wrapper.unmount();
	});
	it("omits the customer type when not set and never sends an exemption flag", async () => {
		const wrapper = await createWith(async () => {});
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("mule_customer_kind");
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("request_tax_exemption");
		wrapper.unmount();
	});
	it("opens a tax change request for the new customer when an exemption is requested", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
		const wrapper = await createWith(async w => { await w.find('input[type="checkbox"]').setValue(true); });
		expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("request_tax_exemption");
		expect(open).toHaveBeenCalledWith("/desk/customer-tax-change-request/new?customer=NEW-1", "_blank");
		open.mockRestore();
		wrapper.unmount();
	});
	it("opens nothing when no exemption is requested", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
		const wrapper = await createWith(async () => {});
		expect(open).not.toHaveBeenCalled();
		open.mockRestore();
		wrapper.unmount();
	});
});
