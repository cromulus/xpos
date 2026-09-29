/**
 * User story (Mule City, 2026-09-29): Leslie sells offline; when the internet
 * returns the sales sync. A sale the server refuses (over the 25% discount
 * cap) goes straight to the "need attention" list for a manager instead of
 * retrying the same refusal; a sale that failed only because the network
 * dropped again is retried.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { db, call } = vi.hoisted(() => ({
	db: {
		rows: [] as Array<Record<string, unknown>>,
		updates: [] as Array<[number, Record<string, unknown>]>,
		deleted: [] as number[],
	},
	call: vi.fn(),
}));

vi.mock("@/services/api", () => ({
	call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ useOfflineMode: true, allowDeleteOfflineInvoice: false, profileName: "Mule City Retail" }),
}));
vi.mock("@/services/dbBridge", () => ({
	addPendingInvoice: vi.fn(),
	getAllPendingInvoices: vi.fn(async () => db.rows.map((row) => ({ ...row }))),
	updatePendingInvoice: vi.fn(async (id: number, patch: Record<string, unknown>) => {
		db.updates.push([id, patch]);
	}),
	deletePendingInvoice: vi.fn(async (id: number) => {
		db.deleted.push(id);
	}),
	countPendingInvoices: vi.fn(async () => 0),
	countDeadLetters: vi.fn(async () => 0),
	retryDeadLetter: vi.fn(),
	adjustCachedStock: vi.fn(),
}));

import { useOfflineStore } from "@/stores/offlineStore";

function serverError(message: string, excType?: string) {
	const error = new Error(message) as Error & { excType?: string };
	if (excType) error.excType = excType;
	return error;
}

beforeEach(() => {
	setActivePinia(createPinia());
	db.rows = [
		{ id: 1, local_id: "a", status: "pending", customer_name: "Walk-in", data: { customer: "Walk-in" } },
	];
	db.updates = [];
	db.deleted = [];
	call.mockReset();
});

describe("syncing offline sales", () => {
	it("posts a queued sale and removes it from the queue", async () => {
		call.mockResolvedValue({ name: "ACC-SINV-1" });
		await useOfflineStore().syncPendingInvoices();
		expect(call).toHaveBeenCalledWith("xpos.api.invoices.create_invoice", expect.objectContaining({ local_id: "a" }));
		expect(db.deleted).toEqual([1]);
	});

	it("sends a sale the server refuses straight to the need-attention list", async () => {
		call.mockRejectedValue(
			serverError("The discounts on this ticket come to 30% off; at most 25% is allowed.", "ValidationError"),
		);
		await useOfflineStore().syncPendingInvoices();
		expect(db.updates).toContainEqual([1, expect.objectContaining({ status: "dead_letter" })]);
		expect(db.deleted).toEqual([]);
	});

	it("retries a sale that failed only because the network dropped", async () => {
		call.mockRejectedValue(serverError("Failed to fetch"));
		await useOfflineStore().syncPendingInvoices();
		expect(db.updates).toContainEqual([1, expect.objectContaining({ status: "failed", retry_count: 1 })]);
	});
});
