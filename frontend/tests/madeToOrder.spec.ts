/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-3j1m): a customer's custom mix is made to order.
 * With "block sale beyond available qty" on, the counter can still put an unmade
 * mix (no stock) in the cart; an ordinary item with no stock is still refused.
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

function mix(overrides: Partial<POSItem> = {}): POSItem {
	return feed({ item_code: "MC-MIX-BEN", item_name: "Ben's goat mix", actual_qty: 0, is_made_to_order: 1, ...overrides });
}

describe("a made-to-order mix at the counter", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		mockedCall.mockResolvedValue(undefined);
	});

	it("an unmade mix with no stock can be added to the cart", () => {
		const cart = useCartStore();
		expect(cart.canAddItem(mix())).toEqual({ allowed: true });
	});

	it("an ordinary item with no stock is still refused", () => {
		const cart = useCartStore();
		expect(cart.canAddItem(feed({ actual_qty: 0 })).allowed).toBe(false);
	});

	it("a stock recheck at Pay passes a made-to-order line the server says has none", async () => {
		mockedCall.mockImplementation(async (method: string) =>
			method === "xpos.api.items.get_stock_availability"
				? [{ item_code: "MC-MIX-BEN", actual_qty: 0 }, { item_code: "MC-FEED35", actual_qty: 0 }]
				: undefined,
		);
		const cart = useCartStore();
		cart.addItem(mix());
		expect((await cart.revalidateStock()).valid).toBe(true);
	});

	it("negative: the same recheck still refuses an ordinary line that sold out", async () => {
		const cart = useCartStore();
		cart.addItem(feed({ actual_qty: 5 }));
		mockedCall.mockImplementation(async (method: string) =>
			method === "xpos.api.items.get_stock_availability" ? [{ item_code: "MC-FEED35", actual_qty: 0 }] : undefined,
		);
		expect((await cart.revalidateStock()).valid).toBe(false);
	});
});
