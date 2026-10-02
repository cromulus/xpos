/**
 * User story (Bill 2026-10-01, MuleCity-qajl.6): the shared counter login rings sales and
 * returns under typed initials. The Close Shift sheet shows each cashier's sales and returns,
 * with a "(none)" row for invoices saved without initials.
 */
import { describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";

const summary = vi.hoisted(() => ({
	total_invoices: 5,
	grand_total: 37.78,
	net_total: 36,
	returns_count: 2,
	opening_balances: { Cash: { amount: 150, currency: "USD" } },
	expected_amounts: { Cash: { amount: 187.78, currency: "USD" } },
	tax_summary: [],
	// Exactly what xpos.api.shifts.get_shift_summary returns.
	by_cashier: [
		{ cashier: "BI", sales_count: 1, sales_total: 10, returns_count: 0, returns_total: 0 },
		{ cashier: "LE", sales_count: 2, sales_total: 26.35, returns_count: 1, returns_total: -5 },
		{ cashier: "(none)", sales_count: 1, sales_total: 7.5, returns_count: 1, returns_total: -1.07 },
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
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));

import ClosingDialog from "@/components/dialogs/ClosingDialog.vue";

describe("Close Shift by cashier", () => {
	it("shows each cashier's sales and returns, and a (none) row last", async () => {
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();

		expect(wrapper.text()).toContain("By Cashier");
		const rows = wrapper.findAll('[data-testid="close-by-cashier-row"]').map((row) =>
			row.findAll("td").map((cell) => cell.text()),
		);
		expect(rows).toEqual([
			["BI", "1", "$10.00", "0", ""],
			["LE", "2", "$26.35", "1", "$5.00"],
			["(none)", "1", "$7.50", "1", "$1.07"],
		]);
		wrapper.unmount();
	});

	it("negative: no table when the summary has no cashier rows (an older server)", async () => {
		const saved = summary.by_cashier;
		(summary as { by_cashier: unknown }).by_cashier = undefined;
		const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
		await flushPromises();
		expect(wrapper.find('[data-testid="close-by-cashier"]').exists()).toBe(false);
		summary.by_cashier = saved;
		wrapper.unmount();
	});
});
