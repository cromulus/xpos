/**
 * User story (MuleCity-u497): Leslie's shift rang taxed sales, so the Close Shift sheet's
 * Tax Breakdown shows the tax collected per account, not $0.00.
 */
import { describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const summary = vi.hoisted(() => ({
	total_invoices: 3,
	grand_total: 44.83,
	net_total: 42,
	returns_count: 1,
	opening_balances: { Cash: { amount: 150, currency: "USD" } },
	expected_amounts: { Cash: { amount: 194.83, currency: "USD" } },
	// Exactly what xpos.api.shifts.get_shift_summary returns for a tax row.
	tax_summary: [{ account_head: "NC Sales Tax Payable - MCSF", rate: 6.75, amount: 2.83 }],
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
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));
// An empty offline queue: nothing holds the close (closeShiftQueue.spec.ts covers the guard).
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

describe("Close Shift tax breakdown", () => {
	it("shows the tax amount each account collected in the shift", async () => {
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();

		const text = wrapper.text();
		expect(text).toContain("Tax Breakdown");
		expect(text).toContain("NC Sales Tax Payable - MCSF");
		expect(text).toContain("$2.83");
		wrapper.unmount();
	});
});
