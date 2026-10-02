/**
 * @vitest-environment jsdom
 *
 * User stories (Mule City MuleCity-3j1m): Leslie puts Steve's goat mix in the cart
 * like any feed. The part the mill still has to make is marked "Order"; at Pay the
 * site prices today's ticket and the order separately, and she takes the money now
 * (an advance on the order) or leaves it for pickup. Orders need the server: an
 * offline till refuses them, and a pickup date is required.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const { online } = vi.hoisted(() => ({ online: { value: true } }));

vi.mock("@/services/api", () => ({
	call: vi.fn(),
	default: { call: vi.fn() },
}));

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
	cacheTaxContext: vi.fn(async () => undefined),
	getCachedTaxContext: vi.fn(async () => null),
	getCachedCategoryTaxContext: vi.fn(async () => null),
}));

vi.mock("@/utils", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	isOnline: () => online.value,
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
import type { POSItem } from "@/types/pos.types";

const mockedCall = vi.mocked(call);

function feed(overrides: Partial<POSItem> = {}): POSItem {
	return {
		item_code: "MC-FEED",
		item_name: "Natural Layer",
		rate: 10,
		uom: "Nos",
		stock_uom: "Nos",
		conversion_factor: 1,
		item_group: "Feed",
		is_stock_item: true,
		actual_qty: 20,
		...overrides,
	} as POSItem;
}

function mix(overrides: Partial<POSItem> = {}): POSItem {
	return feed({ item_code: "MC-MIX-STEVE", item_name: "Steve's goat mix", rate: 20, actual_qty: 0, is_made_to_order: 1, ...overrides });
}

const QUOTE = { ticket_due: 10, orders_total: 40, orders: [{ item_code: "MC-MIX-STEVE", qty: 2, grand_total: 40 }], ticket: null };

describe("a custom mix ordered at the counter", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		online.value = true;
		mockedCall.mockImplementation(async (method: string) =>
			method === "mulecity_erpnext.counter_mix_orders.counter_quote" ? QUOTE : undefined,
		);
	});

	it("marks the unmade mix line as an order, not the feed on hand", () => {
		const cart = useCartStore();
		cart.addItem(feed());
		cart.addItem(mix());
		const [feedLine, mixLine] = cart.items;
		expect(cart.hasOrderLines).toBe(true);
		expect(cart.isOrderLine(mixLine.uid)).toBe(true);
		expect(cart.isOrderLine(feedLine.uid)).toBe(false);
	});

	it("negative: a mix with enough made bags on hand is an ordinary sale", () => {
		const cart = useCartStore();
		cart.addItem(mix({ actual_qty: 5 }));
		expect(cart.hasOrderLines).toBe(false);
	});

	it("negative: a picked-up order's line is billed, not ordered again", () => {
		const cart = useCartStore();
		cart.addItem(mix());
		(cart.items[0] as any).so_detail = "SO-ROW-1";
		expect(cart.hasOrderLines).toBe(false);
	});

	it("prices today's ticket and the order at Pay, and charges the order only when paid now", async () => {
		const cart = useCartStore();
		cart.addItem(feed());
		cart.addItem(mix(), 2);
		cart.pickupDate = "2026-10-02";
		await cart.openPaymentDialog();
		expect(mockedCall).toHaveBeenCalledWith(
			"mulecity_erpnext.counter_mix_orders.counter_quote",
			expect.objectContaining({ data: expect.stringContaining('"pickup_date":"2026-10-02"') }),
			undefined,
			// Its refusal is an answer, kept out of the error badge (MuleCity-ra6h).
			expect.objectContaining({ answers: expect.any(Function) }),
		);
		expect(cart.showPaymentDialog).toBe(true);
		expect(cart.grandTotal).toBe(50);
		cart.mixPayMode = "pickup";
		expect(cart.grandTotal).toBe(10);
	});

	it("negative: no pickup date, no Pay", async () => {
		const cart = useCartStore();
		cart.addItem(mix());
		await cart.openPaymentDialog();
		expect(cart.showPaymentDialog).toBe(false);
		expect(cart.serverPreviewError).toMatch(/pickup date/);
	});

	it("negative: an offline till refuses a mix order", async () => {
		const cart = useCartStore();
		cart.addItem(mix());
		cart.pickupDate = "2026-10-02";
		online.value = false;
		await cart.openPaymentDialog();
		expect(cart.showPaymentDialog).toBe(false);
		expect(cart.serverPreviewError).toMatch(/can't be ordered offline/);
		expect(mockedCall).not.toHaveBeenCalledWith("mulecity_erpnext.counter_mix_orders.counter_quote", expect.anything());
	});

	it("a new cart forgets the pickup date and the pay choice", async () => {
		const cart = useCartStore();
		cart.addItem(mix());
		cart.pickupDate = "2026-10-02";
		cart.mixPayMode = "pickup";
		cart.clearCart();
		expect([cart.pickupDate, cart.mixPayMode, cart.counterQuote]).toEqual(["", "now", null]);
	});
});
