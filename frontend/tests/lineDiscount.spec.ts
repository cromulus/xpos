/**
 * @vitest-environment jsdom
 *
 * User story (MuleCity-1msa): a cashier types a $ discount on a cart line and
 * the line shows that much off the whole line - $10 off 4 bags at $10 shows
 * -$10 and $30.00. The server posts a line's discount per unit, so the cart
 * sends $2.50 a bag, and the sale charges the $30.00 the screen showed, not
 * $0 (4 × $10 off). The same holds by the pound (12.5 lb) and where the
 * division does not come out even ($10 over 3 bags): the posted line comes to
 * the cent the screen shows. A sale queued offline posts the same payload, and
 * loading a posted or queued sale back into the cart shows the same line
 * discount again.
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
		profileName: "Mule City Retail",
		companyName: "Mule City",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - MC",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
		maxDiscountAllowed: 0,
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

// Per-pound price of a 35 lb bag at $23.47, at the invoice's 9 places.
const POUND_RATE = 0.670571439;

/** Half away from zero, as Frappe's Commercial Rounding. */
function round(value: number, places: number): number {
	const f = 10 ** places;
	return (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
}

/** The line amount the server posts: rate = price_list_rate − discount, amount = rate × qty. */
function serverLineAmount(qty: number, priceListRate: number, perUnit: number): number {
	return round(qty * round(priceListRate - perUnit, 9), 2);
}

function feed(rate: number, uom = "Bag"): POSItem {
	return {
		item_code: "MC-FEED",
		item_name: "Feed",
		rate,
		uom,
		stock_uom: uom,
		item_group: "Feed",
		is_stock_item: false,
	} as POSItem;
}

describe("perUnitDiscount", () => {
	it.each([
		// [line discount typed, qty, rate]
		[10, 1, 10],
		[10, 4, 10],
		[10, 3, 10],
		[1, 3, 3.335],
		[1.23, 12.5, POUND_RATE],
		[5, 12.5, POUND_RATE],
		[0.01, 7, 1.99],
		[1, 1, 3.335],
	])("posts $%s off %s × $%s to the cent the screen shows", (line, qty, rate) => {
		const perUnit = perUnitDiscount(line, qty, rate, 9);
		const shown = Math.round((qty * rate - line + Number.EPSILON) * 100) / 100;
		expect(serverLineAmount(qty, rate, perUnit)).toBe(shown);
		// Only the last places move: the per-unit figure is the line discount over the quantity.
		expect(Math.abs(perUnit - line / qty)).toBeLessThan(1e-6);
	});

	it("is exact where the division comes out even", () => {
		expect(perUnitDiscount(10, 4, 10, 9)).toBe(2.5);
		expect(perUnitDiscount(10, 1, 10, 9)).toBe(10);
		expect(perUnitDiscount(1, 12.5, POUND_RATE, 9)).toBe(0.08);
	});

	it("takes the quantity's size for a return line", () => {
		expect(perUnitDiscount(10, -4, 10, 9)).toBe(2.5);
	});

	it("is zero without a discount or a quantity", () => {
		expect(perUnitDiscount(0, 4, 10, 9)).toBe(0);
		expect(perUnitDiscount(10, 0, 10, 9)).toBe(0);
	});

	it("turns a posted per-unit discount back into the line's discount", () => {
		expect(lineDiscountFromPerUnit(2.5, 4)).toBe(10);
		expect(lineDiscountFromPerUnit(0.005, 12.5)).toBe(0.0625);
		expect(perUnitDiscount(lineDiscountFromPerUnit(0.005, 12.5), 12.5, POUND_RATE, 9)).toBe(0.005);
	});
});

describe("a $ line discount at the counter (MuleCity-1msa)", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		useSettingsStore().currencyPrecision = {
			currency_precision: "2",
			float_precision: "3",
			item_rate_precision: 9,
		};
	});

	it.each([
		// [qty, uom, rate, typed line discount, line total shown]
		[1, "Bag", 10, 10, 0],
		[1, "Bag", 23.47, 3, 20.47],
		[4, "Bag", 10, 10, 30],
		[3, "Bag", 10, 10, 20],
		[12.5, "Pound", POUND_RATE, 1.23, 7.15],
	])("%s %s at $%s with $%s off charges the $%s shown", (qty, uom, rate, typed, shown) => {
		const cart = useCartStore();
		cart.addItemWithDetails(feed(rate, uom), qty, rate, uom);
		cart.updateItemDiscount(0, "amount", typed);

		// The screen: the line and the ticket show the typed discount off the whole line.
		expect(cart.items[0].discount_amount).toBe(typed);
		expect(round(cart.subtotal, 2)).toBe(shown);
		expect(round(cart.grandTotal, 2)).toBe(shown);

		// The payload: per unit, and the server's line comes to the same cent.
		const line = cart.getInvoiceData("Mule City Retail", "SHIFT-1").items[0];
		expect(line.discount_amount).toBeCloseTo(typed / qty, 6);
		expect(serverLineAmount(qty, line.price_list_rate!, line.discount_amount!)).toBe(shown);
		// The line's discount the server posts is the one typed.
		expect(round(qty * line.price_list_rate! - serverLineAmount(qty, line.price_list_rate!, line.discount_amount!), 2)).toBe(
			typed,
		);
	});

	it("shows a queued or posted sale's line discount again when it is loaded back", () => {
		const cart = useCartStore();
		cart.addItemWithDetails(feed(10), 4, 10, "Bag");
		cart.updateItemDiscount(0, "amount", 10);
		const queued = cart.getInvoiceData("Mule City Retail", "SHIFT-1");

		cart.loadFromInvoice({ customer: "C-1", customer_name: "C-1", items: queued.items as never });

		expect(cart.items[0].discount_amount).toBe(10);
		expect(cart.subtotal).toBe(30);
		expect(cart.getInvoiceData("Mule City Retail", "SHIFT-1").items[0].discount_amount).toBe(2.5);
	});

	it("shows a Pricing Rule's per-unit $ discount for the whole line and posts it per unit", async () => {
		const cart = useCartStore();
		cart.addItemWithDetails(feed(10), 4, 10, "Bag");
		vi.mocked(resolveCartPricing).mockResolvedValue({
			updates: [
				{
					row_id: cart.items[0].uid!,
					item_code: "MC-FEED",
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
		expect(cart.items[0].pos_rule_rate).toBe(9);
		expect(cart.subtotal).toBe(36);
		expect(cart.getInvoiceData("Mule City Retail", "SHIFT-1").items[0].discount_amount).toBe(1);
	});

	it("leaves a % line discount as it was", () => {
		const cart = useCartStore();
		cart.addItemWithDetails(feed(10), 4, 10, "Bag");
		cart.updateItemDiscount(0, "percentage", 10);
		const line = cart.getInvoiceData("Mule City Retail", "SHIFT-1").items[0];
		expect(line.discount_percentage).toBe(10);
		expect(line.discount_amount).toBe(0);
		expect(cart.subtotal).toBe(36);
	});
});
