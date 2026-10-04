/**
 * @vitest-environment jsdom
 *
 * mc36 staging walk 2026-10-03 (MuleCity-m2s4): a fully prepaid mix order loaded
 * for pickup (SAL-ORD-00014, advance $3.75) showed "Pay $3.75" on the cart while
 * the Pay dialog said Amount Due $0.00, so a cashier might collect again. The
 * button shows what is left to pay after the order's advance, the dialog's figure.
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

import * as api from "@/services/api";
import { useCartStore } from "@/stores/cartStore";
import CartSummary from "@/components/cart/CartSummary.vue";

const stubs = { TooltipWrapper: { template: "<div><slot /></div>" } };

function loadPickup(totalAdvance: number) {
	const cart = useCartStore();
	cart.loadFromInvoice({
		customer: "CUST-1",
		customer_name: "Peron Parker",
		items: [{ item_code: "MIX-1", item_name: "3H Hospital Mix", qty: 1, rate: 3.75, uom: "Nos" }],
		total_advance: totalAdvance,
	});
	return cart;
}

async function payButtonText(): Promise<string> {
	const wrapper = mount(CartSummary, { global: { stubs } });
	await flushPromises();
	const text = wrapper.findAll("button").map((b) => b.text()).find((t) => t.startsWith("Pay")) ?? "";
	wrapper.unmount();
	return text;
}

describe("Pay button on a prepaid pickup", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it("a fully prepaid pickup reads Pay $0.00, not the order's total", async () => {
		const cart = loadPickup(3.75);
		expect(cart.grandTotal).toBe(3.75);
		expect(cart.amountDue).toBe(0);
		expect(await payButtonText()).toMatch(/^Pay \D*0\.00$/);
	});

	it("a part-paid pickup reads what is left", async () => {
		loadPickup(1);
		expect(await payButtonText()).toMatch(/^Pay \D*2\.75$/);
	});

	it("negative: a sale with no advance still reads its total", async () => {
		loadPickup(0);
		expect(await payButtonText()).toMatch(/^Pay \D*3\.75$/);
	});

	it("once Pay has asked the server, the button and the dialog read the same Amount Due", async () => {
		const cart = loadPickup(3.75);
		// preview_invoice's amount_due already has the order's advance off (XPOS _set_order_advances).
		vi.mocked(api.call).mockResolvedValue({ amount_due: 0, items: [] } as never);
		await cart.openPaymentDialog();
		// The dialog shows Math.abs(grandTotal); the button shows amountDue.
		expect(cart.grandTotal).toBe(0);
		expect(cart.amountDue).toBe(0);
		expect(await payButtonText()).toMatch(/^Pay \D*0\.00$/);
	});

	it("a new cart forgets the advance", async () => {
		const cart = loadPickup(3.75);
		cart.clearCart();
		expect(cart.orderAdvance).toBe(0);
	});
});
