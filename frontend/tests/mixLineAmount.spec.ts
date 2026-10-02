/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-ra6h, mc26 staging walk 2026-10-02): Treehouse
 * Treasures Mix 4AC2EE, 100 lb, for a test customer. The recipe price is
 * $0.291628665/lb and the Cattle (CB) mixing rate takes $0.04/lb off, so the
 * order bills 100 x 0.251628665 = $25.16. The cart line said $25.20: the web
 * till read its settings from the page's boot, which had no line-rate
 * precision, so the cart rounded the rate to 3 places (0.292 - 0.04 = 0.252).
 *
 * Now the boot carries the 9 places, so the cart's own figure is $25.16; and
 * once the site's check is in, the mix line, the summary and Pay show the
 * order's own amount, with "Checking…" until then: Pay never takes the cart's
 * own sum for a mix order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { online } = vi.hoisted(() => ({ online: { value: true } }));

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
	cacheTaxContext: vi.fn(async () => undefined),
	getCachedTaxContext: vi.fn(async () => null),
	getCachedCategoryTaxContext: vi.fn(async () => null),
	cacheERPSettings: vi.fn(async () => undefined),
	getCachedERPSettings: vi.fn(async () => null),
}));
vi.mock("@/utils", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isOnline: () => online.value }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [{ charge_type: "On Net Total", rate: 6.75, account_head: "Sales Tax - MCSF", description: "Sales Tax" }],
		taxInclusiveMode: false,
		profileName: "Mule City Retail",
		companyName: "Mule City",
		sellingPriceList: "Standard Selling",
		warehouse: "Main - MCSF",
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
		invoice_updates: { additional_discount_percentage: 0, discount_amount: 0, apply_discount_on: "Grand Total", from_pricing_rule: false },
		source: "server",
	})),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { call } from "@/services/api";
import { useCartStore } from "@/stores/cartStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { POSItem } from "@/types/pos.types";

const mockedCall = vi.mocked(call);
const POUND_PRICE = 0.291628665;
const CHECK = "mulecity_erpnext.counter_mix_orders.counter_check";
// What the site's check answers for the 100 lb line: ERPNext's own pricing of the order.
const CHECKED = {
	ticket_due: 0,
	orders_total: 25.16,
	ticket: null,
	orders: [
		{ item_code: "MC-MIX-TT", qty: 100, uom: "Pound", line_index: 0, rate: 0.251628665, amount: 25.16, net_total: 25.16, taxes: 0, grand_total: 25.16 },
	],
};

function mix(): POSItem {
	return {
		item_code: "MC-MIX-TT",
		item_name: "Treehouse Treasures Mix 4AC2EE",
		rate: POUND_PRICE,
		uom: "Pound",
		stock_uom: "Pound",
		conversion_factor: 1,
		item_group: "Custom Mix - Cattle (CB)",
		is_stock_item: true,
		actual_qty: 0,
		is_made_to_order: 1,
	} as POSItem;
}

/** The web till's boot as the site sends it (``boot`` lacks ``currency_precision`` on an older site). */
async function bootTill(currencyPrecision?: Record<string, unknown>) {
	(window as any).xpos = {
		boot: {
			selling_settings: { selling_price_list: "Standard Selling" },
			sysdefaults: { float_precision: "3", currency_precision: "2" },
			...(currencyPrecision ? { currency_precision: currencyPrecision } : {}),
		},
	};
	await useSettingsStore().fetchSettings();
}

/** 100 lb of the mix, $0.04/lb off by the Cattle (CB) rule ($4.00 on the line). */
function hundredPounds() {
	const cart = useCartStore();
	expect(cart.addItem(mix()).success).toBe(true);
	expect(cart.updateItemQty(0, 100).success).toBe(true);
	cart.items[0].discount_amount = 4;
	return cart;
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	online.value = true;
});

afterEach(() => {
	vi.useRealTimers();
	delete (window as any).xpos;
});

