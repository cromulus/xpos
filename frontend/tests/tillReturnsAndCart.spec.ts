/**
 * @vitest-environment jsdom
 *
 * Bill's walk-through with Grant, 2026-11-12 (MuleCity-rj2o):
 *  - a return of Practice Mill Farm's custom mix refunded $156.92 for a $130.77
 *    sale: the 2 free extra bags merged into the 10 paid ones at $12.25. Each sold
 *    row is now its own return line, at its own price, naming the row it refunds;
 *  - a past purchase can be added to the cart instead of replacing it;
 *  - a return refunds by cash, card, a check with its number, credit on the
 *    account, or a check the accountant mails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), showError: vi.fn(), showSuccess: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profile: { name: "Mule City Retail", warehouse: "Store - MCSF", currency: "USD" },
		profileName: "Mule City Retail",
		posOpeningShift: { name: "SHIFT-1" },
		currency: "USD",
		defaultCustomer: "Walk-in",
		tenderModeFor: vi.fn(() => undefined),
	})),
}));

import { useCartStore } from "@/stores/cartStore";
import { useTillReturn } from "@/composables/useTillReturn";
import { canRefundToAccount, isCheckMode, withCheckNumber } from "@/utils/refundMethod";

const MIX = "C1000000002-MIX-001";

describe("a return of a custom mix with free extra bags", () => {
	beforeEach(() => setActivePinia(createPinia()));

	it("keeps each sold row as its own line at its own price, naming the row", () => {
		const cart = useCartStore();
		const { startReturn } = useTillReturn();
		startReturn({ name: "ACC-SINV-52645", customer: "Practice mill Farm", customer_name: "Practice mill Farm" }, [
			{ name: "row-paid", item_code: MIX, item_name: "Practice hog mix", rate: 12.25, uom: "Bag", return_qty: 10 },
			{ name: "row-free", item_code: MIX, item_name: "Practice hog mix", rate: 0, uom: "Bag", return_qty: 2 },
		]);
		expect(cart.isReturnMode).toBe(true);
		expect(cart.returnAgainst).toBe("ACC-SINV-52645");
		expect(cart.items.map((i) => [i.qty, i.rate, i.sales_invoice_item])).toEqual([
			[-10, 12.25, "row-paid"],
			[-2, 0, "row-free"],
		]);
		// $122.50 back before tax, not $147.00.
		expect(cart.items.reduce((sum, i) => sum + i.qty * i.rate, 0)).toBe(-122.5);
		const sent = cart.getInvoiceData("Mule City Retail", "SHIFT-1").items;
		expect(sent.map((i) => i.sales_invoice_item)).toEqual(["row-paid", "row-free"]);
	});

	it("leaves out rows with nothing left to return", () => {
		const cart = useCartStore();
		useTillReturn().startReturn({ name: "INV-1", customer_name: "A" }, [
			{ name: "r1", item_code: MIX, item_name: "Mix", rate: 12.25, uom: "Bag", return_qty: 0 },
			{ name: "r2", item_code: MIX, item_name: "Mix", rate: 0, uom: "Bag", return_qty: 2 },
		]);
		expect(cart.items.map((i) => i.sales_invoice_item)).toEqual(["r2"]);
	});
});

describe("a past purchase added to the cart", () => {
	beforeEach(() => setActivePinia(createPinia()));

	it("keeps the cart's lines and customer", () => {
		const cart = useCartStore();
		cart.setCustomer({ name: "SOUTHERN-STATES", customer_name: "Southern States Co-op" });
		cart.items.push({ item_code: "SBM", item_name: "Soybean meal", qty: 2, rate: 20, uom: "Bag", discount_percentage: 0, discount_amount: 0 } as never);
		cart.addFromInvoice({
			customer: "OTHER",
			customer_name: "Other Farm",
			items: [{ item_code: "MP", item_name: "Max Nutrition Prime", qty: 15, rate: 22, uom: "Bag" }],
		});
		expect(cart.customer?.name).toBe("SOUTHERN-STATES");
		expect(cart.items.map((i) => [i.item_code, i.qty])).toEqual([["SBM", 2], ["MP", 15]]);
	});

	it("takes the purchase's customer when the cart has only the walk-in", () => {
		const cart = useCartStore();
		cart.setCustomer({ name: "Walk-in", customer_name: "Walk-in" });
		cart.addFromInvoice({ customer: "SOUTHERN-STATES", customer_name: "Southern States Co-op", items: [] });
		expect(cart.customer?.name).toBe("SOUTHERN-STATES");
	});
});

describe("how a return's money goes back", () => {
	it("knows a check by its name", () => {
		expect(isCheckMode("Check")).toBe(true);
		expect(isCheckMode("Cheque")).toBe(true);
		expect(isCheckMode("Cash")).toBe(false);
		expect(isCheckMode("Credit Card")).toBe(false);
	});

	it("puts the check's number on check rows only", () => {
		expect(
			withCheckNumber(
				[
					{ mode_of_payment: "Check", amount: -100 },
					{ mode_of_payment: "Cash", amount: -30.77 },
				],
				" 4417 ",
			),
		).toEqual([
			{ mode_of_payment: "Check", amount: -100, reference_no: "4417" },
			{ mode_of_payment: "Cash", amount: -30.77 },
		]);
	});

	it("offers credit on account and a mailed check only on an online return for a named customer", () => {
		const base = { isReturnMode: true, online: true, customer: "Practice mill Farm", defaultCustomer: "Walk-in" };
		expect(canRefundToAccount(base)).toBe(true);
		expect(canRefundToAccount({ ...base, online: false })).toBe(false);
		expect(canRefundToAccount({ ...base, isReturnMode: false })).toBe(false);
		expect(canRefundToAccount({ ...base, customer: "Walk-in" })).toBe(false);
	});
});
