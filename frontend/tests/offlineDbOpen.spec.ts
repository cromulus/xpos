/**
 * @vitest-environment jsdom
 *
 * Opening the offline database (IndexedDB) must never hang the app. When another tab
 * holds an older version and does not let go (a frozen background tab), or the browser's
 * IndexedDB never answers, opening gives up, tells the user what to do, and every later
 * offline-data call fails at once so the app carries on online.
 *
 * jsdom has no IndexedDB, so a small scripted IDBFactory stands in for the browser's:
 * each open request is answered (or not) the way the test says.
 */
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OpenBehaviour = "blocked" | "silent" | "success";

/** A scripted IDBFactory: each open() is answered according to `behaviour`. */
function scriptedFactory() {
	const factory = {
		behaviour: "success" as OpenBehaviour,
		opens: 0,
		deletes: 0,
		open: vi.fn((_name: string, version?: number) => {
			factory.opens++;
			const req: Record<string, any> = {};
			const behaviour = factory.behaviour;
			setTimeout(() => {
				if (behaviour === "blocked") {
					req.onblocked?.({ oldVersion: 10, newVersion: version });
				} else if (behaviour === "success") {
					req.result = {
						version,
						objectStoreNames: [],
						close: () => {},
						transaction: () => {
							throw new Error("no stores in the scripted database");
						},
					};
					req.onsuccess?.({ target: req });
				}
				// "silent": never answers, like a stuck browser IndexedDB.
			}, 0);
			return req as unknown as IDBOpenDBRequest;
		}),
		deleteDatabase: vi.fn(() => {
			factory.deletes++;
			return {} as IDBOpenDBRequest;
		}),
		cmp: (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1),
	};
	return factory;
}

let factory: ReturnType<typeof scriptedFactory>;
const originalIndexedDB = Dexie.dependencies.indexedDB;

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

beforeEach(() => {
	factory = scriptedFactory();
	Dexie.dependencies.indexedDB = factory as unknown as IDBFactory;
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	Dexie.dependencies.indexedDB = originalIndexedDB;
});

describe("opening the offline database", () => {
	it("opens normally and leaves offline mode available", async () => {
		const { idb, status } = await loadModules();
		await idb.ensureDatabaseReady();
		expect(idb.db.isOpen()).toBe(true);
		expect(status.offlineDbUnavailable.value).toBeNull();
		idb.db.close();
	});

	it("rejects with a 'close other tabs' error when another tab blocks the upgrade", async () => {
		factory.behaviour = "blocked";
		const { idb, status } = await loadModules();
		const events: Event[] = [];
		const listener = (e: Event) => events.push(e);
		window.addEventListener(status.OFFLINE_DB_UNAVAILABLE_EVENT, listener);

		const error = await idb.ensureDatabaseReady().catch((e) => e);
		window.removeEventListener(status.OFFLINE_DB_UNAVAILABLE_EVENT, listener);

		expect(error).toBeInstanceOf(status.OfflineDbUnavailableError);
		expect(error.reason).toBe("blocked");
		expect(error.userMessage).toMatch(/another X POS tab or window/);
		expect(error.userMessage).toMatch(/Close the other X POS tabs, then reload/);
		expect(error.userMessage).toMatch(/keeps working online/);
		expect(status.offlineDbUnavailable.value).toBe(error);
		expect(events).toHaveLength(1);
		expect((events[0] as CustomEvent).detail).toBe(error);

		// Later offline-data calls fail at once instead of queueing behind the stuck open.
		const opensSoFar = factory.opens;
		expect(await settleWithin(idb.getMeta("k"))).toBe("rejected");
		expect(await settleWithin(idb.getCachedItems())).toBe("rejected");
		// And the app does not wait again, nor wipe the database another tab is holding.
		await expect(idb.ensureDatabaseReady()).rejects.toBe(error);
		expect(factory.opens).toBe(opensSoFar);
		expect(factory.deletes).toBe(0);

		// Once the other tab lets go, a forced retry opens and clears the state.
		factory.behaviour = "success";
		await idb.ensureDatabaseReady(true);
		expect(idb.db.isOpen()).toBe(true);
		expect(status.offlineDbUnavailable.value).toBeNull();
		idb.db.close();
	});

	it("rejects with a timeout error when the open never answers", async () => {
		factory.behaviour = "silent";
		const { idb, status } = await loadModules();
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
		expect(factory.deletes).toBe(0);
	});

	it("guards Dexie's implicit open too, so a plain table read cannot hang", async () => {
		factory.behaviour = "silent";
		const { idb, status } = await loadModules();
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
