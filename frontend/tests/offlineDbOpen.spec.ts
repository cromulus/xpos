/**
 * User story (Mule City, 2026-10-02, MuleCity-pg10): on Bill's Safari the till stopped
 * after loading tax_context and never asked for items: opening the offline database
 * (xpos_offline_v3) waited forever. Opening it now gives up when another tab blocks it or
 * when it takes longer than DB_OPEN_TIMEOUT_MS, tells the cashier what to do, and every
 * later offline-data call fails at once so the till carries on online.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DB_NAME = "xpos_offline_v3";

async function loadModules() {
	vi.resetModules();
	const idb = await import("@/services/idbService");
	const status = await import("@/services/offlineDbStatus");
	return { idb, status };
}

/** Settles within `ms`, or reports "pending". */
function settleWithin<T>(promise: Promise<T>, ms = 200): Promise<"resolved" | "rejected" | "pending"> {
	return Promise.race([
		promise.then(
			() => "resolved" as const,
			() => "rejected" as const,
		),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
	]);
}

/** A connection at an older version that ignores versionchange, like a frozen background tab. */
function holdOldVersion(factory: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = factory.open(DB_NAME, 10);
		req.onupgradeneeded = () => req.result.createObjectStore("meta", { keyPath: "key" });
		req.onsuccess = () => {
			req.result.onversionchange = () => {
				/* frozen: never closes */
			};
			resolve(req.result);
		};
		req.onerror = () => reject(req.error);
	});
}

let factory: IDBFactory;

beforeEach(() => {
	factory = new IDBFactory();
	Dexie.dependencies.indexedDB = factory;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("opening the offline database", () => {
	it("opens normally and the till keeps its offline mode", async () => {
		const { idb, status } = await loadModules();
		await idb.ensureDatabaseReady();
		await idb.setMeta("k", 1);
		expect(await idb.getMeta("k")).toBe(1);
		expect(status.offlineDbUnavailable.value).toBeNull();
		idb.db.close();
	});

	it("rejects with a 'close other tabs' error when another tab blocks the upgrade", async () => {
		const holder = await holdOldVersion(factory);
		const { idb, status } = await loadModules();
		const events: Event[] = [];
		window.addEventListener(status.OFFLINE_DB_UNAVAILABLE_EVENT, (e) => events.push(e));

		const error = await idb.ensureDatabaseReady().catch((e) => e);

		expect(error).toBeInstanceOf(status.OfflineDbUnavailableError);
		expect(error.reason).toBe("blocked");
		expect(error.userMessage).toMatch(/another X POS tab or window/);
		expect(error.userMessage).toMatch(/Close the other X POS tabs, then reload/);
		expect(error.userMessage).toMatch(/keeps working online/);
		expect(status.offlineDbUnavailable.value).toBe(error);
		expect(events).toHaveLength(1);
		expect((events[0] as CustomEvent).detail).toBe(error);

		// Later offline-data calls fail at once instead of queueing behind the stuck open.
		expect(await settleWithin(idb.getMeta("k"))).toBe("rejected");
		expect(await settleWithin(idb.getCachedItems())).toBe("rejected");
		// And the till does not wait again, nor wipe the database another tab is holding.
		const deleteSpy = vi.spyOn(Dexie, "delete");
		await expect(idb.ensureDatabaseReady()).rejects.toBe(error);
		expect(deleteSpy).not.toHaveBeenCalled();

		// Once the other tab lets go, a forced retry opens and clears the state.
		holder.close();
		await idb.ensureDatabaseReady(true);
		expect(status.offlineDbUnavailable.value).toBeNull();
		await idb.setMeta("k", 2);
		expect(await idb.getMeta("k")).toBe(2);
		idb.db.close();
	});

	it("rejects with a timeout error when the open never answers", async () => {
		const { idb, status } = await loadModules();
		// An open request that never fires any event (a stuck browser IndexedDB).
		vi.spyOn(factory, "open").mockImplementation(() => ({}) as IDBOpenDBRequest);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const opening = idb.ensureDatabaseReady().catch((e) => e);
		await vi.advanceTimersByTimeAsync(status.DB_OPEN_TIMEOUT_MS - 1);
		expect(status.offlineDbUnavailable.value).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		const error = await opening;
		vi.useRealTimers();

		expect(status.DB_OPEN_TIMEOUT_MS).toBe(8000);
		expect(error).toBeInstanceOf(status.OfflineDbUnavailableError);
		expect(error.reason).toBe("timeout");
		expect(error.userMessage).toMatch(/did not open within 8 seconds/);
		expect(error.userMessage).toMatch(/Close any other X POS tabs or windows, then reload/);
		expect(error.userMessage).toMatch(/clear this site's data/);
		expect(status.offlineDbUnavailable.value).toBe(error);
		expect(await settleWithin(idb.getMeta("k"))).toBe("rejected");
	});

	it("guards Dexie's implicit open too, so a plain table read cannot hang", async () => {
		const { idb, status } = await loadModules();
		vi.spyOn(factory, "open").mockImplementation(() => ({}) as IDBOpenDBRequest);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const read = idb.getMeta("k").catch((e) => e);
		await vi.advanceTimersByTimeAsync(status.DB_OPEN_TIMEOUT_MS);
		const error = await read;
		vi.useRealTimers();

		expect(error).toBeInstanceOf(Error);
		expect(status.offlineDbUnavailable.value?.reason).toBe("timeout");
	});
});

describe("posStore.useOfflineMode", () => {
	it("is off while the offline database is unavailable", async () => {
		vi.resetModules();
		const { setActivePinia, createPinia } = await import("pinia");
		setActivePinia(createPinia());
		const status = await import("@/services/offlineDbStatus");
		const { usePosStore } = await import("@/stores/posStore");
		const store = usePosStore();
		store.posProfile = { use_offline_mode: 1 } as never;
		expect(store.useOfflineMode).toBe(true);

		status.markOfflineDbUnavailable(new status.OfflineDbUnavailableError("blocked"));
		expect(store.useOfflineMode).toBe(false);

		status.clearOfflineDbUnavailable();
		expect(store.useOfflineMode).toBe(true);
	});
});
