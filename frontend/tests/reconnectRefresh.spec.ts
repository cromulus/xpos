/**
 * @vitest-environment jsdom
 *
 * MuleCity-rcxk: after the till went offline and came back, the status read
 * "Online · check data sync" for up to five minutes although everything was
 * cached. The periodic refresh that fell while offline was skipped and the stale
 * limit equalled the refresh interval. Now the caches refresh once the network
 * has been back for a moment (once, however much it flaps), and the stale limit
 * has margin over the interval. A failed refresh still reads stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { call, cacheAllItems, cacheAllCustomers, prefetchAll } = vi.hoisted(() => ({
	call: vi.fn(async () => ({})),
	cacheAllItems: vi.fn(async () => {}),
	cacheAllCustomers: vi.fn(async () => {}),
	prefetchAll: vi.fn(async () => {}),
}));

vi.mock("@/services/api", () => ({ call, default: { call }, showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	countPendingInvoices: vi.fn(async () => 0),
	countDeadLetters: vi.fn(async () => 0),
	cacheTaxContexts: vi.fn(async () => {}),
}));
vi.mock("@/services/vfdOffline", () => ({
	attachOfflineCoverage: vi.fn(),
	refreshVfdContext: vi.fn(),
	queuedInvoiceMethod: () => "xpos.api.invoices.create_invoice",
}));
vi.mock("@/stores/itemStore", () => ({ useItemStore: () => ({ cacheAllItems }) }));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => ({ cacheAllCustomers }) }));
vi.mock("@/stores/openOrdersStore", () => ({ useOpenOrdersStore: () => ({ prefetchAll }) }));

import { useOfflineStore } from "@/stores/offlineStore";
import { usePosStore } from "@/stores/posStore";
import {
	CACHE_STALE_MS,
	CACHE_SYNC_INTERVAL_MS,
	RECONNECT_REFRESH_DELAY_MS,
	isCacheFresh,
} from "@/utils/cacheFreshness";

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the cache stale limit", () => {
	const fresh = { complete: true, error: false, loading: false, updatedAt: 0 };

	it("has margin over the refresh interval", () => {
		expect(CACHE_STALE_MS).toBe(CACHE_SYNC_INTERVAL_MS * 1.5);
		expect(isCacheFresh(fresh, CACHE_SYNC_INTERVAL_MS + 1000)).toBe(true);
		expect(isCacheFresh(fresh, CACHE_STALE_MS - 1)).toBe(true);
		expect(isCacheFresh(fresh, CACHE_STALE_MS + 1000)).toBe(false);
	});

	it("still reads stale when the refresh failed, is incomplete or never ran", () => {
		expect(isCacheFresh({ ...fresh, error: true }, 1000)).toBe(false);
		expect(isCacheFresh({ ...fresh, complete: false }, 1000)).toBe(false);
		expect(isCacheFresh({ ...fresh, loading: true }, 1000)).toBe(false);
		expect(isCacheFresh(undefined, 1000)).toBe(false);
	});
});

describe("refresh on reconnect", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setActivePinia(createPinia());
		const pos = usePosStore();
		pos.isReady = true;
		pos.posProfile = { name: "Mule City Retail" } as never;
		cacheAllItems.mockClear();
		cacheAllCustomers.mockClear();
		prefetchAll.mockClear();
	});

	afterEach(() => {
		useOfflineStore().destroy();
		vi.useRealTimers();
	});

	async function startOnline() {
		const offline = useOfflineStore();
		offline.init(); // runs the first periodic refresh at once
		await vi.waitFor(() => expect(prefetchAll).toHaveBeenCalledTimes(1));
		cacheAllItems.mockClear();
		cacheAllCustomers.mockClear();
		prefetchAll.mockClear();
		return offline;
	}

	it("refreshes the caches once the network has come back, without waiting for the next interval", async () => {
		await startOnline();
		window.dispatchEvent(new Event("offline"));
		window.dispatchEvent(new Event("online"));
		await flush();
		expect(cacheAllItems).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(RECONNECT_REFRESH_DELAY_MS);
		await flush();
		expect(cacheAllItems).toHaveBeenCalledTimes(1);
		expect(cacheAllItems).toHaveBeenCalledWith("Mule City Retail");
		expect(cacheAllCustomers).toHaveBeenCalledTimes(1);
		expect(prefetchAll).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith("mulecity_erpnext.pos_workspace.tax_contexts", { pos_profile: "Mule City Retail" });
	});

	it("a flapping network refreshes once, after it settles", async () => {
		await startOnline();
		for (let i = 0; i < 5; i++) {
			window.dispatchEvent(new Event("offline"));
			window.dispatchEvent(new Event("online"));
			await vi.advanceTimersByTimeAsync(RECONNECT_REFRESH_DELAY_MS / 3);
		}
		expect(cacheAllItems).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RECONNECT_REFRESH_DELAY_MS);
		await flush();
		expect(cacheAllItems).toHaveBeenCalledTimes(1);
	});

	it("going offline again before it settles cancels the refresh", async () => {
		await startOnline();
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(RECONNECT_REFRESH_DELAY_MS / 2);
		window.dispatchEvent(new Event("offline"));
		await vi.advanceTimersByTimeAsync(RECONNECT_REFRESH_DELAY_MS * 2);
		await flush();
		expect(cacheAllItems).not.toHaveBeenCalled();
	});
});
