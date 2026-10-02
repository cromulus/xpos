/**
 * User story (Bill 2026-10-01 22:52, MuleCity-qajl): the internet is down. Leslie
 * rings up Albert, who has no address on file, and adds his farm at the till with
 * the 42 miles he tells her; she sells him feed with delivery there. When the
 * internet returns, the till first makes the farm's Address on the site (miles
 * flagged as typed offline), then posts the sale shipped to that Address, never
 * the other way round. An add the site refuses is kept for review, not retried;
 * a dropped network stops the replay and the sale waits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { db, call } = vi.hoisted(() => ({
	db: {
		rows: [] as Array<Record<string, unknown>>,
		deleted: [] as number[],
		meta: new Map<string, string>(),
		ids: new Map<string, string>(),
	},
	call: vi.fn(),
}));

vi.mock("@/services/api", () => ({ call, showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ useOfflineMode: true, allowDeleteOfflineInvoice: false, profileName: "Mule City Retail" }),
}));
vi.mock("@/services/dbBridge", () => ({
	addPendingInvoice: vi.fn(),
	getAllPendingInvoices: vi.fn(async () => db.rows.map((row) => ({ ...row }))),
	updatePendingInvoice: vi.fn(async () => undefined),
	deletePendingInvoice: vi.fn(async (id: number) => void db.deleted.push(id)),
	countPendingInvoices: vi.fn(async () => 0),
	countDeadLetters: vi.fn(async () => 0),
	retryDeadLetter: vi.fn(),
	adjustCachedStock: vi.fn(),
	getSyncMeta: vi.fn(async (key: string) => db.meta.get(key) ?? null),
	setSyncMeta: vi.fn(async (key: string, value: string) => void db.meta.set(key, value)),
	addSyncId: vi.fn(async (local: string, server: string) => void db.ids.set(local, server)),
	getServerName: vi.fn(async (local: string) => db.ids.get(local) ?? null),
	getCustomer: vi.fn(async () => null),
	upsertCustomers: vi.fn(),
}));

import { useOfflineStore } from "@/stores/offlineStore";
import {
	queueAddress,
	queuedAddresses,
	replayQueuedAddresses,
	resolveQueuedAddress,
	withAddress,
	type QueuedAddress,
} from "@/services/addressQueue";

const farm: QueuedAddress = {
	local_id: "LOCAL-ADDR-farm",
	customer: "MC-CUST-4112",
	address_line1: "88 New Ground Rd",
	city: "Coats",
	state: "NC",
	pincode: "27521",
	miles: 42,
	queued_at: "2026-10-01T10:00:00Z",
};

/** The sale Leslie rang up offline, shipped to the farm by its local id. */
const sale = {
	customer: "MC-CUST-4112",
	xpos_new_shipping_address: { address_line1: "88 New Ground Rd", city: "Coats", state: "NC", pincode: "27521", miles: 42, local_id: farm.local_id },
	xpos_delivery: { amount: 105, source: "miles", miles: 42, miles_source: "manual_offline", address: farm.local_id },
	pos_delivery_miles: 42,
	pos_delivery_miles_source: "manual",
};

function networkDown() {
	return new Error("Failed to fetch");
}

beforeEach(() => {
	setActivePinia(createPinia());
	db.rows = [{ id: 1, local_id: "inv-1", status: "pending", customer_name: "Albert Adkins", data: sale }];
	db.deleted = [];
	db.meta = new Map();
	db.ids = new Map();
	call.mockReset();
});

