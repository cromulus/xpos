/**
 * Bill (2026-09-29, MuleCity-nfxn.6): "Need add addresses in customer edit!"
 * Leslie adds a delivery address, or corrects one, from Edit Customer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const store = vi.hoisted(() => ({
	fetchAddresses: vi.fn(),
	createAddress: vi.fn(async () => ({ name: "ADDR-2" })),
	updateAddress: vi.fn(async () => ({ name: "ADDR-1" })),
}));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => store }));
vi.mock("@/services/api", () => ({ showError: vi.fn() }));
vi.mock("@/utils", () => ({ isOnline: () => true, extractErrorMessage: (e: unknown) => String(e) }));
vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));

import CustomerAddresses from "@/components/customer/CustomerAddresses.vue";

const stubs = {
	Button: { props: ["disabled"], template: "<button :disabled='disabled' v-bind='$attrs'><slot /></button>" },
	Input: {
		props: ["modelValue", "placeholder"],
		emits: ["update:modelValue"],
		template: "<input :placeholder='placeholder' :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />",
	},
};

const farm = { name: "ADDR-1", address_line1: "12 Farm Lane", city: "Benson", state: "NC", pincode: "27504", country: "United States" };

async function open(addresses = [farm]) {
	store.fetchAddresses.mockResolvedValue(addresses);
	const wrapper = mount(CustomerAddresses, { props: { customer: "CUST-9" }, global: { stubs } });
	await flushPromises();
	return wrapper;
}

async function fill(wrapper: Awaited<ReturnType<typeof open>>, street: string, city: string) {
	await wrapper.get("input[placeholder='Street address']").setValue(street);
	await wrapper.get("input[placeholder='City']").setValue(city);
}

beforeEach(() => vi.clearAllMocks());

describe("addresses in Edit Customer", () => {
	it("lists the customer's addresses", async () => {
		const wrapper = await open();
		expect(wrapper.get("[data-testid='address-row']").text()).toContain("12 Farm Lane, Benson, NC 27504");
	});

	it("adds an address for the customer", async () => {
		const wrapper = await open([]);
		expect(wrapper.text()).toContain("No address on file");
		await wrapper.get("[data-testid='add-address']").trigger("click");
		await fill(wrapper, "40 Mill Rd", "Dunn");
		store.fetchAddresses.mockResolvedValue([{ ...farm, name: "ADDR-2", address_line1: "40 Mill Rd", city: "Dunn" }]);
		await wrapper.get("[data-testid='save-address']").trigger("click");
		await flushPromises();
		expect(store.createAddress).toHaveBeenCalledWith(expect.objectContaining({ customer: "CUST-9", address_line1: "40 Mill Rd", city: "Dunn" }));
		expect(wrapper.emitted("changed")?.[0]?.[0]).toHaveLength(1);
	});

	it("corrects an existing address", async () => {
		const wrapper = await open();
		await wrapper.findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
		await wrapper.get("input[placeholder='Street address']").setValue("14 Farm Lane");
		await wrapper.get("[data-testid='save-address']").trigger("click");
		await flushPromises();
		expect(store.updateAddress).toHaveBeenCalledWith("CUST-9", "ADDR-1", expect.objectContaining({ address_line1: "14 Farm Lane", city: "Benson" }));
	});

	it("won't save an address without a street and a city", async () => {
		const wrapper = await open([]);
		await wrapper.get("[data-testid='add-address']").trigger("click");
		await fill(wrapper, "40 Mill Rd", "");
		expect(wrapper.get("[data-testid='save-address']").attributes("disabled")).toBeDefined();
		await wrapper.get("[data-testid='save-address']").trigger("click");
		expect(store.createAddress).not.toHaveBeenCalled();
	});
});
