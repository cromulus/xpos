/**
 * User story (MuleCity-artt): Leslie typed $10 off a line of 4 bags; the cart showed
 * -$10 and the server posted $2.50 per bag. Reopening the sale, the receipt preview shows
 * the same $10 for the line, not the per-bag $2.50.
 */
import { describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ invoiceCurrency: "USD" }) }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({}) }));
vi.mock("@/composables/useMoney", () => ({
	useMoney: () => ({
		money: (value: number) => `$${Number(value).toFixed(2)}`,
		amount: (value: number) => Number(value).toFixed(2),
		qty: (value: number) => String(value),
		percent: (value: number) => `${value}%`,
	}),
}));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import ReceiptPreviewDialog from "@/components/dialogs/ReceiptPreviewDialog.vue";

function invoiceWith(item: Record<string, unknown>) {
	return {
		name: "ACC-SINV-TEST-1",
		customer: "Walk-In Customer",
		posting_date: "2026-09-28",
		status: "Paid",
		grand_total: 30,
		net_total: 30,
		items: [{ item_code: "MP", item_name: "Max Nutrition Prime", uom: "Bag", rate: 7.5, amount: 30, ...item }],
		payments: [],
		taxes: [],
	};
}

describe("receipt preview line discount", () => {
	it("shows a $ discount for the whole line, as the cart did", () => {
		const wrapper = shallowMount(ReceiptPreviewDialog, {
			props: { invoice: invoiceWith({ qty: 4, discount_amount: 2.5 }) as never },
			global: { renderStubDefaultSlot: true },
		});
		expect(wrapper.text()).toContain("Discount: $10.00");
		expect(wrapper.text()).not.toContain("Discount: $2.50");
	});

	it("leaves a percentage discount as it is", () => {
		const wrapper = shallowMount(ReceiptPreviewDialog, {
			props: { invoice: invoiceWith({ qty: 4, discount_percentage: 10 }) as never },
			global: { renderStubDefaultSlot: true },
		});
		expect(wrapper.text()).toContain("Discount: 10%");
	});
});
