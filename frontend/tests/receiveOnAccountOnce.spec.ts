/**
 * @vitest-environment jsdom
 *
 * mc37 staging walk 2026-10-04 (MuleCity-6ev6): one click on "Receive on Account"
 * opened two stacked copies of its dialog. PosView renders two Carts (the desktop
 * panel and the mobile tab, one hidden only by CSS), and each Cart mounted the
 * store-opened dialog. It is mounted once now (CartDialogs, beside the Carts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/services/api", () => ({
	call: vi.fn(async () => []),
	showSuccess: vi.fn(),
	showError: vi.fn(),
	isNetworkError: () => false,
	default: { call: vi.fn() },
}));
vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
}));
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({ source: "unavailable" })),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printInvoice: vi.fn(), printInvoiceLocal: vi.fn() }),
}));
vi.mock("@/stores/authStore", () => ({ useAuthStore: () => ({}) }));
vi.mock("@/stores/offerStore", () => ({ useOfferStore: () => ({ offers: [], fetchOffers: vi.fn() }) }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => ({ isOnline: true }) }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profileName: "POS-PROFILE-1",
		companyName: "Test Co",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - TC",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
		posProfile: null,
		maxDiscountAllowed: 25,
		allowOutstandingSettlement: true,
		showCustomerBalance: false,
		enableCashierSettlement: false,
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import Cart from "@/components/cart/Cart.vue";
import CartDialogs from "@/components/cart/CartDialogs.vue";

// Each mounted Receive on Account dialog that is open shows one of these.
const stubs = {
	ReceiveOnAccountDialog: { props: ["customer"], template: "<div v-if='customer' data-testid='roa-dialog' />" },
	CustomerEditDialog: { template: "<div />" },
	AddDelivery: { template: "<div />" },
	ClearCustomer: { template: "<div />" },
	CustomerOrdersBadge: { template: "<div />" },
	CustomerStatusIcons: { template: "<div />" },
	TooltipWrapper: { template: "<div><slot /></div>" },
};

// PosView's layout: the desktop cart, the mobile cart, and the dialogs once.
const PosLayout = {
	components: { Cart, CartDialogs },
	template: "<div><div class='desktop'><Cart /></div><div class='mobile'><Cart /></div><CartDialogs /></div>",
};

beforeEach(() => setActivePinia(createPinia()));

describe("Receive on Account opens one dialog", () => {
	it("one click on the empty cart's Receive on Account mounts exactly one dialog", async () => {
		const cart = useCartStore();
		const customers = useCustomerStore();
		cart.customer = { name: "CUST-342", customer_name: "Peron Parker" } as never;
		customers.selectedCustomerInfo = { name: "CUST-342", balance: 120, credit_limit: 0 } as never;

		const wrapper = mount(PosLayout, { global: { stubs } });
		await flushPromises();
		expect(wrapper.findAll("[data-testid='roa-dialog']")).toHaveLength(0);

		const buttons = wrapper.findAll("button").filter((b) => b.text() === "Receive on Account");
		expect(buttons).toHaveLength(2); // one Pay button per Cart
		await buttons[0].trigger("click");
		await flushPromises();

		expect(customers.showReceiveOnAccount).toBe(true);
		expect(wrapper.findAll("[data-testid='roa-dialog']")).toHaveLength(1);
		wrapper.unmount();
	});
});
