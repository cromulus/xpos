/**
 * A return totals what ERPNext posts for it, to the cent.
 *
 * A sale of a $5 and a $1 item at 6.75% tax is $6 net and $0.405 tax; ERPNext posts
 * $0.41 (Frappe's default "Commercial Rounding", half away from zero) and $6.41. The
 * till rounded the return's -$0.405 tax with JS Math.round, which takes half toward
 * +infinity (Math.round(-40.5) = -40), so -$0.40, while ERPNext posted -$0.41 and
 * -$6.41: the refund left -$0.01 outstanding. The till now rounds money as the
 * invoice does, so a return refunds exactly the sale's total.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { pos } = vi.hoisted(() => ({
	pos: {
		taxes: [] as Array<Record<string, unknown>>,
		disableRoundedTotal: true,
		posProfile: { name: "POS-1", apply_discount_on: "Net Total" as string },
	},
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
	resolveCartPricing: vi.fn(),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printInvoice: vi.fn(), printInvoiceLocal: vi.fn() }),
}));
vi.mock("@/stores/authStore", () => ({ useAuthStore: () => ({}) }));
vi.mock("@/stores/offerStore", () => ({ useOfferStore: () => ({ offers: [], fetchOffers: vi.fn() }) }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => ({ isOnline: false }) }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: pos.taxes,
		taxInclusiveMode: false,
		profileName: pos.posProfile.name,
		companyName: "Test Co",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - TC",
		currency: "USD",
		disableRoundedTotal: pos.disableRoundedTotal,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
		posProfile: pos.posProfile,
		maxDiscountAllowed: 0,
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import { roundTo } from "@/utils/numberFormat";
import type { POSItem } from "@/types/pos.types";

const SALES_TAX = {
	description: "Sales Tax 6.75%",
	charge_type: "On Net Total",
	rate: 6.75,
	account_head: "Sales Tax - TC",
	included_in_print_rate: 0,
};
const ITEM_TAX = { "Sales Tax - TC": 6.75 };

function posItem(code: string, rate: number): POSItem {
	return {
		item_code: code,
		item_name: code,
		rate,
		uom: "Nos",
		stock_uom: "Nos",
		is_stock_item: false,
		item_tax_map: ITEM_TAX,
	} as unknown as POSItem;
}

function taxes(cart: ReturnType<typeof useCartStore>): number[] {
	return cart.calculatedTaxes.map((t) => t.amount);
}

describe("a return totals what ERPNext posts", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		pos.taxes = [SALES_TAX];
		pos.disableRoundedTotal = true;
	});

	it("sells $6 of goods at $6.41: $6 net, $0.405 tax to $0.41", () => {
		const cart = useCartStore();
		cart.addItem(posItem("ITEM-ONE", 1));
		cart.addItem(posItem("ITEM-FIVE", 5));

		expect(cart.subtotal).toBe(6);
		expect(taxes(cart)).toEqual([0.41]);
		expect(cart.grandTotal).toBe(6.41);
	});

	it("refunds the sale at -$6.41, not -$6.40: -$0.405 tax to -$0.41", () => {
		const cart = useCartStore();
		cart.enterReturnMode("SINV-0001", ["ITEM-FIVE", "ITEM-ONE"]);
		cart.addItem(posItem("ITEM-FIVE", 5));
		cart.addItem(posItem("ITEM-ONE", 1));

		expect(cart.items.map((i) => i.qty)).toEqual([-1, -1]);
		expect(cart.subtotal).toBe(-6);
		// ERPNext: flt(0.0675 * -5 + 0.0675 * -1, 2) = -0.41 (Commercial Rounding).
		expect(taxes(cart)).toEqual([-0.41]);
		// The refund is exactly the $6.41 sale it reverses.
		expect(cart.grandTotal).toBe(-6.41);
	});

	it("rounds a return line's half cent away from zero, as the invoice line does", () => {
		pos.taxes = [];
		const cart = useCartStore();
		cart.enterReturnMode("SINV-X");
		cart.addItem(posItem("ITEM-FRACTION", 0.335));

		// ERPNext: amount = flt(-1 × 0.335, 2) = -0.34; Math.round gave -0.33.
		expect(cart.subtotal).toBe(-0.34);
		expect(cart.grandTotal).toBe(-0.34);
	});

	it("takes the tax on the summed net, not line by line (round_row_wise_tax off)", () => {
		const cart = useCartStore();
		cart.enterReturnMode("SINV-X");
		// Per line: -0.0675 → -0.07 three times = -0.21; on the -$3 total: -0.2025 → -0.20.
		cart.addItem(posItem("A", 1));
		cart.addItem(posItem("B", 1));
		cart.addItem(posItem("C", 1));

		expect(taxes(cart)).toEqual([-0.2]);
		expect(cart.grandTotal).toBe(-3.2);
	});

	it("rounds a return's grand total half away from zero when the rounded total is on", () => {
		pos.taxes = [];
		pos.disableRoundedTotal = false;
		const cart = useCartStore();
		cart.enterReturnMode("SINV-X");
		cart.addItem(posItem("HALF", 6.5));

		// ERPNext's rounded_total: rounded(-6.5) = -7; Math.round(-6.5) = -6.
		expect(cart.grandTotal).toBe(-7);
	});

	it("never shows a negative zero", () => {
		pos.taxes = [];
		const cart = useCartStore();
		cart.enterReturnMode("SINV-X");
		cart.addItem(posItem("TINY", 0.001));

		expect(Object.is(cart.subtotal, 0)).toBe(true);
	});
});

describe("roundTo matches Frappe's Commercial Rounding on negatives", () => {
	// Frappe's _round_away_from_zero gives the same.
	it.each([
		[-0.405, -0.41],
		[0.405, 0.41],
		[-1.005, -1.01],
		[1.005, 1.01],
		[-2.675, -2.68],
		[-6.075, -6.08],
		[0.0675 * -5 + 0.0675 * -1, -0.41],
	])("%s → %s", (value, expected) => {
		expect(roundTo(value, 2)).toBe(expected);
	});
});
