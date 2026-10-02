/**
 * Orders in flight, fetched and kept for offline (Mule City, MuleCity-zstm.23, mxwy.10).
 *
 * Online, `load` asks the Mule app's `find_orders` and keeps every unsearched
 * list in the till's offline storage (the same sync-meta store as the tax
 * contexts), one per customer plus the everyone list. Offline (or when the
 * request cannot reach the server) it returns that last known list, searched
 * on the till, with `live: false` and its fetch time; with nothing kept it
 * returns null, which the screens show as "not known", never as "no orders".
 */
import { defineStore } from "pinia";
import { reactive } from "vue";
import { call, isNetworkError } from "@/services/api";
import { getSyncMeta, setSyncMeta } from "@/services/dbBridge";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import {
	ORDERS_LIMIT,
	customerRowsFromAll,
	orderScope,
	searchOrders,
	type OpenOrder,
	type OrdersResult,
} from "@/utils/openOrders";

const FIND_ORDERS = "mulecity_erpnext.pos_workspace.find_orders";

export function openOrdersCacheKey(profile: string, scope: string): string {
	return `open_orders::${profile}::${scope || "*"}`;
}

async function readCache(profile: string, scope: string): Promise<OrdersResult | null> {
	try {
		const raw = await getSyncMeta(openOrdersCacheKey(profile, scope));
		if (!raw) return null;
		const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as OrdersResult;
		return Array.isArray(value?.rows) && value.fetchedAt ? { ...value, live: false } : null;
	} catch {
		return null;
	}
}

async function writeCache(profile: string, scope: string, result: OrdersResult): Promise<void> {
	try {
		// A string works for both stores (IndexedDB and the Electron SQLite meta table).
		await setSyncMeta(openOrdersCacheKey(profile, scope), JSON.stringify(result));
	} catch (error) {
		console.warn("[XPOS] Could not keep the orders list for offline:", error);
	}
}

export const useOpenOrdersStore = defineStore("openOrders", () => {
	/** The latest unsearched list per scope ("" = everyone), live or last known, for the indicator. */
	const latest = reactive<Record<string, OrdersResult | null>>({});

	function scopeOf(customer: string | null | undefined): string {
		return orderScope(customer, usePosStore().defaultCustomer);
	}

	async function lastKnown(profile: string, scope: string, search: string): Promise<OrdersResult | null> {
		const cached = (await readCache(profile, scope)) ?? (scope ? customerRowsFromAll(await readCache(profile, ""), scope) : null);
		if (!cached) return null;
		return { ...cached, rows: searchOrders(cached.rows, search) };
	}

	// The till renders the cart twice (desktop and narrow layouts): one request serves both badges.
	const inFlight = new Map<string, Promise<OrdersResult | null>>();

	/** Orders in flight for a customer (none/walk-in = everyone), searched. Null = not known (offline, nothing kept). */
	function load(customer?: string | null, search = ""): Promise<OrdersResult | null> {
		const key = `${scopeOf(customer)}\u0000${(search || "").trim()}`;
		const running = inFlight.get(key);
		if (running) return running;
		const request = fetchOrders(customer, search).finally(() => inFlight.delete(key));
		inFlight.set(key, request);
		return request;
	}

	async function fetchOrders(customer?: string | null, search = ""): Promise<OrdersResult | null> {
		const profile = usePosStore().profileName;
		if (!profile) return null;
		const scope = scopeOf(customer);
		const term = (search || "").trim();
		if (!useOfflineStore().isOnline) {
			const known = await lastKnown(profile, scope, term);
			if (!term) latest[scope] = known;
			return known;
		}
		try {
			const rows =
				(await call<OpenOrder[]>(FIND_ORDERS, {
					pos_profile: profile,
					customer: scope || null,
					search: term,
					limit: ORDERS_LIMIT,
				})) ?? [];
			const result: OrdersResult = {
				rows,
				fetchedAt: Date.now(),
				live: true,
				truncated: rows.length >= ORDERS_LIMIT,
			};
			if (!term) {
				latest[scope] = result;
				await writeCache(profile, scope, result);
			}
			return result;
		} catch (error) {
			if (!isNetworkError(error)) throw error;
			const known = await lastKnown(profile, scope, term);
			if (!term) latest[scope] = known;
			return known;
		}
	}

	/** Keep the everyone list for offline (the till's background sync). Never throws. */
	async function prefetchAll(): Promise<void> {
		try {
			await load(null, "");
		} catch (error) {
			console.warn("[XPOS Sync] Failed to sync orders in flight:", error);
		}
	}

	return { latest, scopeOf, load, prefetchAll };
});
