/**
 * @vitest-environment jsdom
 *
 * "Pay balance" at the counter (Bill 2026-11-05, MuleCity-biez).
 *
 * User stories: Leslie picks Albert Adkins, who owes $120.50. She adds "Pay
 * balance" (from item search, or the customer's "Pay balance $120.50" button);
 * it starts at the whole balance and she can type less. It sits in the cart as
 * its own line, never taxed or discounted, beside any feed he buys, and Pay
 * takes the whole cart with the normal tenders. The site posts the balance as
 * Payment Entries (never a sale). Offline, for the walk-in account, in a return
 * or on the card reader it is refused with the reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const state = vi.hoisted(() => ({ online: true, call: vi.fn(), settle: true }));

vi.mock("@/services/api", () => ({ call: state.call, isNetworkError: () => false, showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/utils", async (importOriginal) => ({ ...(await importOriginal<object>()), isOnline: () => state.online }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [{ account_head: "Sales Tax", rate: 6.75, charge_type: "On Net Total", included_in_print_rate: 0, description: "Sales Tax" }],
		taxInclusiveMode: false,
		disableRoundedTotal: true,
		currency: "USD",
		tenderModeFor: vi.fn(),
		defaultCustomer: "Walk-In",
		profileName: "Mule City Counter",
		posOpeningShift: { name: "SHIFT-1" },
		get allowOutstandingSettlement() {
			return state.settle;
		},
	})),
}));
vi.mock("@/lib/translate", () => {
	const __ = (text: string, args: string[] = []) => args.reduce((out, arg, i) => out.replace(`{${i}}`, arg), text);
	return { __, default: __ };
});

import { useCartStore } from "@/stores/cartStore";
import { cardPayBlockReason } from "@/services/cardTerminal";

const SETTINGS = {
	item_code: "MC-ITEM-PAYBAL",
	item_name: "Pay balance",
	checkout_method: "mulecity_erpnext.counter_balance_payment.counter_pay_balance",
	receipt_format: "Mule Payment Receipt",
};
const PAYBAL_ITEM = { item_code: "MC-ITEM-PAYBAL", item_name: "Pay balance", stock_uom: "Nos", rate: 0, is_stock_item: 0 };
const FEED = { uid: "r1", item_code: "FEED-50", item_name: "Layer feed 50 lb", qty: 2, rate: 18, uom: "Bag", stock_uom: "Bag", conversion_factor: 1, discount_percentage: 0, discount_amount: 0 };

async function counter(customer = "MC-CUST-4112") {
	const cart = useCartStore();
	state.call.mockImplementation(async (method: string) => {
		if (method.endsWith("get_pay_balance_settings")) return SETTINGS;
		throw new Error(`unexpected ${method}`);
	});
	await cart.loadPayBalanceSettings();
	cart.setCustomer({ name: customer, customer_name: "Albert Adkins" } as never);
	return cart;
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	state.online = true;
	state.settle = true;
});

describe("Pay balance is a cart line, paid with the cart's tenders", () => {
	it("picking the item opens its amount; alone it is the whole cart, untaxed", async () => {
		const cart = await counter();
		expect(cart.addItem(PAYBAL_ITEM as never)).toEqual({ success: true });
		expect(cart.showPayBalanceDialog).toBe(true);
		expect(cart.items).toHaveLength(0);
		cart.setPayBalance(120.5);
		expect(cart.isEmpty).toBe(false);
		expect(cart.calculatedTaxes).toEqual([]);
		expect(cart.grandTotal).toBe(120.5);
		const sent = cart.getInvoiceData("Mule City Counter", "SHIFT-1");
		expect(sent.items).toEqual([expect.objectContaining({ item_code: "MC-ITEM-PAYBAL", qty: 1, rate: 120.5 })]);
	});

	it("with feed: tax is on the feed only, the total adds the payment, the sale is previewed without it", async () => {
		const cart = await counter();
		cart.items.push({ ...FEED } as never);
		cart.setPayBalance(50);
		// $36 of feed + 6.75% = $38.43, plus $50 on account.
		expect(cart.calculatedTaxes.map((t) => t.amount)).toEqual([2.43]);
		expect(cart.goodsTotal).toBe(38.43);
		expect(cart.grandTotal).toBe(88.43);
		const sent = cart.getInvoiceData("Mule City Counter", "SHIFT-1");
		expect(sent.items.map((line) => [line.item_code, line.qty, line.rate])).toEqual([["FEED-50", 2, 18], ["MC-ITEM-PAYBAL", 1, 50]]);
		const preview = cart.previewPayload();
		expect(preview.items!.map((line: { item_code: string }) => line.item_code)).toEqual(["FEED-50"]);
	});

	it("a part payment: the amount is typed in cents; a cart discount never touches it", async () => {
		const cart = await counter();
		cart.items.push({ ...FEED } as never);
		cart.setPayBalance(40.005);
		expect(cart.payBalanceAmount).toBe(40.01);
		cart.setDiscount("percentage", 10);
		expect(cart.payBalanceAmount).toBe(40.01);
		expect(cart.grandTotal).toBe(Math.round((cart.goodsTotal + 40.01) * 100) / 100);
	});

	it("another customer drops it; clearing the cart drops it", async () => {
		const cart = await counter();
		cart.setPayBalance(10);
		cart.setCustomer({ name: "MC-CUST-9", customer_name: "Other" } as never);
		expect(cart.hasPayBalance).toBe(false);
		cart.setPayBalance(10);
		cart.clearCart();
		expect(cart.hasPayBalance).toBe(false);
	});
});

describe("Pay balance is refused with the reason", () => {
	it("the walk-in account, offline, a return, or no right to settle", async () => {
		let cart = await counter("Walk-In");
		expect(cart.addItem(PAYBAL_ITEM as never).message).toMatch(/never the walk-in/);
		cart = await counter();
		state.online = false;
		expect(cart.addItem(PAYBAL_ITEM as never).message).toMatch(/needs the till online/);
		state.online = true;
		state.settle = false;
		expect(cart.addItem(PAYBAL_ITEM as never).message).toMatch(/not permitted/);
		state.settle = true;
		cart.enterReturnMode("ACC-SINV-1");
		expect(cart.addItem(PAYBAL_ITEM as never).message).toMatch(/can't be returned at the till/);
		expect(cart.items).toHaveLength(0);
	});

	it("the card reader does not take it", () => {
		const reason = cardPayBlockReason({
			config: { enabled: true } as never, online: true, electron: false, isReturn: false, onAccount: false,
			hasOrderLines: false, paysBalance: true, billsAnOrder: false, redeemsPoints: false, writeOff: 0,
			total: 50, cash: 0, nonCashLegs: [], foreignTender: false,
		});
		expect(reason).toMatch(/balance payment is not taken on the card reader/);
	});
});