describe("addresses added offline sync before the sales that ship there", () => {
	it("makes the address first (miles flagged manual_offline), then posts the sale to that Address", async () => {
		await queueAddress(farm);
		call.mockImplementation(async (method: string) =>
			method.endsWith("add_delivery_address") ? { name: "Albert Adkins-Shipping", miles: 42.6 } : { name: "ACC-SINV-1" },
		);
		await useOfflineStore().syncPendingInvoices();

		expect(call.mock.calls.map(([method]) => method)).toEqual([
			"xpos.api.customers.add_delivery_address",
			"xpos.api.invoices.create_invoice",
		]);
		expect(call.mock.calls[0][1]).toEqual({
			customer: "MC-CUST-4112", address_line1: "88 New Ground Rd", address_line2: null, city: "Coats", state: "NC",
			pincode: "27521", title: null, delivery_miles: 42, miles_source: "manual_offline", local_id: "LOCAL-ADDR-farm",
		});
		const posted = JSON.parse(call.mock.calls[1][1].data);
		expect(posted.shipping_address_name).toBe("Albert Adkins-Shipping");
		expect(posted.xpos_new_shipping_address).toBeUndefined();
		expect(posted.xpos_delivery.address).toBe("Albert Adkins-Shipping");
		expect(db.deleted).toEqual([1]);
		expect(await queuedAddresses()).toEqual([]);
	});

	it("an address added offline with no sale is still made at sync", async () => {
		db.rows = [];
		await queueAddress(farm);
		call.mockResolvedValue({ name: "Albert Adkins-Shipping" });
		await useOfflineStore().syncPendingInvoices();
		expect(call).toHaveBeenCalledTimes(1);
		expect(db.ids.get(farm.local_id)).toBe("Albert Adkins-Shipping");
	});

	it("negative: the network drops while making the address: the sale is not sent and both wait", async () => {
		await queueAddress(farm);
		call.mockRejectedValueOnce(networkDown()).mockRejectedValue(networkDown());
		await useOfflineStore().syncPendingInvoices();
		expect(call.mock.calls[0][0]).toBe("xpos.api.customers.add_delivery_address");
		// The sale carries the whole address, so even sent it could not ship anywhere else.
		const sent = call.mock.calls.slice(1).map(([, args]) => JSON.parse(args.data));
		for (const data of sent) expect(data.xpos_new_shipping_address.local_id).toBe(farm.local_id);
		expect(db.deleted).toEqual([]);
		expect((await queuedAddresses()).map((row) => row.local_id)).toEqual([farm.local_id]);
	});

	it("negative: an add the site refuses is kept for review and not retried; the sale still carries its address", async () => {
		await queueAddress(farm);
		call.mockImplementation(async (method: string) => {
			if (method.endsWith("add_delivery_address")) {
				const error = new Error("A delivery address needs its ZIP") as Error & { excType?: string };
				error.excType = "ValidationError";
				throw error;
			}
			return { name: "ACC-SINV-1" };
		});
		await useOfflineStore().syncPendingInvoices();
		const posted = JSON.parse(call.mock.calls[1][1].data);
		expect(posted.xpos_new_shipping_address.local_id).toBe(farm.local_id);
		const [kept] = await queuedAddresses();
		expect(kept.refused).toContain("needs its ZIP");
		call.mockClear();
		await replayQueuedAddresses();
		expect(call).not.toHaveBeenCalled();
	});
});

describe("the queue itself", () => {
	it("replays oldest first and swaps local ids only for addresses it made", async () => {
		const made: string[] = [];
		const ids = new Map<string, string>();
		let queue: QueuedAddress[] = [];
		const deps = {
			load: async () => queue,
			save: async (next: QueuedAddress[]) => void (queue = next),
			add: async (queued: QueuedAddress) => (made.push(queued.local_id), { name: `ADDR-${queued.local_id}`, address_line1: "", city: "", miles: null, miles_source: null }),
			remember: async (local: string, server: string) => void ids.set(local, server),
			serverName: async (local: string) => ids.get(local) ?? null,
			isNetworkError: () => false,
		};
		await queueAddress({ ...farm, local_id: "LOCAL-ADDR-1" }, deps);
		await queueAddress({ ...farm, local_id: "LOCAL-ADDR-2" }, deps);
		expect(await replayQueuedAddresses(deps)).toMatchObject({ added: 2, stopped: false });
		expect(made).toEqual(["LOCAL-ADDR-1", "LOCAL-ADDR-2"]);
		expect((await resolveQueuedAddress({ xpos_new_shipping_address: { local_id: "LOCAL-ADDR-2" } }, deps)).shipping_address_name).toBe(
			"ADDR-LOCAL-ADDR-2",
		);
		const unknown = { xpos_new_shipping_address: { local_id: "LOCAL-ADDR-9" } };
		expect(await resolveQueuedAddress(unknown, deps)).toBe(unknown);
	});

	it("a new primary shipping address goes first in the customer's cached list and takes the flag", () => {
		const yard = { name: "ADDR-YARD", address_line1: "77 Feed Lot Ln", city: "Benson", miles: 9, miles_source: "routes", is_shipping_address: true };
		const details = { standing_charge: 0, no_charge: false, addresses: [yard] };
		const added = { name: "LOCAL-ADDR-1", address_line1: "88 New Ground Rd", city: "Coats", miles: 42, miles_source: "manual_offline" };
		expect(withAddress(details, added).addresses.map((a) => a.name)).toEqual(["ADDR-YARD", "LOCAL-ADDR-1"]);
		const primary = withAddress(details, { ...added, is_shipping_address: true });
		expect(primary.addresses.map((a) => [a.name, a.is_shipping_address])).toEqual([["LOCAL-ADDR-1", true], ["ADDR-YARD", false]]);
		// Synced: the site's Address takes the local entry's place.
		const synced = withAddress(primary, { ...added, name: "ADDR-FARM" }, "LOCAL-ADDR-1");
		expect(synced.addresses.map((a) => a.name)).toEqual(["ADDR-YARD", "ADDR-FARM"]);
	});
});
