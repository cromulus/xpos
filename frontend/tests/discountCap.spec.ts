/**
 * @vitest-environment jsdom
 *
 * User story (MuleCity-mxwy.31): the POS Profile allows at most 25% off at the
 * counter. A cashier without the "Change Price" right types a discount - a line
 * discount in % or $, or an additional (whole-ticket) discount in % or $ - and
 * the screen stops her at the cap as she types, with "Max 25% at the counter",
 * instead of the server refusing the sale at Pay. Line and additional discounts
 * count together, measured from each line's price after Pricing Rules (a rule's
 * own discount does not count), as the server's check_discount_cap does. A user
 * who may change the price is not capped on screen; returns and free items are
 * exempt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

const rights = vi.hoisted(() => ({ allow_change_price: false }));

vi.mock("@/services/userRights", () => ({
	hasPermission: (key: string) => (key === "show_edit_discount_field" ? true : Boolean((rights as Record<string, boolean>)[key])),
}));

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
		maxDiscountAllowed: 25,
	})),
}));

vi.mock("@/stores/itemStore", () => ({
	useItemStore: () => ({ fetchItemDetail: vi.fn(async () => null) }),
}));

const resolveCartPricing = vi.fn();
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: (...args: unknown[]) => resolveCartPricing(...args),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { useCartStore } from "@/stores/cartStore";
import CartItem from "@/components/cart/CartItem.vue";
import type { POSItem } from "@/types/pos.types";

function posItem(code: string, rate: number): POSItem {
	return {
		item_code: code,
		item_name: code,
		rate,
		uom: "Nos",
		stock_uom: "Nos",
		item_group: "Products",
		is_stock_item: false,
	} as POSItem;
}

/** A $100 ticket: one $60 line and one $40 line. */
function hundredDollarTicket() {
	const cart = useCartStore();
	cart.addItem(posItem("FEED-A", 60));
	cart.addItem(posItem("FEED-B", 40));
	return cart;
}

