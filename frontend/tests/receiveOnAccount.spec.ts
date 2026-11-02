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
vi.mock("@/composables/useMoney", async () => {
	const { ref } = await import("vue");
	return { useMoney: () => ({ money: (v: number) => `$${Number(v).toFixed(2)}`, moneyPrecision: ref(2) }) };
});
vi.mock("@/lib/translate", () => ({
	__: (text: string, args: unknown[] = []) => text.replace(/\{(\d)\}/g, (_m, i) => String(args[Number(i)])),
}));

import ReceiveOnAccountDialog from "@/components/dialogs/ReceiveOnAccountDialog.vue";
import { NumberInput as RealNumberInput } from "@/components/ui/number-input";

const stubs = {
	Dialog: { template: "<div><slot /></div>" },
	DialogContent: { template: "<div><slot /></div>" },
	DialogHeader: { template: "<div><slot /></div>" },
	DialogTitle: { template: "<div><slot /></div>" },
	DialogDescription: { template: "<div><slot /></div>" },
	DialogFooter: { template: "<div><slot /></div>" },
	Select: { template: "<div />" },
	NumberInput: {
		name: "NumberInput",
		props: ["modelValue", "precision"],
		emits: ["update:modelValue"],
		template: "<input data-testid='on-account-amount' :data-precision='precision' />",
	},
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

	it("prefills a balance in cents and sends cents (MuleCity-vz28.17.14.4)", async () => {
		const wrapper = mount(ReceiveOnAccountDialog, {
			props: { customer: "CUST-342", balance: 19.750000001 },
			global: { stubs },
		});
		await wrapper.get("[data-testid='on-account-confirm']").trigger("click");
		await flushPromises();
		expect(call).toHaveBeenCalledWith("xpos.api.payments.receive_on_account", expect.objectContaining({ amount: 19.75 }));
	});

	it("never sends a part of a cent, even if the box held one ($14.755)", async () => {
		const wrapper = mount(ReceiveOnAccountDialog, {
			props: { customer: "CUST-342", balance: 20.74 },
			global: { stubs },
		});
		await wrapper.getComponent({ name: "NumberInput" }).vm.$emit("update:modelValue", 14.755);
		await wrapper.get("[data-testid='on-account-confirm']").trigger("click");
		await flushPromises();
		expect(call).toHaveBeenCalledWith("xpos.api.payments.receive_on_account", expect.objectContaining({ amount: 14.76 }));
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

describe("Receive on Account's amount box (MuleCity-vz28.17.14.4)", () => {
	it("is told the currency's precision, not the 3-decimal float precision", () => {
		const wrapper = mount(ReceiveOnAccountDialog, {
			props: { customer: "CUST-342", balance: 19.75 },
			global: { stubs },
		});
		expect(wrapper.get("[data-testid='on-account-amount']").attributes("data-precision")).toBe("2");
	});
});

describe("the amount box itself", () => {
	it("shows 19.75 at the currency's 2 decimals, where the float precision showed 19.750", () => {
		const cents = mount(RealNumberInput, { props: { modelValue: 19.75, precision: 2 } });
		expect((cents.get("input").element as HTMLInputElement).value).toBe("19.75");
		const floats = mount(RealNumberInput, { props: { modelValue: 19.75 } });
		expect((floats.get("input").element as HTMLInputElement).value).toBe("19.750");
	});
});
