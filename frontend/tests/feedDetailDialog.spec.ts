import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, defineComponent } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
const mocks = vi.hoisted(() => ({ item: null as any, cart: null as any, pos: null as any, call: vi.fn() }));
vi.mock("@/stores/itemStore", () => ({ useItemStore: () => mocks.item }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => mocks.cart }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => mocks.pos }));
vi.mock("@/services/api", () => ({ call: mocks.call, showError: vi.fn() }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => false }));
vi.mock("@/composables/useMoney", () => ({ useMoney: () => ({ moneyRate: String, ratePrecision: 9, qty: String }) }));
import ItemDetailDialog from "@/components/dialogs/ItemDetailDialog.vue";
import { useSiteExtension } from "./helpers/siteExtension";

// A site with the till extensions (boot xpos_site).
useSiteExtension();
const slot = defineComponent({ template: "<div><slot /></div>" });
function view() {
	return mount(ItemDetailDialog, { global: { stubs: { Dialog: slot, DialogContent: slot, DialogHeader: slot, DialogTitle: slot, DialogDescription: slot, DialogFooter: slot, Button: defineComponent({ template: "<button><slot /></button>" }) } } });
}
const context = (item = "MIX") => ({ item, item_name: item, composition: [], guaranteed_analysis: { protein_pct: item === "MIX" ? 12 : 25 } });
beforeEach(() => {
	mocks.call.mockReset().mockResolvedValue(context());
	mocks.item = reactive({ showItemDetail: true, detailCartRowUid: "row-1", selectedItemForDetail: { item_code: "MIX", item_name: "Mix" }, selectedItemDetail: null, isLoadingDetail: false });
	mocks.cart = reactive({ items: [{ uid: "row-1", item_code: "MIX", qty: 40, uom: "Bag" }], customer: { name: "CUSTOMER" }, isOrderLine: () => true, quotedOrder: () => null, pickupDate: "", mixCheckPending: false, mixCalculationPending: false, mixCheckError: "" });
	mocks.pos = reactive({ profileName: "Till" });
});
describe("cart detailed view", () => {
	it("reads the current customer and line size without adding another cart line", async () => {
		const wrapper = view(); await flushPromises();
		expect(mocks.call).toHaveBeenCalledWith("mulecity_erpnext.pos_product_context.product_details", { item_code: "MIX", pos_profile: "Till", customer: "CUSTOMER" });
		expect(wrapper.text()).toContain("This order · 40 Bag");
		expect(wrapper.text()).toContain("Choose a pickup or delivery date");
		expect(wrapper.text()).not.toContain("Add to Cart");
		mocks.cart.items[0].qty = 20; await flushPromises();
		expect(wrapper.text()).toContain("This order · 20 Bag");
		mocks.cart.items = []; await flushPromises();
		expect(wrapper.text()).toContain("This line is no longer in the cart");
		expect(wrapper.text()).not.toContain("This order");
		wrapper.unmount();
	});
	it("never displays a late response for the previous product", async () => {
		let resolve!: (value: unknown) => void;
		mocks.call.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(context("NEW"));
		const wrapper = view();
		mocks.item.selectedItemForDetail = { item_code: "NEW", item_name: "New" };
		await flushPromises();
		expect(wrapper.text()).toContain("Protein %25");
		resolve(context()); await flushPromises();
		expect(wrapper.text()).toContain("Protein %25");
		expect(wrapper.text()).not.toContain("Protein %12");
		wrapper.unmount();
	});
});
