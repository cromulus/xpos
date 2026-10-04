/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-3urg, MuleCity-af3t; Bill 2026-10-02: prepaid
 * mix orders ARE taxed). The mc27 walk: Treehouse Treasures Mix 4AC2EE, 10 lb,
 * for a taxable customer. The order carried no tax, yet the Pay dialog's
 * breakdown showed "Sales Tax 6.75% +$0.17" from the till's own estimate;
 * Amount Due was the order's $2.52. Now the site taxes the order itself
 * (Tax Rule) and the cart and Pay show the order's own tax and total from
 * ``counter_check`` / ``counter_quote``; the till never estimates a mix
 * order's tax. Pay now prepays the order's grand total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/services/api", () => ({
	call: mocks.call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
	isNetworkError: vi.fn(() => false),
	default: { call: mocks.call },
}));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printInvoice: vi.fn(), printInvoiceLocal: vi.fn() }),
}));
vi.mock("@/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils")>()),
	isOnline: () => true,
}));

import PaymentDialog from "@/components/dialogs/PaymentDialog.vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";

const CHECK = "mulecity_erpnext.counter_mix_orders.counter_check";

/** The site's answer for 10 lb at $0.252/lb: $2.52, and the order's own tax. */
function answer(tax: number) {
	const grand = Math.round((2.52 + tax) * 100) / 100;
	return {
		ticket_due: 0,
		orders_total: grand,
		ticket: null,
		orders: [
			{ item_code: "MC-MIX-TT", qty: 10, uom: "Pound", line_index: 0, rate: 0.252, amount: 2.52, net_total: 2.52, taxes: tax, grand_total: grand },
		],
	};
}

async function cartWithMix(tax: number) {
	mocks.call.mockImplementation(async (method: string) => (method === CHECK ? answer(tax) : undefined));
	const pos = usePosStore();
	// The till's tax context for this customer: 6.75%. The cart's own estimate uses it.
	pos.taxes = [{ charge_type: "On Net Total", rate: 6.75, account_head: "NC Sales Tax Payable - MCSF", description: "Sales Tax" }] as never;
	pos.posProfile = { name: "Mule City Retail", payments: [{ mode_of_payment: "Cash", default: 1 }] } as never;
	const cart = useCartStore();
	cart.customer = { name: "MC23 Walk Test 0" } as never;
	cart.items.push({
		uid: "mix-1",
		item_code: "MC-MIX-TT",
		item_name: "Treehouse Treasures Mix 4AC2EE",
		qty: 10,
		rate: 0.252,
		uom: "Pound",
		stock_uom: "Pound",
		conversion_factor: 1,
		actual_qty: 0,
		is_made_to_order: 1,
		discount_percentage: 0,
		discount_amount: 0,
	} as never);
	cart.pickupDate = "2026-10-05";
	await vi.advanceTimersByTimeAsync(700);
	cart.mixPayMode = "now";
	return cart;
}

const NumberInput = defineComponent({
	setup(_props, { expose }) {
		expose({ focus: () => undefined, setValue: () => undefined });
		return () => h("input", { "data-testid": "amount" });
	},
});

async function openPay() {
	const cart = useCartStore();
	cart.showPaymentDialog = true;
	const wrapper = shallowMount(PaymentDialog, {
		attachTo: document.body,
		global: { renderStubDefaultSlot: true, stubs: { NumberInput, Input: false } },
	});
	await flushPromises();
	return wrapper;
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("a mix order's tax is the order's own, never the till's estimate", () => {
	it("an untaxed order: Pay shows no tax line, though the till's context is 6.75%", async () => {
		const cart = await cartWithMix(0);
		expect(cart.calculatedTaxes.length).toBe(1); // the estimate the walk saw
		expect(cart.summaryTaxes).toEqual([]);
		expect(cart.grandTotal).toBe(2.52);
		const wrapper = await openPay();
		expect(wrapper.text()).not.toContain("Sales Tax");
		expect(wrapper.text()).not.toContain("+0.17");
		wrapper.unmount();
	});

	it("a taxed order: Pay shows the order's subtotal and tax, adding up to what Pay now prepays", async () => {
		const cart = await cartWithMix(0.17);
		expect(cart.grandTotal).toBe(2.69);
		expect(cart.summarySubtotal + cart.summaryTaxes[0].amount).toBeCloseTo(cart.grandTotal, 2);
		const wrapper = await openPay();
		const text = wrapper.text();
		expect(text).toContain("Tax on mix orders");
		expect(text).toContain("+0.17");
		expect(text).toContain("Subtotal2.52");
		expect(text).toContain("Amount Due2.69");
		// One tax line: the order's, not the estimate as well.
		expect(text.match(/\+0\.17/g)?.length).toBe(1);
		expect(text).not.toContain("Sales Tax");
		wrapper.unmount();
	});
});
