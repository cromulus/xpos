/**
 * User story (MuleCity-49ue, mc24 walk 2026-10-02): a custom mix order paid now in cash is an
 * advance Payment Entry, not an invoice payment. The Close Shift sheet lists it under
 * "Payments received" (count and amount per mode), counts it in Expected, and shows it in the
 * cashier's row of the By Cashier table.
 */
import { describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const summary = vi.hoisted(() => ({
	total_invoices: 1,
	grand_total: 10.37,
	net_total: 10.37,
	returns_count: 0,
	opening_balances: { Cash: { amount: 150, currency: "USD" } },
	// Exactly what xpos.api.shifts.get_shift_summary returns: the $40 prepayment is in Expected.
	expected_amounts: { Cash: { amount: 200.37, currency: "USD" } },
	till_payments: { Cash: { count: 1, amount: 40, currency: "USD" } },
	tax_summary: [],
	by_cashier: [
		{
			cashier: "BI",
			sales_count: 1,
			sales_total: 10.37,
			returns_count: 0,
			returns_total: 0,
			payments_count: 0,
			payments_total: 0,
		},
		{
			cashier: "LE",
			sales_count: 0,
			sales_total: 0,
			returns_count: 0,
			returns_total: 0,
			payments_count: 1,
			payments_total: 40,
		},
	],
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
vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));
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

describe("Close Shift payments received", () => {
	it("lists the till's Payment Entries per mode and counts them in Expected", async () => {
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();

		expect(wrapper.text()).toContain("Payments received");
		const rows = wrapper.findAll('[data-testid="close-till-payment-row"]').map((row) => row.text());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Cash");
		expect(rows[0]).toContain("1");
		expect(rows[0]).toContain("$40.00");
		expect(wrapper.find('[data-testid="closing-expected"]').text()).toBe("$200.37");
		wrapper.unmount();
	});

	it("shows each cashier's payments in the By Cashier table", async () => {
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();

		const rows = wrapper.findAll('[data-testid="close-by-cashier-row"]').map((row) =>
			row.findAll("td").map((cell) => cell.text()),
		);
		expect(rows).toEqual([
			["BI", "1", "$10.37", "0", "", "0", ""],
			["LE", "0", "$0.00", "0", "", "1", "$40.00"],
		]);
		wrapper.unmount();
	});

	it("negative: no section and no payment columns when the till took no Payment Entries", async () => {
		const saved = summary.till_payments;
		(summary as { till_payments: unknown }).till_payments = {};
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();
		expect(wrapper.find('[data-testid="close-till-payments"]').exists()).toBe(false);
		const cells = wrapper.find('[data-testid="close-by-cashier-row"]').findAll("td");
		expect(cells).toHaveLength(5);
		summary.till_payments = saved;
		wrapper.unmount();
	});
});
