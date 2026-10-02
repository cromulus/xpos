/**
 * @vitest-environment jsdom
 *
 * Counter story (MuleCity-yn4b, mc31 staging 2026-10-02): the shared cashier login
 * started the till offline in a new tab. No customer was on the cart, and the
 * customer search did not find "Walk-In Customer", so the sale went to a named
 * customer. Offline, the till must start on the profile's walk-in customer, go
 * back to it after "clear customer" and after a sale, and find it by "walk".
 * Here the till's real offline customer store (IndexedDB) holds the cached rows
 * and the server is unreachable.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const server = vi.hoisted(() => ({ getCustomer: vi.fn() }));
const pos = vi.hoisted(() => ({
	defaultCustomer: "Walk-In Customer",
	taxes: [],
	profile: {},
	profileName: "Mule City Retail",
	useOfflineMode: true,
	tenderModeFor: () => undefined,
}));
vi.mock("@/utils", async (importOriginal) => ({ ...(await importOriginal<object>()), ...server }));
vi.mock("@/services/api", () => ({ call: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => pos }));

import { cacheCustomers, db } from "@/services/idbService";
import { searchCachedCustomers } from "@/services/dbBridge";
import { selectDefaultCustomer } from "@/services/defaultCustomer";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";

const WALK_IN = {
	name: "Walk-In Customer",
	customer_name: "Walk-In Customer",
	customer_group: "Mule City Internal References",
	territory: "United States",
	tax_category: "Mule City Taxable",
	xpos_cache_rank: 5,
};
const NAMED = [
	{ name: "MC-CUST-1479", customer_name: "Stacy E Walker", customer_group: "Mule City Customers", xpos_cache_rank: 0 },
	{ name: "MC-CUST-2469", customer_name: "Walker Farms", customer_group: "Mule City Customers", xpos_cache_rank: 1 },
	{ name: "MC-CUST-4112", customer_name: "Albert Lee", customer_group: "Mule City Customers", xpos_cache_rank: 2 },
];

function goOffline(offline: boolean) {
	Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => !offline });
}

beforeEach(async () => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	server.getCustomer.mockRejectedValue(new TypeError("Failed to fetch"));
	goOffline(true);
	await cacheCustomers([...NAMED, WALK_IN] as never);
});
afterEach(async () => {
	goOffline(false);
	await db.customers.clear();
});

describe("offline, the till sells to the walk-in customer", () => {
	it("an offline cold start puts the walk-in on the cart, with its cached tax context", async () => {
		const cart = useCartStore();
		expect(cart.customer).toBeNull();
		await selectDefaultCustomer();
		expect(cart.customer).toMatchObject({
			name: "Walk-In Customer",
			customer_name: "Walk-In Customer",
			tax_category: "Mule City Taxable",
			customer_group: "Mule City Internal References",
		});
		expect(server.getCustomer).not.toHaveBeenCalled();
	});

	it("with nothing cached it still starts on the walk-in by ID (never no customer)", async () => {
		await db.customers.clear();
		const cart = useCartStore();
		await selectDefaultCustomer();
		expect(cart.customer?.name).toBe("Walk-In Customer");
		expect(server.getCustomer).not.toHaveBeenCalled();
	});

	it("clear customer (and the next sale) return to the walk-in's full row", async () => {
		const cart = useCartStore();
		cart.setCustomer(NAMED[2] as never);
		cart.clearAll();
		expect(cart.customer?.name).toBe("Walk-In Customer");
		await selectDefaultCustomer();
		expect(cart.customer?.tax_category).toBe("Mule City Taxable");
	});

	it("a customer chosen meanwhile is not replaced", async () => {
		const cart = useCartStore();
		cart.setCustomer(NAMED[2] as never);
		await selectDefaultCustomer();
		expect(cart.customer?.name).toBe("MC-CUST-4112");
	});

	it("the offline search finds it by 'walk' and by its ID", async () => {
		expect((await searchCachedCustomers("walk")).map((c) => c.name)).toContain("Walk-In Customer");
		expect((await searchCachedCustomers("walk-in")).map((c) => c.name)).toEqual(["Walk-In Customer"]);
		const store = useCustomerStore();
		await store.searchCustomers("Walk-In");
		expect(store.customers.map((c) => c.name)).toEqual(["Walk-In Customer"]);
	});

	it("online, an uncached default still comes from the server", async () => {
		await db.customers.clear();
		goOffline(false);
		server.getCustomer.mockResolvedValue({ ...WALK_IN });
		const cart = useCartStore();
		await selectDefaultCustomer();
		expect(server.getCustomer).toHaveBeenCalledWith("Walk-In Customer");
		expect(cart.customer?.tax_category).toBe("Mule City Taxable");
	});
});
