/**
 * @vitest-environment jsdom
 *
 * MuleCity-9f4: before payment the register asks the server what the ticket will
 * post and charges that. A grain depositor's own grain goes on a $0 line at save,
 * so the cart's own sum ($128.10) overcharged a $48.04 ticket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [{ charge_type: "On Net Total", rate: 6.75, description: "Tax" }],
		taxInclusiveMode: false,
		disableRoundedTotal: true,
		profileName: "Mule City Retail",
		profile: { name: "Mule City Retail", warehouse: "Main - MCSF", currency: "USD" },
		currency: "USD",
		tenderModeFor: vi.fn(() => undefined),
	})),
}));

import { call } from "@/services/api";
import { useCartStore } from "@/stores/cartStore";

const PREVIEW = {
	items: [
		{ item_code: "CORN", item_name: "CORN", qty: 300, uom: "Pound", rate: 0.15, amount: 45, stored_grain: 0 },
		{ item_code: "CORNB-", item_name: "CORN FROM STORAGE", description: "From Brinson Farms's stored corn", qty: 500, uom: "Pound", rate: 0, amount: 0, stored_grain: 1 },
	],
	taxes: [{ description: "Tax", rate: 6.75, tax_amount: 3.04 }],
	net_total: 45,
	grand_total: 48.04,
	amount_due: 48.04,
};

function depositorCart() {
	const cart = useCartStore();
	cart.customer = { name: "Brinson Farms" };
	cart.items.push({ item_code: "CORN", item_name: "CORN", qty: 800, rate: 0.15, uom: "Pound", discount_percentage: 0, discount_amount: 0 });
	return cart;
}

describe("server-priced ticket before payment", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.mocked(call).mockReset();
	});

	it("charges the server's total and shows its $0 stored-grain line", async () => {
		const cart = depositorCart();
		expect(cart.grandTotal).toBeCloseTo(128.1, 2);
		vi.mocked(call).mockResolvedValueOnce(PREVIEW);

		await cart.openPaymentDialog();

		expect(vi.mocked(call).mock.calls[0][0]).toBe("xpos.api.invoices.preview_invoice");
		const sent = JSON.parse((vi.mocked(call).mock.calls[0][1] as { data: string }).data);
		expect(sent.payments).toBeUndefined();
		expect(sent.local_id).toBeUndefined();
		expect(cart.showPaymentDialog).toBe(true);
		expect(cart.grandTotal).toBe(48.04);
		expect(cart.serverLinesDiffer).toBe(true);
	});

	it("drops the preview as soon as the cart changes", async () => {
		const cart = depositorCart();
		vi.mocked(call).mockResolvedValueOnce(PREVIEW);
		await cart.openPaymentDialog();

		cart.items[0].qty = 100;

		expect(cart.grandTotal).toBeCloseTo(16.01, 2);
		expect(cart.serverLinesDiffer).toBe(false);
	});

	it("does not open payment when the server refuses the ticket", async () => {
		const cart = depositorCart();
		vi.mocked(call).mockRejectedValueOnce(new Error("Row 1: this grain can only go to its owner."));

		await cart.openPaymentDialog();

		expect(cart.showPaymentDialog).toBe(false);
		expect(cart.serverPreviewError).toContain("only go to its owner");
		expect(cart.grandTotal).toBeCloseTo(128.1, 2);
	});

	it("a cart the server leaves alone shows no extra lines", async () => {
		const cart = depositorCart();
		vi.mocked(call).mockResolvedValueOnce({
			...PREVIEW,
			items: [{ item_code: "CORN", item_name: "CORN", qty: 800, uom: "Pound", rate: 0.15, amount: 120 }],
			amount_due: 128.1,
		});
		await cart.openPaymentDialog();
		expect(cart.serverLinesDiffer).toBe(false);
		expect(cart.grandTotal).toBe(128.1);
	});
});
