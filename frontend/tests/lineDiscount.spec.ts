/**
 * @vitest-environment jsdom
 *
 * A cashier types a money discount on a cart line and the line shows that much off the
 * whole line: $10 off 4 units at $10 shows -$10 and $30.00. create_invoice takes a
 * line's discount_amount per unit, so the cart sends $2.50 a unit, and the sale charges
 * the $30.00 the screen showed, not $0 (4 × $10 off). A sale queued offline posts the
 * same payload, and loading a posted or queued sale back into the cart shows the same
 * line discount again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({
	call: vi.fn(),
	default: { call: vi.fn() },
}));

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
}));

vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profileName: "POS-1",
		companyName: "Test Co",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - TC",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
		maxDiscountAllowed: 0,
		allowZeroRatedItems: false,
	})),
}));

vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { resolveCartPricing } from "@/services/pricingService";
import { useCartStore } from "@/stores/cartStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { lineDiscountFromPerUnit, perUnitDiscount } from "@/utils/lineDiscount";
import type { POSItem } from "@/types/pos.types";

/** Half away from zero, as Frappe's flt. */
function round(value: number, places: number): number {
	const f = 10 ** places;
	return (Math.sign(value) * Math.round(Number((Math.abs(value) * f).toFixed(6)))) / f;
}

/**
 * The line amount create_invoice posts: the per-unit discount kept to the cent,
 * rate = price_list_rate − discount at the rate precision, amount = rate × qty.
 */
function serverLineAmount(qty: number, priceListRate: number, perUnit: number, ratePrecision = 3): number {
	return round(Math.abs(qty) * round(priceListRate - round(perUnit, 2), ratePrecision), 2);
}

function product(rate: number, uom = "Nos"): POSItem {
	return {
		item_code: "ITEM-A",
		item_name: "Item A",
		rate,
		uom,
		stock_uom: uom,
		item_group: "Products",
		is_stock_item: false,
	} as POSItem;
}

describe("perUnitDiscount", () => {
	it.each([
		// [line discount typed, qty, rate]
		[10, 1, 10],
		[10, 4, 10],
		[6.6, 4, 10],
		[3, 1, 23.47],
		[1, 4, 0.75],
		[2.5, 12.5, 0.6],
	])("posts $%s off %s × $%s to the cent the screen shows", (line, qty, rate) => {
		const perUnit = perUnitDiscount(line, qty, rate, 3);
		const shown = round(qty * rate - line, 2);
		expect(serverLineAmount(qty, rate, perUnit)).toBe(shown);
	});

	it.each([
		// [line discount typed, qty, rate]: the division does not come out even in cents
		[5, 3, 10],
		[10, 3, 10],
		[6.66, 4, 10],
		[1, 7, 1.99],
		[1.23, 12.5, 0.671],
	])("comes within |qty| × half a cent of $%s off %s × $%s", (line, qty, rate) => {
		const perUnit = perUnitDiscount(line, qty, rate, 3);
		const shown = round(qty * rate - line, 2);
		expect(Math.abs(serverLineAmount(qty, rate, perUnit) - shown)).toBeLessThanOrEqual(qty * 0.005 + 1e-9);
		// The nearest cent of the line discount over the quantity, or its neighbour.
		expect(Math.abs(perUnit - line / qty)).toBeLessThanOrEqual(0.01);
	});

	it("chooses the closer cent where the plain rounding is further off", () => {
		// $5 over 3: 1.67 posts 24.99, 1.66 would post 25.02.
		expect(perUnitDiscount(5, 3, 10, 3)).toBe(1.67);
		expect(serverLineAmount(3, 10, 1.67)).toBe(24.99);
	});

	it("is exact where the division comes out even", () => {
		expect(perUnitDiscount(10, 4, 10, 3)).toBe(2.5);
		expect(perUnitDiscount(10, 1, 10, 3)).toBe(10);
	});

	it("takes the quantity's size for a return line", () => {
		expect(perUnitDiscount(10, -4, 10, 3)).toBe(2.5);
	});

	it("is zero without a discount or a quantity", () => {
		expect(perUnitDiscount(0, 4, 10, 3)).toBe(0);
		expect(perUnitDiscount(10, 0, 10, 3)).toBe(0);
	});

	it("turns a posted per-unit discount back into the line's discount", () => {
		expect(lineDiscountFromPerUnit(2.5, 4)).toBe(10);
		expect(lineDiscountFromPerUnit(0.2, 12.5)).toBe(2.5);
		expect(lineDiscountFromPerUnit(2.5, -4)).toBe(10);
		expect(lineDiscountFromPerUnit(undefined, 4)).toBe(0);
	});
});

