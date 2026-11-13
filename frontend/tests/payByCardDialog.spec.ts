/**
 * @vitest-environment jsdom
 *
 * Pay by Card in the Pay box (Mule City, MuleCity-bjjv.3). With a card reader
 * set up for the register:
 * - the reader's Mode of Payment ("Stripe Card") is not an ordinary tender
 *   button: only the payments app fills it in, on capture. Heartland's manual
 *   "Credit Card" stays;
 * - Pay by Card saves the cart as a draft with only the cash legs (none on one
 *   tender; the cash legs of a split), never create_invoice, never offline;
 * - it is not offered for a refund, and is disabled offline or for a mix order.
 * Without a reader the Pay box is exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, shallowMount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";

const mocks = vi.hoisted(() => ({ call: vi.fn(), print: vi.fn(), online: { value: true } }));

vi.mock("@/services/api", () => ({
	call: mocks.call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
	isNetworkError: vi.fn(() => false),
	default: { call: mocks.call },
}));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printInvoice: mocks.print, printInvoiceLocal: vi.fn() }),
}));
vi.mock("@/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils")>()),
	isOnline: () => mocks.online.value,
}));

import PaymentDialog from "@/components/dialogs/PaymentDialog.vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useCardPaymentStore } from "@/stores/cardPaymentStore";
import { bindCardTill } from "@/composables/useCardTill";

const READY = {
	enabled: true,
	card_modes: ["Stripe Card"],
	mode_of_payment: "Stripe Card",
	terminals: [{ name: "PT-1", label: "Counter reader" }],
};

function register(reader = true) {
	const pos = usePosStore();
	pos.posProfile = {
		name: "Mule City Retail",
		currency: "USD",
		payments: ["Cash", "Credit Card", "Check", "Stripe Card"].map((mode_of_payment, i) => ({
			mode_of_payment,
			default: i === 0 ? 1 : 0,
			type: mode_of_payment === "Cash" ? "Cash" : "Bank",
		})),
	} as never;
	if (reader) useCardPaymentStore().config = { ...READY };
	const cart = useCartStore();
	cart.customer = { name: "Practice Farm" } as never;
	cart.items.push({
		uid: "bag-1",
		item_code: "BAG",
		item_name: "Feed bag",
		qty: 2,
		rate: 10.37,
		uom: "Nos",
		stock_uom: "Nos",
		conversion_factor: 1,
		actual_qty: 50,
		discount_percentage: 0,
		discount_amount: 0,
	} as never);
	cart.revalidateStock = vi.fn(async () => ({ valid: true, messages: [] })) as never;
	return cart;
}

const NumberInput = defineComponent({
	setup(_props, { expose }) {
		expose({ focus: () => undefined, setValue: () => undefined });
		return () => h("input", { "data-testid": "amount" });
	},
});

async function openPay() {
	bindCardTill();
	useCartStore().showPaymentDialog = true;
	const wrapper = shallowMount(PaymentDialog, {
		attachTo: document.body,
		global: { renderStubDefaultSlot: true, stubs: { NumberInput, Input: false } },
	});
	await flushPromises();
	return wrapper;
}

type Dialog = {
	availableMethods: { mode_of_payment: string }[];
	cardBlock: string | null;
	payByCard: () => Promise<void>;
	enableSplitPayment: () => void;
	selectMethod: (mode: string) => void;
	tenderedAmount: number;
	addSplitPayment: () => void;
};
const vm = (w: VueWrapper) => w.vm as unknown as Dialog;

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	mocks.online.value = true;
	window.localStorage.clear();
	mocks.call.mockImplementation(async (method: string) => {
		// The config is set directly here, so the reader module is asked of the server.
		if (method.endsWith("get_card_terminal_service")) return "payments.transactions.service";
		if (method.endsWith("save_card_draft"))
			return { name: "ACC-SINV-1", doctype: "Sales Invoice", modified: "m", grand_total: 20.74, card_amount: 20.74 };
		if (method.endsWith("get_available_terminals"))
			return { devices: [{ name: "PT-1", label: "Counter reader", busy: false }], active_attempt: null, posted_attempt: null };
		if (method.endsWith("start_terminal_payment"))
			return { attempt: "pta-1", collection_state: "PENDING", accounting_state: "Not ready", received: false, paid: false, amount: "20.74", currency: "USD", retryable: false };
		return undefined;
	});
});

afterEach(() => {
	useCardPaymentStore().reset();
	document.body.innerHTML = "";
});

describe("Pay by Card in the Pay box", () => {
	it("hides the reader's mode from the tender buttons and keeps Heartland's Credit Card", async () => {
		register();
		const wrapper = await openPay();
		const modes = vm(wrapper).availableMethods.map((m) => m.mode_of_payment);
		expect(modes).toEqual(["Cash", "Credit Card", "Check"]);
		expect(wrapper.find('[data-testid="pay-by-card"]').exists()).toBe(true);
		expect(vm(wrapper).cardBlock).toBeNull();
	});

	it("without a reader the Pay box is unchanged", async () => {
		register(false);
		const wrapper = await openPay();
		expect(wrapper.find('[data-testid="pay-by-card"]').exists()).toBe(false);
		expect(vm(wrapper).availableMethods.map((m) => m.mode_of_payment)).toContain("Stripe Card");
	});

	it("one tender: the card collects the whole ticket; only the draft is saved, never create_invoice", async () => {
		register();
		const wrapper = await openPay();
		await vm(wrapper).payByCard();
		await flushPromises();
		const methods = mocks.call.mock.calls.map((c) => c[0] as string);
		expect(methods).toContain("xpos.api.card_terminal.save_card_draft");
		expect(methods).toContain("payments.transactions.service.start_terminal_payment");
		expect(methods.some((m) => m.endsWith("create_invoice"))).toBe(false);
		const data = JSON.parse(mocks.call.mock.calls.find((c) => String(c[0]).endsWith("save_card_draft"))![1].data);
		expect(data.payments).toEqual([]);
		expect(data.card_mode).toBe("Stripe Card");
		expect(useCartStore().currentDraftName).toBe("ACC-SINV-1");

		// Approved: the payments app submitted the draft; the till prints it and clears the cart.
		mocks.call.mockImplementation(async (method: string) =>
			method.endsWith("get_terminal_payment_status")
				? { attempt: "pta-1", collection_state: "Captured", accounting_state: "Posted", received: true, paid: true, amount: "20.74", currency: "USD", retryable: false }
				: undefined,
		);
		await useCardPaymentStore().poll();
		await flushPromises();
		expect(mocks.print).toHaveBeenCalledWith("ACC-SINV-1");
		expect(useCartStore().items).toHaveLength(0);
		expect(useCartStore().showPaymentDialog).toBe(false);
		expect(usePosStore().lastInvoiceName).toBe("ACC-SINV-1");
		expect(mocks.call.mock.calls.some((c) => String(c[0]).endsWith("create_invoice"))).toBe(false);
	});

	it("split: the cash legs go with the draft and the cashier confirms them first", async () => {
		register();
		const wrapper = await openPay();
		vm(wrapper).enableSplitPayment();
		vm(wrapper).selectMethod("Cash");
		vm(wrapper).tenderedAmount = 5;
		vm(wrapper).addSplitPayment();
		await flushPromises();
		expect(vm(wrapper).cardBlock).toBeNull();
		await vm(wrapper).payByCard();
		await flushPromises();
		const data = JSON.parse(mocks.call.mock.calls.find((c) => String(c[0]).endsWith("save_card_draft"))![1].data);
		expect(data.payments).toEqual([{ mode_of_payment: "Cash", amount: 5 }]);
		expect(useCardPaymentStore().step).toBe("confirm");
		expect(mocks.call.mock.calls.some((c) => String(c[0]).endsWith("start_terminal_payment"))).toBe(false);
	});

	it("a check in the split blocks Pay by Card", async () => {
		register();
		const wrapper = await openPay();
		vm(wrapper).enableSplitPayment();
		vm(wrapper).selectMethod("Check");
		vm(wrapper).tenderedAmount = 5;
		vm(wrapper).addSplitPayment();
		await flushPromises();
		expect(vm(wrapper).cardBlock).toMatch(/Check/);
	});

	it("is not offered for a refund", async () => {
		const cart = register();
		cart.isReturnMode = true;
		const wrapper = await openPay();
		expect(wrapper.find('[data-testid="pay-by-card"]').exists()).toBe(false);
	});

	it("is disabled offline, and nothing is queued", async () => {
		register();
		mocks.online.value = false;
		const wrapper = await openPay();
		expect(vm(wrapper).cardBlock).toMatch(/connection/);
		await vm(wrapper).payByCard();
		expect(mocks.call).not.toHaveBeenCalledWith("xpos.api.card_terminal.save_card_draft", expect.anything());
	});
});
