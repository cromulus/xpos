/**
 * User story (Mule City, MuleCity-q8aq): Leslie sold offline from a till that started offline. When
 * the internet returns, the till asks for a fresh boot and CSRF token before it sends the queued
 * sales. If the cashier's session expired meanwhile, it shows the login and the queued sales stay
 * exactly as they were: no retry counted, nothing sent to the need-attention list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { db, call, ensureFreshSession, replayQueuedAddresses } = vi.hoisted(() => ({
	db: {
		rows: [] as Array<Record<string, unknown>>,
		updates: [] as Array<[number, Record<string, unknown>]>,
		deleted: [] as number[],
	},
	call: vi.fn(),
	ensureFreshSession: vi.fn(),
	replayQueuedAddresses: vi.fn(async () => ({ refused: [] })),
}));

vi.mock("@/services/api", () => ({ call, showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/sessionBoot", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/sessionBoot")>()),
	ensureFreshSession,
}));
vi.mock("@/services/addressQueue", () => ({
	replayQueuedAddresses,
	resolveQueuedAddress: async (data: unknown) => data,
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
import { SessionExpiredError } from "@/services/sessionBoot";

beforeEach(() => {
	setActivePinia(createPinia());
	db.rows = [
		{ id: 1, local_id: "a", status: "pending", customer_name: "Walk-in", data: { customer: "Walk-in" } },
		{ id: 2, local_id: "b", status: "failed", retry_count: 1, customer_name: "Walk-in", data: { customer: "Walk-in" } },
	];
	db.updates = [];
	db.deleted = [];
	call.mockReset();
	ensureFreshSession.mockReset();
	replayQueuedAddresses.mockClear();
});

describe("syncing after an offline start", () => {
	it("refreshes the session before the addresses and sales go", async () => {
		const order: string[] = [];
		ensureFreshSession.mockImplementation(async () => void order.push("session"));
		replayQueuedAddresses.mockImplementation(async () => (order.push("addresses"), { refused: [] }));
		call.mockImplementation(async () => (order.push("sale"), { name: "ACC-SINV-1" }));

		await useOfflineStore().syncPendingInvoices();

		expect(order).toEqual(["session", "addresses", "sale", "sale"]);
		expect(db.deleted).toEqual([1, 2]);
	});

	it("leaves the whole queue untouched when the session has expired", async () => {
		ensureFreshSession.mockRejectedValue(new SessionExpiredError(401));

		await useOfflineStore().syncPendingInvoices();

		expect(replayQueuedAddresses).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
		expect(db.updates).toEqual([]);
		expect(db.deleted).toEqual([]);
	});

	it("leaves the whole queue untouched when the server cannot be reached for the refresh", async () => {
		ensureFreshSession.mockRejectedValue(new Error("__offline__"));
		await useOfflineStore().syncPendingInvoices();
		expect(call).not.toHaveBeenCalled();
		expect(db.updates).toEqual([]);
	});

	it("stops without counting a retry when the session ends mid-sync", async () => {
		ensureFreshSession.mockResolvedValue(undefined);
		call.mockRejectedValue(new SessionExpiredError(401));

		await useOfflineStore().syncPendingInvoices();

		expect(call).toHaveBeenCalledTimes(1);
		// The sale it tried goes back to pending; the other is not touched.
		expect(db.updates).toEqual([
			[1, { status: "syncing" }],
			[1, { status: "pending" }],
		]);
		expect(db.updates.some(([, patch]) => "retry_count" in patch || patch.status === "dead_letter")).toBe(false);
		expect(db.deleted).toEqual([]);
	});
});
