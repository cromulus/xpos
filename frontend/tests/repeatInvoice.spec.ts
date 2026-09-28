/** Counter story: selecting a customer and opening Repeat immediately shows their history. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import RepeatInvoiceDialog from "@/components/dialogs/RepeatInvoiceDialog.vue";

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
		mocks.cart = reactive({ customer: { name: "CUST-1" }, customerName: "Southern Woods", loadFromInvoice: vi.fn() });
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

	it("shows recognizable purchased items and preserves a cart when replacement is declined", async () => {
		mocks.cart.itemCount = 1;
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		mocks.call.mockResolvedValue({ invoices: [{ name: "INV-1", items: [
			{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 10, uom: "Bag" },
		] }], has_more: false });
		const wrapper = mountDialog();
		await flushPromises();
		expect(wrapper.text()).toContain("10 Bag — Max Nutrition Prime");
		await wrapper.findAll("button").find(button => button.text().includes("INV-1"))!.trigger("click");
		expect(confirm).toHaveBeenCalled();
		expect(mocks.cart.loadFromInvoice).not.toHaveBeenCalled();
		expect(mocks.call).toHaveBeenCalledTimes(1);
		confirm.mockRestore();
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
