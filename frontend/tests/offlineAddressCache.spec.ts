/**
 * @vitest-environment jsdom
 *
 * Offline cache of customers' addresses, contacts and miles (Bill 2026-10-01,
 * MuleCity-qajl.4): "we should cache addresses and contact info for customers
 * so offline can still do shipping!"
 *
 * User stories: the till opens (or syncs) online and keeps every eligible
 * customer's delivery addresses (title, both street lines, town, state, ZIP,
 * miles, the primary and shipping flags) and contacts (phones, emails) on the
 * customer rows it caches. The cache panel lists them as "Addresses". An
 * Electron till keeps the same rows in its own database: the extra keys used
 * to fail the insert there (6nb1), so the row is stored whole now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { CUSTOMER_COLUMNS, packCustomerRows, unpackCustomerRow } from "../electron/database/customerRows";

const mocks = vi.hoisted(() => ({ call: vi.fn(), cache: vi.fn(), setMeta: vi.fn() }));
vi.mock("@/services/api", () => ({ call: mocks.call }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => ({ useOfflineMode: true, profileName: "Till" }) }));
vi.mock("@/utils", () => ({ isOnline: () => true }));
vi.mock("@/services/dbBridge", () => ({
	cacheCustomers: mocks.cache,
	getCachedCustomers: vi.fn(),
	searchCachedCustomers: vi.fn(),
	setSyncMeta: mocks.setMeta,
}));

import { cachedAddressCount, useCustomerStore } from "@/stores/customerStore";
import { useCacheStatus } from "@/stores/cacheStatus";

const yard = {
	name: "ADDR-YARD", title: "Hollow Creek yard", address_line1: "77 Feed Lot Ln", address_line2: "Gate 3",
	city: "Benson", state: "NC", pincode: "27504", miles: 9.5, miles_source: "routes",
	is_primary_address: true, is_shipping_address: true,
};
const shed = { ...yard, name: "ADDR-SHED", title: null, address_line1: "5 Back Rd", address_line2: null, city: "Dunn",
	pincode: null, miles: null, miles_source: null, is_primary_address: false, is_shipping_address: false };
const hollow = {
	name: "MC-CUST-77", customer_name: "Hollow Creek", mobile_no: "919-555-0103", tax_category: null,
	xpos_has_address: true, xpos_address_count: 2,
	xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [yard, shed] },
	xpos_contacts: [{ name: "Owner", full_name: "Owner Hollow", phones: ["919-555-0103"], emails: ["o@example.com"], is_primary_contact: true }],
};
const walkIn = { name: "Walk-In", customer_name: "Walk-In" };

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
});

describe("the till keeps addresses and contacts with the customers", () => {
	it("caches the rows whole and lists Addresses in the cache panel", async () => {
		mocks.call.mockImplementation(async (method: string) =>
			method.endsWith("get_delivery_policy") ? null : { customers: [hollow, walkIn], complete: true },
		);
		await useCustomerStore().cacheAllCustomers("Till");
		const [rows] = mocks.cache.mock.calls[0];
		expect(rows[0].xpos_delivery.addresses).toEqual([yard, shed]);
		expect(rows[0].xpos_contacts[0]).toMatchObject({ phones: ["919-555-0103"], is_primary_contact: true });
		expect(useCacheStatus().states.Addresses).toMatchObject({ profile: "Till", count: 2, complete: true, error: false });
	});

	it("counts every cached address once", () => {
		expect(cachedAddressCount([hollow, walkIn, { ...walkIn, xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [] } }])).toBe(2);
	});

	it("negative: when the customers cannot be fetched, Addresses shows the failure", async () => {
		mocks.call.mockRejectedValue(new Error("down"));
		await useCustomerStore().cacheAllCustomers("Till");
		expect(useCacheStatus().states.Addresses).toMatchObject({ loading: false, error: true });
	});

	it("negative: without the delivery policy the addresses cannot be priced offline, so Addresses fails", async () => {
		mocks.call.mockImplementation(async (method: string) => {
			if (method.endsWith("get_delivery_policy")) throw new Error("down");
			return { customers: [hollow], complete: true };
		});
		await useCustomerStore().cacheAllCustomers("Till");
		expect(useCacheStatus().states.Customers).toMatchObject({ count: 1, error: false });
		expect(useCacheStatus().states.Addresses).toMatchObject({ error: true });
	});
});

describe("an Electron till stores the same rows (its customers table)", () => {
	it("keeps the table's columns and the rest as one JSON column, and gives the row back whole", () => {
		const packed = packCustomerRows([{ ...hollow, xpos_cache_rank: 0 }, { ...walkIn, xpos_cache_rank: 1 }]);
		// Every row has the same keys, all of them real columns (upsertBatch takes them from the first row).
		for (const row of packed) {
			expect(Object.keys(row)).toEqual(Object.keys(packed[0]));
			for (const key of Object.keys(row)) expect([...CUSTOMER_COLUMNS, "xpos_row"]).toContain(key);
		}
		expect(packed[0]).toMatchObject({ name: "MC-CUST-77", customer_name: "Hollow Creek", mobile_no: "919-555-0103", disabled: 0 });
		const back = unpackCustomerRow({ ...packed[0], synced_at: "2026-10-01 08:00:00" });
		expect(back).toMatchObject({ ...hollow, xpos_cache_rank: 0 });
		expect(back).not.toHaveProperty("xpos_row");
		expect(unpackCustomerRow(packed[1])).toMatchObject({ name: "Walk-In", xpos_cache_rank: 1 });
	});

	it("negative: a row with nothing extra, a missing row and a damaged column still read", () => {
		const [plain] = packCustomerRows([{ name: "C1", customer_name: "One" }]);
		expect(plain.xpos_row).toBeNull();
		expect(unpackCustomerRow(plain)).toEqual({ name: "C1", customer_name: "One", disabled: 0 });
		expect(unpackCustomerRow(null)).toBeNull();
		expect(unpackCustomerRow({ name: "C2", customer_name: "Two", xpos_row: "{oops" })).toEqual({ name: "C2", customer_name: "Two" });
	});
});
