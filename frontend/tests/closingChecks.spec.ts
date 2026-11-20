/**
 * User story (Bill 2026-11-19, MuleCity-zegl): "add up the total value of checks in the till
 * and that should match what xpos thinks we made in checks that day". At Close Shift the
 * Check line compares Expected with the counted Closing, like Credit Card; under it the sheet
 * lists every check behind Expected (number, customer, amount) and their total, so the
 * cashier ticks the paper checks off before typing the total.
 */
import { describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const summary = vi.hoisted(() => ({
	total_invoices: 2,
	grand_total: 102.4,
	net_total: 102.4,
	returns_count: 1,
	opening_balances: { Cash: { amount: 150, currency: "USD" }, Check: { amount: 0, currency: "USD" } },
	expected_amounts: { Cash: { amount: 152.4, currency: "USD" }, Check: { amount: 310, currency: "USD" } },
	till_payments: {},
	tax_summary: [],
	by_cashier: [],
	checks: [
		{ source: "SINV-1", number: "3317", customer: "C-2001", customer_name: "Ada Farms", amount: 80, is_refund: false },
		{ source: "SINV-2", number: "88", customer: "C-2002", customer_name: "Bo Hill", amount: -20, is_refund: true },
		{ source: "ACC-PAY-05009", number: "10452", customer: "C-1044", customer_name: "Steve Barnes", amount: 250, is_refund: false },
	] as unknown[],
}));

vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({
		showClosingDialog: true,
		invoiceCurrency: "USD",
		fetchClosingData: vi.fn().mockResolvedValue(summary),
	}),
}));
vi.mock("@/composables/useMoney", () => ({
	useMoney: () => ({ money: (value: number) => `$${Number(value).toFixed(2)}` }),
}));
vi.mock("@/composables/useCurrency", () => ({
	formatFor: (_currency: string, value: number) => `$${Number(value).toFixed(2)}`,
	precisionFor: () => 2,
	roundFor: (_currency: string, value: number) => Math.round(value * 100) / 100,
}));
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/lib/translate", () => ({
	default: (text: string, args: string[] = []) => text.replace(/\{(\d)\}/g, (_m, i) => args[Number(i)]),
}));
vi.mock("@/stores/offlineStore", () => ({
	useOfflineStore: () => ({
		pendingInvoices: [],
		isOnline: true,
		isSyncing: false,
		loadPendingInvoices: vi.fn().mockResolvedValue(undefined),
		syncPendingInvoices: vi.fn().mockResolvedValue(undefined),
	}),
}));

import ClosingDialog from "@/components/dialogs/ClosingDialog.vue";

describe("Close Shift: the checks in the drawer", () => {
	it("lists each check with its number, customer and amount, and their total matches Expected", async () => {
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();

		const rows = wrapper.findAll('[data-testid="close-check-row"]').map((row) =>
			row.findAll("td").map((cell) => cell.text()),
		);
		expect(rows).toEqual([
			["3317", "Ada Farms", "$80.00"],
			["88", "Bo Hill  · refund check written", "$-20.00"],
			["10452", "Steve Barnes", "$250.00"],
		]);
		expect(wrapper.find('[data-testid="close-checks-total"]').text()).toBe("$310.00");
		const check = wrapper.find('[data-testid="closing-row"][data-mode="Check"]');
		expect(check.find('[data-testid="closing-expected"]').text()).toBe("$310.00");
		wrapper.unmount();
	});

	it("negative: no check list when the shift took no checks", async () => {
		const saved = summary.checks;
		summary.checks = [];
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();
		expect(wrapper.find('[data-testid="close-checks"]').exists()).toBe(false);
		summary.checks = saved;
		wrapper.unmount();
	});
});
