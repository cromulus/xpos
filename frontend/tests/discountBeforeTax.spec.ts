/**
 * User story: a counter whose POS Profile says "Apply Additional Discount On: Net
 * Total" takes the cashier's ticket discount off the goods before tax, the way
 * ERPNext does on save. A $100 taxable sale at 6.75% with $10 (or 10%) off is
 * $90 net, $6.08 tax, $96.08 due - the till shows what the invoice will say.
 * A "Grand Total" profile keeps taking it off the taxed total, and a transaction
 * Pricing Rule's own "Apply Discount On" still wins over the profile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { profile, resolveCartPricing } = vi.hoisted(() => ({
	profile: { name: "COUNTER", apply_discount_on: "Net Total" as string | undefined },
	resolveCartPricing: vi.fn(),
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
	resolveCartPricing,
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
		taxes: [
			{
				description: "Sales Tax",
				charge_type: "On Net Total",
				rate: 6.75,
				account_head: "Sales Tax - TC",
				included_in_print_rate: 0,
			},
		],
		taxInclusiveMode: false,
		profileName: profile.name,
		companyName: "Test Co",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - TC",
		currency: "USD",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
		posProfile: profile,
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import type { POSItem } from "@/types/pos.types";

function posItem(code: string, rate: number): POSItem {
	return { item_code: code, item_name: code, rate, uom: "Nos", stock_uom: "Nos", is_stock_item: false } as POSItem;
}

function taxes(cart: ReturnType<typeof useCartStore>): number[] {
	return cart.calculatedTaxes.map((t) => t.amount);
}

describe("discount before tax on a Net Total counter", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		profile.apply_discount_on = "Net Total";
		resolveCartPricing.mockReset();
	});

	it("takes $10 off the $100 net, then taxes the $90", () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED", 100));
		cart.setDiscount("amount", 10);

		expect(cart.applyDiscountOn).toBe("Net Total");
		expect(taxes(cart)).toEqual([6.08]);
		expect(cart.grandTotal).toBe(96.08);
		expect(cart.getInvoiceData("COUNTER", "SHIFT").apply_discount_on).toBe("Net Total");
	});

	it("takes 10% off the $100 net, then taxes the $90", () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED", 100));
		cart.setDiscount("percentage", 10);

		expect(taxes(cart)).toEqual([6.08]);
		expect(cart.grandTotal).toBe(96.08);
	});

	it("spreads the discount over several lines before taxing them", () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED-A", 60));
		cart.addItem(posItem("FEED-B", 40));
		cart.setDiscount("amount", 10);

		expect(taxes(cart)).toEqual([6.08]);
		expect(cart.grandTotal).toBe(96.08);
	});
});

describe("a Grand Total counter keeps today's behaviour", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		resolveCartPricing.mockReset();
	});

	it("takes $10 off the taxed $106.75", () => {
		profile.apply_discount_on = "Grand Total";
		const cart = useCartStore();
		cart.addItem(posItem("FEED", 100));
		cart.setDiscount("amount", 10);

		expect(cart.applyDiscountOn).toBe("Grand Total");
		expect(taxes(cart)).toEqual([6.75]);
		expect(cart.grandTotal).toBe(96.75);
	});

	it("falls back to Grand Total when the profile names none", () => {
		profile.apply_discount_on = undefined;
		const cart = useCartStore();
		cart.addItem(posItem("FEED", 100));
		cart.setDiscount("amount", 10);

		expect(cart.applyDiscountOn).toBe("Grand Total");
		expect(cart.grandTotal).toBe(96.75);
	});
});

describe("a transaction Pricing Rule's apply_discount_on wins", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		profile.apply_discount_on = "Net Total";
		resolveCartPricing.mockReset();
	});

	function reply(invoiceUpdates: Record<string, unknown>) {
		return { updates: [], free_lines: [], invoice_updates: invoiceUpdates, source: "server" };
	}

	it("uses the rule's Grand Total on a Net Total counter, and the profile's again once it lapses", async () => {
		const cart = useCartStore();
		cart.addItem(posItem("FEED", 100));

		resolveCartPricing.mockResolvedValue(
			reply({
				additional_discount_percentage: 0,
				discount_amount: 10,
				apply_discount_on: "Grand Total",
				from_pricing_rule: true,
			}),
		);
		await cart.applyPricingRules();
		expect(cart.applyDiscountOn).toBe("Grand Total");
		expect(cart.grandTotal).toBe(96.75);

		// No rule fires: the server's "Grand Total" placeholder does not override the profile.
		resolveCartPricing.mockResolvedValue(
			reply({
				additional_discount_percentage: 0,
				discount_amount: 0,
				apply_discount_on: "Grand Total",
				from_pricing_rule: false,
			}),
		);
		await cart.applyPricingRules();
		expect(cart.applyDiscountOn).toBe("Net Total");
	});
});
