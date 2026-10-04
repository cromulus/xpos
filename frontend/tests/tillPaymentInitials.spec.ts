/**
 * @vitest-environment jsdom
 *
 * Bill (2026-10-03, MuleCity-b9df): payments taken at the till on the shared
 * pos@ login, Receive on Account and Settle (paying an existing ticket), ask for
 * the cashier's initials like Pay does (MuleCity-fb00.2, MuleCity-1p4i). Same box,
 * same rule: listed initials only, sent as `pos_cashier`, and the avatar shows
 * them afterwards. A named login is not asked; the server records their name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const { call, store } = vi.hoisted(() => ({
	call: vi.fn(async () => ({ payment_entry: "ACC-PAY-1" })),
	store: {
		profileName: "Mule City Retail",
		posOpeningShift: { name: "SHIFT-1" },
		posProfile: { payments: [{ mode_of_payment: "Cash", default: 1 }] },
		requireCashierInitials: true,
		cashiers: [
			{ initials: "LE", cashier_name: "Lee Evans" },
			{ initials: " bc", cashier_name: "Bill Cromie" },
		],
		lastCashierInitials: "",
		rememberCashier: vi.fn(),
	},
}));

vi.mock("@/services/api", () => ({ call, showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => store }));
vi.mock("@/composables/useMoney", () => ({ useMoney: () => ({ money: (v: number) => `$${Number(v).toFixed(2)}` }) }));

import ReceiveOnAccountDialog from "@/components/dialogs/ReceiveOnAccountDialog.vue";
import SettleOutstandingDialog from "@/components/dialogs/SettleOutstandingDialog.vue";

const stubs = {
	Dialog: { template: "<div><slot /></div>" },
	DialogContent: { template: "<div><slot /></div>" },
	DialogHeader: { template: "<div><slot /></div>" },
	DialogTitle: { template: "<div><slot /></div>" },
	DialogDescription: { template: "<div><slot /></div>" },
	DialogFooter: { template: "<div><slot /></div>" },
	Select: { template: "<div />" },
	NumberInput: { props: ["modelValue"], template: "<input />" },
	Button: { template: "<button v-bind='$attrs'><slot /></button>" },
};

const TICKET = {
	name: "ACC-SINV-1",
	customer: "CUST-1",
	customer_name: "Peron Parker",
	grand_total: 80,
	outstanding_amount: 80,
};

const DIALOGS = [
	{
		title: "Receive on Account",
		mountIt: () => mount(ReceiveOnAccountDialog, { props: { customer: "CUST-1", balance: 50 }, global: { stubs } }),
		confirm: "on-account-confirm",
		method: "xpos.api.payments.receive_on_account",
		emitted: "received",
	},
	{
		title: "Settle",
		mountIt: () => mount(SettleOutstandingDialog, { props: { invoice: TICKET }, global: { stubs } }),
		confirm: "settle-confirm",
		method: "xpos.api.payments.settle_outstanding_invoice",
		emitted: "settled",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	store.requireCashierInitials = true;
});

async function type(wrapper: VueWrapper, value: string) {
	await wrapper.get("[data-testid='cashier-initials-input']").setValue(value);
}

describe.each(DIALOGS)("$title on the shared login", ({ mountIt, confirm, method, emitted }) => {
	const confirmButton = (wrapper: VueWrapper) => wrapper.get(`[data-testid='${confirm}']`);

	it("asks for initials, is blocked until they are on the list, and sends them", async () => {
		const wrapper = mountIt();
		expect(wrapper.find("[data-testid='cashier-initials']").exists()).toBe(true);
		expect(wrapper.text()).toContain("Required to take the payment");
		expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();

		await type(wrapper, "zz");
		expect(wrapper.text()).toContain("ZZ is not on the cashier list");
		expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();

		await type(wrapper, " le");
		expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();
		await confirmButton(wrapper).trigger("click");
		await flushPromises();

		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0][0]).toBe(method);
		expect((call.mock.calls[0] as unknown[])[1]).toMatchObject({ pos_cashier: "LE", pos_opening_shift: "SHIFT-1" });
		// The avatar shows who took the money, as after Pay (MuleCity-qajl.1).
		expect(store.rememberCashier).toHaveBeenCalledWith(" le");
		expect(wrapper.emitted(emitted)).toBeTruthy();
	});

	it("negative: without initials the payment is never sent", async () => {
		const wrapper = mountIt();
		await confirmButton(wrapper).trigger("click");
		await flushPromises();
		expect(call).not.toHaveBeenCalled();
		expect(store.rememberCashier).not.toHaveBeenCalled();
	});

	it("negative: a refused payment does not change the avatar", async () => {
		call.mockRejectedValueOnce(new Error("Enter your cashier initials to take this payment."));
		const wrapper = mountIt();
		await type(wrapper, "BC");
		await confirmButton(wrapper).trigger("click");
		await flushPromises();
		expect(store.rememberCashier).not.toHaveBeenCalled();
		expect(wrapper.emitted(emitted)).toBeFalsy();
	});
});

describe.each(DIALOGS)("$title on a named login", ({ mountIt, confirm, method }) => {
	it("shows no box and pays without pos_cashier (the server records their name)", async () => {
		store.requireCashierInitials = false;
		const wrapper = mountIt();
		expect(wrapper.find("[data-testid='cashier-initials']").exists()).toBe(false);
		await wrapper.get(`[data-testid='${confirm}']`).trigger("click");
		await flushPromises();
		expect(call.mock.calls[0][0]).toBe(method);
		expect((call.mock.calls[0] as unknown[])[1]).not.toHaveProperty("pos_cashier");
		expect(store.rememberCashier).not.toHaveBeenCalled();
	});
});

describe("the box starts empty for the next payment", () => {
	it("Receive on Account clears the initials when another customer is opened", async () => {
		const wrapper = mount(ReceiveOnAccountDialog, { props: { customer: "CUST-1", balance: 50 }, global: { stubs } });
		await type(wrapper, "LE");
		await wrapper.setProps({ customer: null });
		await wrapper.setProps({ customer: "CUST-2" });
		const input = wrapper.get("[data-testid='cashier-initials-input']").element as HTMLInputElement;
		expect(input.value).toBe("");
		expect(wrapper.get("[data-testid='on-account-confirm']").attributes("disabled")).toBeDefined();
	});
});

