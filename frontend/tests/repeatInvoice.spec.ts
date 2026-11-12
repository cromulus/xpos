/** Counter story: selecting a customer and opening Repeat immediately shows their history. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import RepeatInvoiceDialog from "@/components/dialogs/RepeatInvoiceDialog.vue";
import ChoiceDialog from "@/components/dialogs/ChoiceDialog.vue";

const mocks = vi.hoisted(() => ({ call: vi.fn(), showError: vi.fn(), cart: {} as any }));
vi.mock("@/services/api", () => ({ call: mocks.call, showError: mocks.showError }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => mocks.cart }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ companyName: "Mule", profileName: "Counter" }) }));
vi.mock("@/composables/useMoney", () => ({ useMoney: () => ({ money: String, qty: String }) }));

function mountDialog() {
	return shallowMount(RepeatInvoiceDialog, {
		props: { open: true },
		global: { renderStubDefaultSlot: true },
	});
}

describe("Repeat Invoice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cart = reactive({ customer: { name: "CUST-1" }, customerName: "Southern Woods", isEmpty: true, isReturnMode: false,
			items: [], loadFromInvoice: vi.fn(), addFromInvoice: vi.fn(), clearAll: vi.fn() });
		mocks.call.mockResolvedValue({ invoices: [], has_more: false });
	});

	it("loads recent invoices on initial mount without typing and scopes by customer ID", async () => {
		mocks.call.mockResolvedValue({ invoices: [{ name: "INV-1", customer_name: "Southern Woods", total_qty: 10 }], has_more: false });
		const wrapper = mountDialog();
		await flushPromises();
		expect(mocks.call).toHaveBeenCalledWith("xpos.api.invoices.search_invoices_for_repeat", {
			company: "Mule", pos_profile: "Counter", customer: "CUST-1", search_term: "", page: 1,
		});
		expect(wrapper.text()).toContain("Recent invoices for Southern Woods");
		expect(wrapper.text()).toContain("INV-1");
		wrapper.unmount();
	});

	it("shows recognizable purchased items and asks Add or Replace before touching a full cart", async () => {
		// Bill 2026-11-12 (MuleCity-rj2o): loading history always replaced the cart.
		Object.assign(mocks.cart, { isEmpty: false, isReturnMode: false, items: [{ item_code: "SBM" }] });
		mocks.call.mockResolvedValueOnce({ invoices: [{ name: "INV-1", items: [
			{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 10, uom: "Bag" },
		] }], has_more: false });
		mocks.call.mockResolvedValueOnce({ name: "INV-1", customer: "CUST-1", customer_name: "Southern Woods",
			items: [{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 10, rate: 20, uom: "Bag" }] });
		const wrapper = mountDialog();
		await flushPromises();
		expect(wrapper.text()).toContain("10 Bag — Max Nutrition Prime");
		await wrapper.findAll("button").find(button => button.text().includes("INV-1"))!.trigger("click");
		await flushPromises();
		const choice = wrapper.findComponent(ChoiceDialog);
		expect(choice.props("open")).toBe(true);
		expect(choice.props("choices").map((c: { key: string }) => c.key)).toEqual(["add", "replace"]);
		expect(mocks.cart.loadFromInvoice).not.toHaveBeenCalled();

		choice.vm.$emit("choose", "add");
		await flushPromises();
		expect(mocks.cart.addFromInvoice).toHaveBeenCalledWith(expect.objectContaining({ customer: "CUST-1" }));
		expect(mocks.cart.loadFromInvoice).not.toHaveBeenCalled();
		expect(wrapper.emitted("close")).toBeTruthy();
		wrapper.unmount();
	});

	it("replaces the cart when the cashier picks Replace", async () => {
		Object.assign(mocks.cart, { isEmpty: false, isReturnMode: false, items: [{ item_code: "SBM" }] });
		mocks.call.mockResolvedValueOnce({ invoices: [{ name: "INV-1" }], has_more: false });
		mocks.call.mockResolvedValueOnce({ name: "INV-1", customer: "CUST-1", customer_name: "Southern Woods",
			items: [{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 10, rate: 20, uom: "Bag" }] });
		const wrapper = mountDialog();
		await flushPromises();
		await wrapper.findAll("button").find(button => button.text().includes("INV-1"))!.trigger("click");
		await flushPromises();
		wrapper.findComponent(ChoiceDialog).vm.$emit("choose", "replace");
		await flushPromises();
		expect(mocks.cart.loadFromInvoice).toHaveBeenCalledOnce();
		expect(mocks.cart.addFromInvoice).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("loads straight into an empty cart without asking", async () => {
		Object.assign(mocks.cart, { isEmpty: true, isReturnMode: false, items: [] });
		mocks.call.mockResolvedValueOnce({ invoices: [{ name: "INV-1" }], has_more: false });
		mocks.call.mockResolvedValueOnce({ name: "INV-1", customer: "CUST-1", customer_name: "Southern Woods",
			items: [{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 10, rate: 20, uom: "Bag" }] });
		const wrapper = mountDialog();
		await flushPromises();
		await wrapper.findAll("button").find(button => button.text().includes("INV-1"))!.trigger("click");
		await flushPromises();
		expect(wrapper.findComponent(ChoiceDialog).props("open")).toBe(false);
		expect(mocks.cart.loadFromInvoice).toHaveBeenCalledOnce();
		wrapper.unmount();
	});

	it("shows an empty history instead of prompting the cashier to type", async () => {
		const wrapper = mountDialog();
		await flushPromises();
		expect(wrapper.text()).toContain("No invoices found");
		wrapper.unmount();
	});

	it("reports a failed history request", async () => {
		mocks.call.mockRejectedValue(new Error("network failed"));
		const wrapper = mountDialog();
		await flushPromises();
		expect(mocks.showError).toHaveBeenCalledWith("Failed to fetch invoices. Please try again.");
		wrapper.unmount();
	});

	it("ignores a late response for a previous customer", async () => {
		let finishOld!: (value: unknown) => void;
		mocks.call.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
		const wrapper = mountDialog();
		mocks.cart.customer = { name: "CUST-2" };
		await flushPromises();
		finishOld({ invoices: [{ name: "WRONG-CUSTOMER" }], has_more: false });
		await flushPromises();
		expect(wrapper.text()).not.toContain("WRONG-CUSTOMER");
		expect(mocks.call.mock.lastCall?.[1].customer).toBe("CUST-2");
		wrapper.unmount();
	});
});