describe("the web till keeps the line rate the order keeps", () => {
	it("the boot's 9 places: the cart's own line is $25.16, as the order bills", async () => {
		await bootTill({ currency_precision: "2", float_precision: "3", item_rate_precision: 9 });
		const cart = hundredPounds();
		expect(cart.itemRatePrecision).toBe(9);
		expect(cart.items[0].rate).toBe(POUND_PRICE);
		expect(Math.round(cart.subtotal * 100) / 100).toBe(25.16);
	});

	it("negative: a boot with no line precision rounds to 3 places, the 4-cent gap the walk saw", async () => {
		await bootTill();
		const cart = hundredPounds();
		expect(cart.itemRatePrecision).toBe(3);
		expect(cart.items[0].rate).toBe(0.292);
		expect(Math.round(cart.subtotal * 100) / 100).toBe(25.2);
	});
});

describe("once the site checked the mix, the cart shows what the order bills", () => {
	it("the line, the summary and Pay take the order's $25.16 even if the cart's own sum says $25.20", async () => {
		vi.useFakeTimers();
		await bootTill(); // the stale boot: the cart's own figure is off by 4 cents
		mockedCall.mockImplementation(async (method: string) => (method === CHECK ? CHECKED : undefined));
		const cart = hundredPounds();
		cart.pickupDate = "2026-10-05";
		await vi.advanceTimersByTimeAsync(700);
		const uid = cart.items[0].uid;
		expect(cart.quotedLineAmount(uid)).toBe(25.16);
		expect(cart.lineChecking(uid)).toBe(false);
		expect(cart.summarySubtotal).toBe(25.16);
		// The order carries no tax of its own here: the summary shows none, though the cart estimated 6.75%.
		expect(cart.calculatedTaxes.length).toBe(1);
		expect(cart.summaryTaxes).toEqual([]);
		cart.mixPayMode = "now";
		expect(cart.grandTotal).toBe(25.16);
	});

	it("while the site is checking, the line and Pay say Checking, never the cart's own sum", async () => {
		vi.useFakeTimers();
		await bootTill();
		let answer: (value: unknown) => void = () => undefined;
		mockedCall.mockImplementation((method: string) =>
			method === CHECK ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(undefined),
		);
		const cart = hundredPounds();
		cart.pickupDate = "2026-10-05";
		await vi.advanceTimersByTimeAsync(700);
		const uid = cart.items[0].uid;
		expect(cart.lineChecking(uid)).toBe(true);
		expect(cart.mixPriceChecking).toBe(true);
		expect(cart.quotedLineAmount(uid)).toBeNull();
		answer(CHECKED);
		await vi.advanceTimersByTimeAsync(0);
		expect(cart.mixPriceChecking).toBe(false);
		expect(cart.quotedLineAmount(uid)).toBe(25.16);
	});

	it("negative: the cart changes after the check: the line drops the old answer and checks again", async () => {
		vi.useFakeTimers();
		await bootTill();
		mockedCall.mockImplementation(async (method: string) => (method === CHECK ? CHECKED : undefined));
		const cart = hundredPounds();
		cart.pickupDate = "2026-10-05";
		await vi.advanceTimersByTimeAsync(700);
		const uid = cart.items[0].uid;
		cart.updateItemQty(0, 200);
		await vi.advanceTimersByTimeAsync(0);
		expect(cart.quotedLineAmount(uid)).toBeNull();
		expect(cart.lineChecking(uid)).toBe(true);
	});

	it("an order's own tax is shown as the order's, so the summary adds up to the total", async () => {
		vi.useFakeTimers();
		await bootTill({ item_rate_precision: 9 });
		const taxed = { ...CHECKED, orders_total: 26.86, orders: [{ ...CHECKED.orders[0], taxes: 1.7, grand_total: 26.86 }] };
		mockedCall.mockImplementation(async (method: string) => (method === CHECK ? taxed : undefined));
		const cart = hundredPounds();
		cart.pickupDate = "2026-10-05";
		await vi.advanceTimersByTimeAsync(700);
		expect(cart.summaryTaxes).toEqual([
			{ description: "Tax on mix orders", rate: 0, amount: 1.7, included_in_print_rate: false },
		]);
		cart.mixPayMode = "now";
		expect(cart.summarySubtotal + cart.summaryTaxes[0].amount).toBeCloseTo(cart.grandTotal, 2);
	});
});
