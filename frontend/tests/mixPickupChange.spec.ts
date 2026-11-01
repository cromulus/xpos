/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-vz28.17.14.3; Bill 2026-11-01). Practice Goat
 * Farm orders a custom mix, $11.48 with tax. The Pay box opens on Pay now with
 * $11.48 tendered. The cashier picks Pay at pickup: Amount Due goes to $0.00,
 * but the tender stayed at $11.48, so the box said "Change $11.48" though
 * nothing was paid, and Save sent it as cash change; with Credit Card as the
 * first method the site refused the sale ("Only cash can be given back as
 * change"). The tender now follows the amount due, unless the cashier typed
 * another amount; with nothing due, nothing is tendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, shallowMount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick } from "vue";

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
const MIX_TOTAL = 11.48;

/** The site's answer for the goat mix: nothing on today's ticket, an $11.48 order. */
function answer(ticketDue = 0) {
	return {
		ticket_due: ticketDue,
		orders_total: MIX_TOTAL,
		ticket: null,
		orders: [
			{ item_code: "MC-MIX-GOAT", qty: 1, uom: "Bag", line_index: 0, rate: 10.75, amount: 10.75, net_total: 10.75, taxes: 0.73, grand_total: MIX_TOTAL },
		],
	};
}

async function cartWithMix(methods: string[], ticketDue = 0) {
	mocks.call.mockImplementation(async (method: string) => (method === CHECK ? answer(ticketDue) : undefined));
	const pos = usePosStore();
	pos.posProfile = {
		name: "Mule City Retail",
		payments: methods.map((mode_of_payment, i) => ({ mode_of_payment, default: i === 0 ? 1 : 0 })),
	} as never;
	const cart = useCartStore();
	cart.customer = { name: "Practice Goat Farm" } as never;
	cart.items.push({
		uid: "mix-1",
		item_code: "MC-MIX-GOAT",
		item_name: "Practice goat mix",
		qty: 1,
		rate: 10.75,
		uom: "Bag",
		stock_uom: "Bag",
		conversion_factor: 1,
		actual_qty: 0,
		is_made_to_order: 1,
		discount_percentage: 0,
		discount_amount: 0,
	} as never);
	cart.pickupDate = "2026-11-03";
	await vi.advanceTimersByTimeAsync(700);
	cart.mixPayMode = "now";
	return cart;
}

const typed: number[] = [];
const NumberInput = defineComponent({
	setup(_props, { expose }) {
		expose({ focus: () => undefined, setValue: (v: number) => typed.push(v) });
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

type DialogState = {
	tenderedAmount: number;
	changeAmount: number;
	remainingAmount: number;
	canSubmit: boolean;
	selectedMethod: string;
	activeLegs: unknown[];
	changeLegs: unknown[];
};
const state = (w: VueWrapper) => w.vm as unknown as DialogState;

async function choose(mode: "now" | "pickup") {
	useCartStore().mixPayMode = mode;
	await nextTick();
	await flushPromises();
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	vi.useFakeTimers();
	typed.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("Pay at pickup on a custom mix: nothing paid, no change", () => {
	it("Pay at pickup: Amount Due 0.00, nothing tendered, no Change, and it can be saved", async () => {
		const cart = await cartWithMix(["Cash", "Credit Card", "Check"]);
		const wrapper = await openPay();
		expect(state(wrapper).tenderedAmount).toBe(MIX_TOTAL);
		await choose("pickup");
		expect(cart.grandTotal).toBe(0);
		expect(state(wrapper).tenderedAmount).toBe(0);
		expect(state(wrapper).changeAmount).toBe(0);
		expect(state(wrapper).activeLegs).toEqual([]);
		expect(state(wrapper).changeLegs).toEqual([]);
		expect(state(wrapper).canSubmit).toBe(true);
		expect(wrapper.text()).toContain("Amount Due0.00");
		expect(wrapper.text()).not.toContain("Change");
		expect(typed.at(-1)).toBe(0);
		wrapper.unmount();
	});

	it("back to Pay now: the tender is the order's total again, no change", async () => {
		await cartWithMix(["Cash", "Credit Card"]);
		const wrapper = await openPay();
		await choose("pickup");
		await choose("now");
		expect(state(wrapper).tenderedAmount).toBe(MIX_TOTAL);
		expect(state(wrapper).changeAmount).toBe(0);
		expect(state(wrapper).remainingAmount).toBe(0);
		expect(state(wrapper).canSubmit).toBe(true);
		wrapper.unmount();
	});

	it("Credit Card first (the refused case): Pay at pickup sends no card payment and no change", async () => {
		await cartWithMix(["Credit Card", "Cash"]);
		const wrapper = await openPay();
		expect(state(wrapper).selectedMethod).toBe("Credit Card");
		await choose("pickup");
		expect(state(wrapper).activeLegs).toEqual([]);
		expect(state(wrapper).changeAmount).toBe(0);
		expect(state(wrapper).canSubmit).toBe(true);
		wrapper.unmount();
	});

	it("a typed amount stays when the amount due moves but is still owed", async () => {
		// $5.00 of feed on today's ticket plus the mix: Pay now $16.48, at pickup $5.00.
		await cartWithMix(["Cash", "Credit Card"], 5);
		const wrapper = await openPay();
		expect(state(wrapper).tenderedAmount).toBe(16.48);
		state(wrapper).tenderedAmount = 20; // the customer hands over a $20 bill
		await nextTick();
		await choose("pickup");
		expect(state(wrapper).tenderedAmount).toBe(20);
		expect(state(wrapper).changeAmount).toBe(15);
		wrapper.unmount();
	});

	it("negative: the tender follows only if it was the old total (ticket left to pay at pickup)", async () => {
		await cartWithMix(["Cash", "Credit Card"], 5);
		const wrapper = await openPay();
		await choose("pickup");
		expect(state(wrapper).tenderedAmount).toBe(5);
		expect(state(wrapper).changeAmount).toBe(0);
		wrapper.unmount();
	});

	it("a typed amount on a mix-only cart: Pay at pickup still tenders nothing", async () => {
		await cartWithMix(["Cash"]);
		const wrapper = await openPay();
		state(wrapper).tenderedAmount = 20;
		await nextTick();
		await choose("pickup");
		expect(state(wrapper).tenderedAmount).toBe(0);
		expect(state(wrapper).changeAmount).toBe(0);
		wrapper.unmount();
	});
});
