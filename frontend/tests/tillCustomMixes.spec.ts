/**
 * @vitest-environment jsdom
 *
 * User stories (Mule City MuleCity-zstm.20, mc23 walk 2026-10-02): every custom
 * mix showed "Out of Stock $0.00" and could not be put in the cart. Leslie now
 * sees Steve's goat mix as made to order at its recipe price and adds it; a mix
 * the site can't price says why instead of $0.00. Before Pay the cart says
 * whether the mill has the ingredients (the site's own counter quote). Ordering
 * needs the server: offline the till takes only made bags it has, at a price it
 * already knows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

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
		warehouse: "Main - MCSF",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: true,
		stockSettings: { allow_negative_stock: false },
		displayItemCode: false,
		hideImages: true,
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
import ItemCard from "@/components/items/ItemCard.vue";
import ItemListRow from "@/components/items/ItemListRow.vue";
import { mixCheckStatus } from "@/utils/mixCheck";
import type { POSItem } from "@/types/pos.types";

const mockedCall = vi.mocked(call);

function mix(overrides: Partial<POSItem> = {}): POSItem {
	return {
		item_code: "MC-MIX-STEVE",
		item_name: "Steve's goat mix",
		rate: 10,
		uom: "Bag",
		stock_uom: "Bag",
		conversion_factor: 1,
		item_group: "Custom Mix - Goat (G)",
		is_stock_item: true,
		actual_qty: 0,
		is_made_to_order: 1,
		...overrides,
	} as POSItem;
}

const QUOTE = { ticket_due: 0, orders_total: 16, orders: [{ item_code: "MC-MIX-STEVE", qty: 2, grand_total: 16 }], ticket: null };

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	online.value = true;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the item list shows a custom mix as made to order", () => {
	for (const [name, component] of [
		["card", ItemCard],
		["list row", ItemListRow],
	] as const) {
		it(`${name}: an unmade mix is not out of stock, shows its price and can be tapped`, async () => {
			const wrapper = mount(component as any, { props: { item: mix() } });
			expect(wrapper.text()).not.toContain("Out of Stock");
			expect(wrapper.text()).toContain("Made to order");
			expect(wrapper.text()).toContain("10.00");
			await wrapper.trigger("click");
			expect(wrapper.emitted("click")).toHaveLength(1);
		});

		it(`${name}: a mix the site couldn't price says so, never $0.00`, () => {
			const wrapper = mount(component as any, {
				props: { item: mix({ rate: 0, price_error: "Corn has no price in Standard Selling valid today" }) },
			});
			const note = wrapper.get('[data-testid="item-price-missing"]');
			expect(note.text()).toBe("No price");
			expect(note.attributes("title")).toContain("Corn has no price");
			expect(wrapper.text()).not.toContain("0.00");
		});
	}

	it("negative: an ordinary feed with no stock is still out of stock and can't be tapped", async () => {
		const wrapper = mount(ItemCard, { props: { item: mix({ is_made_to_order: 0, item_name: "Layer pellets" }) } });
		expect(wrapper.text()).toContain("Out of Stock");
		await wrapper.trigger("click");
		expect(wrapper.emitted("click")).toBeUndefined();
	});
});

describe("adding a custom mix to the cart", () => {
	it("an unmade mix goes in the cart as an order line at its recipe price", () => {
		const cart = useCartStore();
		expect(cart.addItem(mix())).toEqual({ success: true });
		expect(cart.items[0].rate).toBe(10);
		expect(cart.isOrderLine(cart.items[0].uid)).toBe(true);
	});

	it("negative: a mix with no price is refused with the site's reason", () => {
		const cart = useCartStore();
		const result = cart.addItem(mix({ rate: 0, price_error: "Corn has no price in Standard Selling valid today" }));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Corn has no price");
		expect(cart.items).toHaveLength(0);
		// The quantity dialog's path refuses it the same way.
		expect(cart.addItemWithDetails(mix({ rate: 0 }), 2, 0, "Bag").success).toBe(false);
	});

	it("negative: offline, an unmade mix can't be ordered", () => {
		online.value = false;
		const cart = useCartStore();
		const result = cart.addItem(mix());
		expect(result).toEqual({
			success: false,
			message: "Custom mixes can't be ordered offline. Go online, or take the order at the desk.",
		});
	});

	it("offline, a made bag on hand at a known price still sells; the next one is refused", () => {
		online.value = false;
		const cart = useCartStore();
		expect(cart.addItem(mix({ actual_qty: 1 })).success).toBe(true);
		expect(cart.hasOrderLines).toBe(false);
		expect(cart.addItemWithDetails(mix({ actual_qty: 1 }), 1, 10, "Bag").success).toBe(false);
	});

	it("negative: offline, a mix with no cached price says it can't be priced offline", () => {
		online.value = false;
		const cart = useCartStore();
		expect(cart.addItem(mix({ rate: 0, actual_qty: 3 })).message).toBe(
			"Steve's goat mix can't be priced offline. Go online to sell it.",
		);
	});
});

describe("the cart says whether the mix can be made before Pay", () => {
	it("asks the site's counter quote once a pickup date is chosen, and shows the order's price", async () => {
		vi.useFakeTimers();
		mockedCall.mockImplementation(async (method: string) =>
			method === "mulecity_erpnext.counter_mix_orders.counter_quote" ? QUOTE : undefined,
		);
		const cart = useCartStore();
		cart.addItem(mix());
		await vi.advanceTimersByTimeAsync(700);
		expect(mockedCall.mock.calls.some(([m]) => m === "mulecity_erpnext.counter_mix_orders.counter_quote")).toBe(false);
		cart.pickupDate = "2026-10-05";
		await vi.advanceTimersByTimeAsync(700);
		const quotes = mockedCall.mock.calls.filter(([m]) => m === "mulecity_erpnext.counter_mix_orders.counter_quote");
		expect(quotes).toHaveLength(1);
		expect(JSON.parse((quotes[0][1] as { data: string }).data).pickup_date).toBe("2026-10-05");
		expect(cart.mixCheckPending).toBe(false);
		expect(cart.mixCheckError).toBe("");
		expect(cart.counterQuote?.orders_total).toBe(16);
	});

	it("negative: short ingredients are shown in the cart, from the site's refusal", async () => {
		vi.useFakeTimers();
		mockedCall.mockImplementation(async (method: string) => {
			if (method === "mulecity_erpnext.counter_mix_orders.counter_quote") {
				throw new Error("Short ingredients: MC-CORN: 40 lb at Main - MCSF");
			}
			return undefined;
		});
		const cart = useCartStore();
		cart.pickupDate = "2026-10-05";
		cart.addItem(mix());
		await vi.advanceTimersByTimeAsync(700);
		expect(cart.mixCheckError).toContain("Short ingredients: MC-CORN: 40 lb");
		expect(cart.counterQuote).toBeNull();
	});

	it("the cart's line reads the check", () => {
		const money = (n: number) => `$${n.toFixed(2)}`;
		const base = { online: true, pickupDate: "2026-10-05", pending: false, error: "", ordersTotal: null };
		expect(mixCheckStatus({ ...base, pickupDate: "" }, money).text).toBe(
			"Choose a pickup date to check the mix's ingredients and price the order.",
		);
		expect(mixCheckStatus({ ...base, pending: true }, money).text).toBe("Checking the mix's ingredients…");
		expect(mixCheckStatus({ ...base, ordersTotal: 16 }, money)).toEqual({
			text: "Ingredients on hand. Mix order $16.00.",
			tone: "info",
		});
		expect(mixCheckStatus({ ...base, error: "Short ingredients: corn" }, money)).toEqual({
			text: "Can't order yet: Short ingredients: corn",
			tone: "bad",
		});
		expect(mixCheckStatus({ ...base, online: false }, money).tone).toBe("bad");
	});
});