describe("a money line discount at the counter", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		useSettingsStore().currencyPrecision = { currency_precision: "2", float_precision: "3" };
	});

	it.each([
		// [qty, rate, typed line discount, line total shown]
		[1, 23.47, 3, 20.47],
		[4, 10, 10, 30],
		[4, 10, 6.6, 33.4],
		[12.5, 0.6, 2.5, 5],
	])("%s × $%s with $%s off charges the $%s shown", (qty, rate, typed, shown) => {
		const cart = useCartStore();
		cart.addItemWithDetails(product(rate), qty, rate);
		cart.updateItemDiscount(0, "amount", typed);

		// The screen: the line and the ticket show the typed discount off the whole line.
		expect(cart.items[0].discount_amount).toBe(typed);
		expect(round(cart.subtotal, 2)).toBe(shown);
		expect(round(cart.grandTotal, 2)).toBe(shown);

		// The payload: per unit, and the server's line comes to the same cent.
		const line = cart.getInvoiceData("POS-1", "SHIFT-1").items[0];
		expect(line.discount_amount).toBeCloseTo(typed / qty, 2);
		expect(serverLineAmount(qty, line.price_list_rate!, line.discount_amount!)).toBe(shown);
	});

	it("does not refuse a line whose discount is less than its total as zero-priced", () => {
		const cart = useCartStore();
		cart.addItemWithDetails(product(10), 4, 10);
		cart.updateItemDiscount(0, "amount", 10);
		expect(cart.pricingIssues).toEqual([]);

		cart.updateItemDiscount(0, "amount", 40);
		expect(cart.pricingIssues.join(" ")).toMatch(/zero price/);
	});

	it("shows a queued or posted sale's line discount again when it is loaded back", () => {
		const cart = useCartStore();
		cart.addItemWithDetails(product(10), 4, 10);
		cart.updateItemDiscount(0, "amount", 10);
		const queued = cart.getInvoiceData("POS-1", "SHIFT-1");
		expect(queued.items[0].discount_amount).toBe(2.5);

		cart.loadFromInvoice({ customer: "C-1", customer_name: "C-1", items: queued.items as never });

		expect(cart.items[0].discount_amount).toBe(10);
		expect(cart.subtotal).toBe(30);
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").items[0].discount_amount).toBe(2.5);
	});

	it("shows a Pricing Rule's per-unit money discount for the whole line and posts it per unit", async () => {
		const cart = useCartStore();
		cart.addItemWithDetails(product(10), 4, 10);
		vi.mocked(resolveCartPricing).mockResolvedValue({
			updates: [
				{
					row_id: cart.items[0].uid!,
					item_code: "ITEM-A",
					price_list_rate: 10,
					rate: 9,
					discount_percentage: 0,
					discount_amount: 1,
					margin_type: null,
					margin_rate_or_amount: 0,
					pricing_rules: ["PR-1"],
				},
			],
			free_lines: [],
			invoice_updates: {
				additional_discount_percentage: 0,
				discount_amount: 0,
				apply_discount_on: "Grand Total",
				from_pricing_rule: false,
			},
			source: "server",
		} as never);

		await cart.applyPricingRules();

		expect(cart.items[0].discount_amount).toBe(4);
		expect(cart.subtotal).toBe(36);
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").items[0].discount_amount).toBe(1);

		// A new quantity re-runs the rules (qty is in the pricing watcher's key); the
		// rule's $1 a unit then covers the whole new line.
		cart.updateItemQty(0, 6);
		await cart.applyPricingRules();
		expect(cart.items[0].discount_amount).toBe(6);
		expect(cart.subtotal).toBe(54);
		expect(cart.getInvoiceData("POS-1", "SHIFT-1").items[0].discount_amount).toBe(1);
	});

	it("leaves a percentage line discount as it was", () => {
		const cart = useCartStore();
		cart.addItemWithDetails(product(10), 4, 10);
		cart.updateItemDiscount(0, "percentage", 10);
		const line = cart.getInvoiceData("POS-1", "SHIFT-1").items[0];
		expect(line.discount_percentage).toBe(10);
		expect(line.discount_amount).toBe(0);
		expect(cart.subtotal).toBe(36);
	});
});
