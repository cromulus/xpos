/**
 * @vitest-environment jsdom
 *
 * User stories (Mule City MuleCity-mxwy.8): at the counter any bag can be
 * sold by the pound at bag price ÷ bag weight; the bag stays the default and
 * stock comes off by the pound. Switching a cart line between Bag and Pound
 * re-prices it with the server's price for the new unit (the rate the invoice
 * price lock posts), keeps its quantity and checks stock in the new unit.
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
		blockSaleBeyondAvailableQty: true,
		stockSettings: { allow_negative_stock: false },
	})),
}));

vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({
		updates: [],
		free_lines: [],
		invoice_updates: {
			additional_discount_percentage: 0,
			discount_amount: 0,
			apply_discount_on: "Grand Total",
			from_pricing_rule: false,
		},
		source: "server",
	})),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { call } from "@/services/api";
import { useCartStore } from "@/stores/cartStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { POSItem } from "@/types/pos.types";

const mockedCall = vi.mocked(call);

// A 35 lb bag at $23.47, stocked by the Bag (Pound = 1/35 at 9 places).
const POUND_FACTOR = 0.028571429;
const POUND_RATE = 0.670571439; // 23.47 × POUND_FACTOR at the invoice's 9 places

function feed(overrides: Partial<POSItem> = {}): POSItem {
	return {
		item_code: "MC-FEED35",
		item_name: "Test feed 35#",
		rate: 23.47,
		uom: "Bag",
		stock_uom: "Bag",
		conversion_factor: 1,
		item_group: "Feed",
		is_stock_item: true,
		actual_qty: 20,
		...overrides,
	} as POSItem;
}

function serverPrices(units: Record<string, { conversion_factor: number; rate: number }>) {
	mockedCall.mockImplementation(async (method: string, args?: Record<string, unknown>) => {
		if (method === "xpos.api.items.get_sale_unit") {
			const uom = String(args?.uom);
			if (!units[uom]) throw new Error(`${uom} is not a unit of MC-FEED35`);
			return { uom, ...units[uom] };
		}
		return undefined;
	});
}

describe("switching a cart line between Bag and Pound", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		// The site keeps 9 places on the invoice line rate (Mule City's setting).
		useSettingsStore().currencyPrecision = {
			currency_precision: "2",
			float_precision: "3",
			item_rate_precision: 9,
		};
		serverPrices({
			Bag: { conversion_factor: 1, rate: 23.47 },
			Pound: { conversion_factor: POUND_FACTOR, rate: POUND_RATE },
		});
	});

	it("a bag's weight in pounds costs exactly the bag price", async () => {
		const cart = useCartStore();
		cart.addItem(feed());

		const result = await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		cart.updateItemQty(0, 35);

		expect(result).toEqual({ success: true });
		expect(cart.items[0]).toMatchObject({ uom: "Pound", conversion_factor: POUND_FACTOR, rate: POUND_RATE, qty: 35 });
		expect(Math.round(cart.subtotal * 100) / 100).toBe(23.47);
		expect(mockedCall).toHaveBeenCalledWith("xpos.api.items.get_sale_unit", {
			item_code: "MC-FEED35",
			pos_profile: "Mule City Retail",
			uom: "Pound",
			customer: "",
		});
	});

	it("switching back to the Bag is the bag price again", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		await cart.changeItemUOM(0, { uom: "Bag", conversion_factor: 1 });
		expect(cart.items[0]).toMatchObject({ uom: "Bag", conversion_factor: 1, rate: 23.47 });
	});

	it("uses the server's price for the unit, the one the invoice will post", async () => {
		// E.g. a customer's own per-pound price: arithmetic from the bag would differ.
		serverPrices({
			Bag: { conversion_factor: 1, rate: 23.47 },
			Pound: { conversion_factor: POUND_FACTOR, rate: 0.6 },
		});
		const cart = useCartStore();
		cart.setCustomer({ name: "CUST-00338" });
		cart.addItem(feed());
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(cart.items[0].rate).toBe(0.6);
		expect(mockedCall.mock.calls[0][1]).toMatchObject({ customer: "CUST-00338" });
	});

	it("a pound-stocked counter bag (SALT) switches from Bag to Pound at the pound price", async () => {
		serverPrices({
			Bag: { conversion_factor: 50, rate: 11.5 },
			Pound: { conversion_factor: 1, rate: 0.23 },
		});
		const cart = useCartStore();
		cart.addItem(feed({ item_code: "MC-SALT", stock_uom: "Pound", uom: "Bag", conversion_factor: 50, rate: 11.5, actual_qty: 500 }));
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: 1 });
		expect(cart.items[0]).toMatchObject({ uom: "Pound", conversion_factor: 1, rate: 0.23 });
	});

	it("offline, the line keeps the same price per stock unit", async () => {
		mockedCall.mockRejectedValue(new Error("__offline__"));
		const cart = useCartStore();
		cart.addItem(feed());
		const result = await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(result.success).toBe(true);
		expect(cart.items[0].rate).toBe(POUND_RATE);
	});

	it("a rate the clerk changed by hand is converted, not replaced", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		cart.updateItemRate(0, 21);
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(mockedCall).not.toHaveBeenCalledWith("xpos.api.items.get_sale_unit", expect.anything());
		expect(cart.items[0].rate).toBeCloseTo(21 * POUND_FACTOR, 9);
	});

	it("a money discount per bag is not carried onto each pound; a percentage is kept", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		cart.addItem(feed({ item_code: "MC-FEED35-B" }));
		cart.items[0].discount_amount = 2;
		cart.items[1].discount_percentage = 10;
		serverPrices({ Pound: { conversion_factor: POUND_FACTOR, rate: POUND_RATE } });
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		await cart.changeItemUOM(1, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(cart.items[0].discount_amount).toBe(0);
		expect(cart.items[1].discount_percentage).toBe(10);
	});

	it("the last bag on the shelf can still be switched to pounds", async () => {
		// The line's own bag is released before the new unit is checked.
		const cart = useCartStore();
		cart.addItem(feed({ actual_qty: 1 }));
		const result = await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(result).toEqual({ success: true });
		expect(cart.updateItemQty(0, 35).success).toBe(true);
	});

	// ------------------------------------------------------------ negative stories
	it("refuses a switch that needs more stock than is on hand, and leaves the line", async () => {
		serverPrices({
			Bag: { conversion_factor: 50, rate: 11.5 },
			Pound: { conversion_factor: 1, rate: 0.23 },
		});
		const cart = useCartStore();
		// 30 lb of salt with 100 lb on hand; 30 Bags would be 1,500 lb.
		cart.addItem(feed({ item_code: "MC-SALT", stock_uom: "Pound", uom: "Pound", conversion_factor: 1, rate: 0.23, actual_qty: 100 }));
		cart.updateItemQty(0, 30);
		const result = await cart.changeItemUOM(0, { uom: "Bag", conversion_factor: 50 });
		expect(result.success).toBe(false);
		expect(cart.items[0]).toMatchObject({ uom: "Pound", conversion_factor: 1, rate: 0.23, qty: 30 });
	});

	it("refuses a unit the server says is not a unit of the Item", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		const result = await cart.changeItemUOM(0, { uom: "Ton", conversion_factor: 2000 });
		expect(result).toEqual({ success: false, message: expect.stringContaining("not a unit") });
		expect(cart.items[0]).toMatchObject({ uom: "Bag", rate: 23.47 });
	});

	it("never prices a Pound line at the bag price", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		await cart.changeItemUOM(0, { uom: "Pound", conversion_factor: POUND_FACTOR });
		expect(cart.items[0].rate).not.toBe(23.47);
	});
});
