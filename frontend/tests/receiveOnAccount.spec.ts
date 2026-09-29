/**
 * User story (Mule City, Bill 2026-09-29): a customer hands Leslie $200 toward
 * what they owe. She takes it "on account": one payment that ERPNext puts
 * against their oldest tickets first (xpos.api.payments.receive_on_account).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const { call, showSuccess, showError } = vi.hoisted(() => ({
	call: vi.fn(async () => ({ payment_entry: "ACC-PAY-1", allocated: [], unallocated_amount: 0 })),
	showSuccess: vi.fn(),
	showError: vi.fn(),
}));

vi.mock("@/services/api", () => ({ call, showSuccess, showError }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({
		profileName: "Mule City Retail",
		posOpeningShift: { name: "SHIFT-1" },
		posProfile: { payments: [{ mode_of_payment: "Cash", default: 1 }, { mode_of_payment: "Check" }] },
	}),
}));
vi.mock("@/composables/useMoney", () => ({ useMoney: () => ({ money: (v: number) => `$${Number(v).toFixed(2)}` }) }));
vi.mock("@/lib/translate", () => ({
	__: (text: string, args: unknown[] = []) => text.replace(/\{(\d)\}/g, (_m, i) => String(args[Number(i)])),
}));

import ReceiveOnAccountDialog from "@/components/dialogs/ReceiveOnAccountDialog.vue";

const stubs = {
	Dialog: { template: "<div><slot /></div>" },
	DialogContent: { template: "<div><slot /></div>" },
	DialogHeader: { template: "<div><slot /></div>" },
	DialogTitle: { template: "<div><slot /></div>" },
	DialogDescription: { template: "<div><slot /></div>" },
	DialogFooter: { template: "<div><slot /></div>" },
	Select: { template: "<div />" },
	NumberInput: { props: ["modelValue"], emits: ["update:modelValue"], template: "<input data-testid='on-account-amount' />" },
	Button: { template: "<button v-bind='$attrs'><slot /></button>" },
};

beforeEach(() => vi.clearAllMocks());

describe("Receive on Account", () => {
	it("takes the payment for the whole balance by default, in the profile's default mode", async () => {
		const wrapper = mount(ReceiveOnAccountDialog, {
			props: { customer: "CUST-342", customerLabel: "Peron Parker", balance: 1250 },
			global: { stubs },
		});
		expect(wrapper.text()).toContain("Peron Parker");
		expect(wrapper.text()).toContain("$1250.00");

		await wrapper.get("[data-testid='on-account-confirm']").trigger("click");
		await flushPromises();

		expect(call).toHaveBeenCalledWith("xpos.api.payments.receive_on_account", {
			customer: "CUST-342",
			amount: 1250,
			mode_of_payment: "Cash",
			pos_opening_shift: "SHIFT-1",
			pos_profile: "Mule City Retail",
		});
		expect(wrapper.emitted("received")).toBeTruthy();
	});

	it("says why a refused payment failed and stays open", async () => {
		call.mockRejectedValueOnce(new Error("You are not permitted to take payments on account."));
		const wrapper = mount(ReceiveOnAccountDialog, {
			props: { customer: "CUST-342", balance: 100 },
			global: { stubs },
		});
		await wrapper.get("[data-testid='on-account-confirm']").trigger("click");
		await flushPromises();

		expect(showError).toHaveBeenCalled();
		expect(wrapper.emitted("received")).toBeFalsy();
	});
});
