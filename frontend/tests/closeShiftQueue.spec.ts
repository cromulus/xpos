/**
 * User story (MuleCity-86ea, staging 2026-10-01): Leslie sold offline; at sync the server
 * refused the sale ("1 need attention"), and Close Shift closed anyway, so that sale's cash
 * was missing from the closing. Close Shift now looks at the till's offline queue first:
 * sales still waiting are synced (or the cashier is told to reconnect), sales that need
 * attention are listed with the customer, amount and error, and the close is blocked until
 * they are dealt with in the offline invoices list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { classifyQueue } from "@/utils/closeShiftGuard";
import type { PendingInvoice } from "@/services/idbService";

const { pos, offline, db, showError } = vi.hoisted(() => {
	const db = { rows: [] as Array<Record<string, unknown>> };
	const offline = {
		pendingInvoices: [] as Array<Record<string, unknown>>,
		isOnline: true,
		isSyncing: false,
		loadPendingInvoices: vi.fn(async () => {
			offline.pendingInvoices = db.rows.map((row) => ({ ...row }));
		}),
		// The server takes every waiting sale.
		syncPendingInvoices: vi.fn(async () => {
			db.rows = db.rows.filter((row) => row.status === "dead_letter");
		}),
	};
	const pos = {
		showClosingDialog: true,
		invoiceCurrency: "USD",
		profileName: "Mule City Retail",
		fetchClosingData: vi.fn(async () => ({
			total_invoices: 1,
			grand_total: 10,
			net_total: 10,
			opening_balances: { Cash: { amount: 0, currency: "USD" } },
			expected_amounts: { Cash: { amount: 10, currency: "USD" } },
		})),
		closeShift: vi.fn(async () => ({ name: "POS-CS-0001" })),
	};
	return { pos, offline, db, showError: vi.fn() };
});

vi.mock("@/stores/posStore", () => ({ usePosStore: () => pos }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => offline }));
vi.mock("@/composables/useMoney", () => ({
	useMoney: () => ({ money: (value: number) => `$${Number(value).toFixed(2)}` }),
}));
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError }));
vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));
vi.mock("@/lib/translate", () => ({
	default: (text: string, args: string[] = []) => text.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? ""),
}));

import ClosingDialog from "@/components/dialogs/ClosingDialog.vue";

const refused = {
	id: 7,
	status: "dead_letter",
	customer_name: "Walk-in",
	grand_total: 25.25,
	error: "User pos@mulecity.com does not have doctype access via role permission for document Serial and Batch Bundle",
	data: { customer: "Walk-in", pos_profile: "Mule City Retail" },
};
const waiting = {
	id: 8,
	status: "pending",
	customer_name: "Smith Farm",
	grand_total: 12.5,
	data: { customer: "Smith Farm", pos_profile: "Mule City Retail" },
};

async function open() {
	const wrapper = shallowMount(ClosingDialog, { global: { renderStubDefaultSlot: true } });
	await flushPromises();
	return wrapper;
}

function closeButton(wrapper: ReturnType<typeof shallowMount>) {
	return wrapper.findComponent('[data-testid="close-shift-submit"]');
}

async function clickClose(wrapper: ReturnType<typeof shallowMount>) {
	closeButton(wrapper).vm.$emit("click");
	await flushPromises();
}

beforeEach(() => {
	db.rows = [];
	offline.isOnline = true;
	offline.isSyncing = false;
	offline.loadPendingInvoices.mockClear();
	offline.syncPendingInvoices.mockClear();
	pos.closeShift.mockClear();
	pos.showClosingDialog = true;
	showError.mockClear();
});

describe("Close Shift and the offline queue", () => {
	it("lists a sale the server refused, with customer, amount and error, and blocks the close", async () => {
		db.rows = [refused];
		const wrapper = await open();

		const box = wrapper.find('[data-testid="close-queue-attention"]');
		expect(box.exists()).toBe(true);
		expect(box.text()).toContain("1 offline sale(s) did not sync");
		const row = wrapper.find('[data-testid="close-queue-attention-row"]').text();
		expect(row).toContain("Walk-in");
		expect(row).toContain("$25.25");
		expect(row).toContain("Serial and Batch Bundle");
		expect(closeButton(wrapper).attributes("disabled")).toBe("true");

		await clickClose(wrapper);
		expect(pos.closeShift).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalled();
		wrapper.unmount();
	});

	it("opens the offline invoices list from the warning", async () => {
		db.rows = [refused];
		const events: string[] = [];
		const listener = (event: Event) => events.push(event.type);
		window.addEventListener("xpos:open-offline-panel", listener);
		const wrapper = await open();

		wrapper.findComponent('[data-testid="close-open-offline-panel"]').vm.$emit("click");
		expect(events).toEqual(["xpos:open-offline-panel"]);
		expect(pos.showClosingDialog).toBe(false);
		window.removeEventListener("xpos:open-offline-panel", listener);
		wrapper.unmount();
	});

	it("syncs waiting sales first when online, then lets the shift close", async () => {
		db.rows = [waiting];
		const wrapper = await open();

		expect(offline.syncPendingInvoices).toHaveBeenCalledTimes(1);
		expect(wrapper.find('[data-testid="close-queue-pending"]').exists()).toBe(false);
		expect(closeButton(wrapper).attributes("disabled")).toBe("false");

		await clickClose(wrapper);
		expect(pos.closeShift).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it("negative: offline, waiting sales are not synced and the close stays blocked", async () => {
		db.rows = [waiting];
		offline.isOnline = false;
		const wrapper = await open();

		expect(offline.syncPendingInvoices).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="close-queue-pending"]').text()).toContain("this till is offline");
		await clickClose(wrapper);
		expect(pos.closeShift).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it("negative: a sale refused while the dialog sat open still stops the close", async () => {
		const wrapper = await open();
		expect(closeButton(wrapper).attributes("disabled")).toBe("false");

		db.rows = [refused];
		await clickClose(wrapper);
		expect(pos.closeShift).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="close-queue-attention"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it("an empty queue closes as before", async () => {
		const wrapper = await open();
		await clickClose(wrapper);
		expect(pos.closeShift).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});

describe("classifyQueue", () => {
	const rows = (list: Array<Record<string, unknown>>) => list as unknown as PendingInvoice[];

	it("splits waiting sales from those that need attention", () => {
		const failed = { ...waiting, id: 9, status: "failed", error: "Network error" };
		const queue = classifyQueue(rows([refused, waiting, failed]), "Mule City Retail");
		expect(queue.attention.map((r) => r.id)).toEqual([7]);
		expect(queue.pending.map((r) => [r.id, r.status])).toEqual([
			[8, "pending"],
			[9, "failed"],
		]);
		expect(queue.attention[0]).toMatchObject({ customer: "Walk-in", amount: 25.25 });
	});

	it("negative: held drafts and another profile's sales do not count", () => {
		const draft = { ...waiting, id: 10, data: { is_draft: 1, pos_profile: "Mule City Retail" } };
		const otherTill = { ...refused, id: 11, data: { pos_profile: "Mill Office" } };
		const queue = classifyQueue(rows([draft, otherTill]), "Mule City Retail");
		expect(queue).toEqual({ pending: [], attention: [] });
	});
});
