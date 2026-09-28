/**
 * @vitest-environment jsdom
 *
 * User story (MuleCity-mxwy.31): at a counter capped at 25% off, a cashier opens
 * the additional (whole-ticket) discount and types more than the cap allows.
 * The box stops at what is left under the cap - after any line discounts - and
 * says "Max 25% at the counter"; the cart applies that value, not what she typed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("@/services/userRights", () => ({
	hasPermission: (key: string) => key === "apply_additional_discount",
}));
vi.mock("@/services/api", () => ({
	call: vi.fn(async () => []),
	showSuccess: vi.fn(),
	showError: vi.fn(),
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
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import CartSummary from "@/components/cart/CartSummary.vue";
import type { POSItem } from "@/types/pos.types";

function posItem(code: string, rate: number): POSItem {
	return { item_code: code, item_name: code, rate, uom: "Nos", stock_uom: "Nos", is_stock_item: false } as POSItem;
}

describe("additional discount box at a 25% counter", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it("stops a $ additional discount at what the line discounts leave", async () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED-A", 60));
		cart.addItem(posItem("FEED-B", 40));
		cart.updateItemDiscount(0, "amount", 15);

		const wrapper = mount(CartSummary, { global: { stubs: { TooltipWrapper: { template: "<div><slot /></div>" } } } });
		await flushPromises();

		// Open the additional discount box, switch to $, type 20.
		const tagButton = wrapper.findAll("button").find((b) => b.find("svg.lucide-tag").exists());
		await tagButton!.trigger("click");
		const dollar = wrapper.findAll("button").find((b) => b.text() === "$");
		await dollar!.trigger("click");
		const input = wrapper.find('input[inputmode="decimal"]');
		await input.trigger("focus");
		await input.setValue("20");
		await flushPromises();

		// $85 charged after the line discount; the ticket may go to $75.
		expect((input.element as HTMLInputElement).value).toBe("10");
		expect(cart.discountAmount).toBe(10);
		expect(wrapper.find('[data-testid="additional-discount-cap-message"]').text()).toBe(
			"Max 25% at the counter",
		);
		wrapper.unmount();
	});

	it("keeps a % additional discount under the cap as typed", async () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED-A", 100));

		const wrapper = mount(CartSummary, { global: { stubs: { TooltipWrapper: { template: "<div><slot /></div>" } } } });
		await flushPromises();
		const tagButton = wrapper.findAll("button").find((b) => b.find("svg.lucide-tag").exists());
		await tagButton!.trigger("click");
		const input = wrapper.find('input[inputmode="decimal"]');
		await input.trigger("focus");
		await input.setValue("40");
		await flushPromises();
		expect((input.element as HTMLInputElement).value).toBe("25");
		expect(cart.discountPercentage).toBe(25);

		await input.setValue("10");
		await input.trigger("blur");
		await flushPromises();
		expect(cart.discountPercentage).toBe(10);
		expect(wrapper.find('[data-testid="additional-discount-cap-message"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