describe("counter discount cap (25%)", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		rights.allow_change_price = false;
		resolveCartPricing.mockReset();
	});

	describe("line discounts", () => {
		it("accepts a $ line discount under the cap", () => {
			const cart = hundredDollarTicket();
			expect(cart.updateItemDiscount(0, "amount", 20)).toBe(20);
			expect(cart.items[0].discount_amount).toBe(20);
		});

		it("holds a $ line discount at the cap", () => {
			const cart = hundredDollarTicket();
			// 25% of the $100 ticket is $25, all of it available to one line.
			expect(cart.maxLineDiscount(0, "amount")).toBe(25);
			expect(cart.updateItemDiscount(0, "amount", 40)).toBe(25);
			expect(cart.items[0].discount_amount).toBe(25);
		});

		it("holds a $ line discount as money off the whole line (MuleCity-1msa)", () => {
			const cart = useCartStore();
			cart.addItemWithDetails(posItem("FEED-A", 10), 4, 10, "Nos");
			// 4 x $10: 25% is $10 off the line, as the cashier sees it; it posts as $2.50 a unit.
			expect(cart.maxLineDiscount(0, "amount")).toBe(10);
			expect(cart.updateItemDiscount(0, "amount", 40)).toBe(10);
			expect(cart.getInvoiceData("POS-PROFILE-1", "SHIFT-1").items[0].discount_amount).toBe(2.5);
		});

		it("lets a line take more than 25% while the ticket stays within it", () => {
			const cart = hundredDollarTicket();
			// $25 off a $40 line is 62.5% of the line, 25% of the ticket.
			expect(cart.maxLineDiscount(1, "percentage")).toBe(62.5);
		});
	});

	describe("additional (whole-ticket) discount", () => {
		it("accepts an additional % and $ under the cap", () => {
			const cart = hundredDollarTicket();
			expect(cart.setDiscount("percentage", 10)).toBe(10);
			expect(cart.discountPercentage).toBe(10);
			expect(cart.setDiscount("amount", 20)).toBe(20);
			expect(cart.discountAmount).toBe(20);
		});

		it("holds an additional % at the cap", () => {
			const cart = hundredDollarTicket();
			expect(cart.setDiscount("percentage", 40)).toBe(25);
			expect(cart.discountPercentage).toBe(25);
		});

		it("holds an additional $ at the cap", () => {
			const cart = hundredDollarTicket();
			expect(cart.setDiscount("amount", 60)).toBe(25);
			expect(cart.discountAmount).toBe(25);
		});
	});

	describe("line and additional discounts together", () => {
		it("leaves the additional discount only what the lines have not used", () => {
			const cart = hundredDollarTicket();
			cart.updateItemDiscount(0, "amount", 15);
			// $85 charged; the ticket may go down to $75, so $10 more.
			expect(cart.setDiscount("amount", 20)).toBe(10);
			expect(cart.maxAdditionalDiscount("percentage")).toBe(11.76);
		});

		it("leaves a line only what the additional discount has not used", () => {
			const cart = hundredDollarTicket();
			cart.setDiscount("percentage", 20);
			// $100 x 0.8 = $80; to stay at $75 the lines may charge $93.75, $6.25 off.
			expect(cart.updateItemDiscount(0, "amount", 10)).toBe(6.25);
		});

		it("allows nothing more once the ticket is at the cap", () => {
			const cart = hundredDollarTicket();
			cart.setDiscount("amount", 25);
			expect(cart.updateItemDiscount(1, "percentage", 5)).toBe(0);
		});
	});

	it("does not count a Pricing Rule's discount", async () => {
		const cart = useCartStore();
		cart.addItem(posItem("MIX-1", 100));
		resolveCartPricing.mockResolvedValue({
			updates: [
				{
					row_id: cart.items[0].uid,
					item_code: "MIX-1",
					price_list_rate: 100,
					rate: 80,
					discount_percentage: 20,
					discount_amount: 0,
					margin_rate_or_amount: 0,
					pricing_rules: ["PRLE-0001"],
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
		});
		await cart.applyPricingRules();
		expect(cart.items[0].pos_rule_rate).toBe(80);

		// The rule priced it at $80; 25% of that is $20, so the line may charge $60.
		expect(cart.updateItemDiscount(0, "amount", 50)).toBe(40);
		// The rule's price is remembered once a counter discount replaces it.
		expect(cart.maxAdditionalDiscount("amount")).toBe(0);
		expect(cart.maxLineDiscount(0, "amount")).toBe(40);
	});

	it("leaves free items out", () => {
		const cart = hundredDollarTicket();
		cart.items.push({ ...cart.items[0], item_code: "FREE", rate: 0, pos_is_free_item: true, uid: "free" });
		expect(cart.setDiscount("amount", 60)).toBe(25);
	});

	it("does not cap a user who may change the price", () => {
		rights.allow_change_price = true;
		const cart = hundredDollarTicket();
		expect(cart.discountCapActive).toBe(false);
		expect(cart.maxLineDiscount(0, "amount")).toBeNull();
		expect(cart.updateItemDiscount(0, "amount", 50)).toBe(50);
		expect(cart.setDiscount("percentage", 40)).toBe(40);
	});

	it("does not cap a return", () => {
		const cart = hundredDollarTicket();
		cart.enterReturnMode("SINV-0001");
		expect(cart.discountCapActive).toBe(false);
		expect(cart.setDiscount("amount", 60)).toBe(60);
		expect(cart.updateItemDiscount(0, "amount", 50)).toBe(50);
	});

	describe("as she types", () => {
		it("stops a $ line discount at the cap and says why", async () => {
			const cart = hundredDollarTicket();
			const wrapper = mount(CartItem, {
				props: { item: cart.items[0], index: 0, currencySymbol: "$" },
			});
			await flushPromises();
			// Open the line's discount box, switch to $, type 40.
			const toggle = wrapper.findAll("button").find((b) => b.text() === "Disc");
			await toggle!.trigger("click");
			const dollar = wrapper.findAll("button").find((b) => b.text() === "$");
			await dollar!.trigger("click");
			const input = wrapper.find('input[placeholder="0"][step="0.5"]');
			await input.setValue("40");
			await flushPromises();

			expect((input.element as HTMLInputElement).value).toBe("25");
			expect(wrapper.find('[data-testid="discount-cap-message"]').text()).toBe(
				"Max 25% at the counter",
			);

			// Typing back under the cap clears the message and keeps the value.
			await input.setValue("10");
			await flushPromises();
			expect((input.element as HTMLInputElement).value).toBe("10");
			expect(wrapper.find('[data-testid="discount-cap-message"]').exists()).toBe(false);
			wrapper.unmount();
		});
	});
});
