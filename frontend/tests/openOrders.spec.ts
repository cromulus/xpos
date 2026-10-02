/**
 * @vitest-environment jsdom
 *
 * Counter stories (Bill 2026-09-30/10-01, MuleCity-zstm.23, mxwy.10): Leslie
 * presses "Orders". Nobody chosen: every order in flight. Albert chosen: his,
 * still searchable. Next to Albert's name a badge says he has orders, and a
 * ready one stands out. With the internet down the till shows the last list it
 * had, with its time, or says it does not know: never "no orders".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { reactive } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const api = vi.hoisted(() => ({
	call: vi.fn(),
	showInfo: vi.fn(),
	isNetworkError: (e: unknown) => (e as Error)?.message === "Failed to fetch",
}));
vi.mock("@/services/api", () => api);
const meta = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/services/dbBridge", () => ({
	getSyncMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
	setSyncMeta: vi.fn(async (key: string, value: unknown) => meta.set(key, value)),
	getCustomer: vi.fn(async () => null),
}));
const net = vi.hoisted(() => ({ state: null as unknown as { isOnline: boolean } }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: () => net.state }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ profileName: "Till", defaultCustomer: "Walk-In", taxes: [], profile: {}, tenderModeFor: () => undefined }),
}));

import { useOpenOrdersStore, openOrdersCacheKey } from "@/stores/openOrdersStore";
import { useCartStore } from "@/stores/cartStore";
import CustomerOrdersBadge from "@/components/cart/CustomerOrdersBadge.vue";
import OpenOrdersPanel from "@/components/orders/OpenOrdersPanel.vue";
import { ORDERS_LIMIT, orderScope, searchOrders, summarizeOrders, customerRowsFromAll } from "@/utils/openOrders";

const albertReady = { name: "SAL-ORD-1", customer: "MC-4112", customer_name: "ALBERT ADKINS", readiness: "ready", progress: "Production complete — check collection" };
const albertWaiting = { name: "SAL-ORD-2", customer: "MC-4112", customer_name: "ALBERT ADKINS", readiness: "open" };
const albertDelivered = { name: "SAL-ORD-4", customer: "MC-4112", customer_name: "ALBERT ADKINS", readiness: "delivered", progress: "Delivered on MAT-DN-1 – not billed", delivery_notes: ["MAT-DN-1"] };
const bettyMill = { name: "SAL-ORD-3", customer: "MC-0007", customer_name: "BETTY BROWN", readiness: "in_production" };

function findOrders(rows: object[]) {
	api.call.mockImplementation(async (method: string, args: { customer?: string | null }) => {
		if (method.endsWith("find_orders")) return rows.filter((r: any) => !args.customer || r.customer === args.customer);
		throw new Error("unexpected " + method);
	});
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	meta.clear();
	net.state = reactive({ isOnline: true });
});

describe("who the list is for, and searching it on the till", () => {
	it("nobody or the walk-in customer means every order in flight", () => {
		expect(orderScope(null, "Walk-In")).toBe("");
		expect(orderScope("Walk-In", "Walk-In")).toBe("");
		expect(orderScope("MC-4112", "Walk-In")).toBe("MC-4112");
	});
	it("searches number, code and name, every word", () => {
		const rows = [albertReady, albertWaiting, bettyMill];
		expect(searchOrders(rows, "betty").map((r) => r.name)).toEqual(["SAL-ORD-3"]);
		expect(searchOrders(rows, "ORD-2").map((r) => r.name)).toEqual(["SAL-ORD-2"]);
		expect(searchOrders(rows, "adkins ord-1").map((r) => r.name)).toEqual(["SAL-ORD-1"]);
		expect(searchOrders(rows, "  ")).toHaveLength(3);
	});
	it("counts orders in flight and ready ones", () => {
		expect(summarizeOrders([albertReady, albertWaiting])).toEqual({ inFlight: 2, ready: 1, delivered: 0 });
		expect(summarizeOrders([albertDelivered])).toEqual({ inFlight: 1, ready: 0, delivered: 1 });
	});
	it("takes one customer's rows from the everyone list only when that list was complete", () => {
		const all = { rows: [albertReady, bettyMill], fetchedAt: 1, live: true, truncated: false };
		expect(customerRowsFromAll(all, "MC-0007")?.rows).toEqual([bettyMill]);
		expect(customerRowsFromAll({ ...all, truncated: true }, "MC-0007")).toBeNull();
	});
});

describe("the orders store online and offline", () => {
	it("online: asks the server, scoped, and keeps the unsearched list for offline", async () => {
		findOrders([albertReady, bettyMill]);
		const result = await useOpenOrdersStore().load("MC-4112");
		expect(api.call).toHaveBeenCalledWith("mulecity_erpnext.pos_workspace.find_orders", {
			pos_profile: "Till", customer: "MC-4112", search: "", limit: ORDERS_LIMIT,
		});
		expect(result).toMatchObject({ live: true, truncated: false, rows: [albertReady] });
		expect(JSON.parse(meta.get(openOrdersCacheKey("Till", "MC-4112")) as string).rows).toEqual([albertReady]);
	});
	it("walk-in asks for everyone; a searched list is not kept", async () => {
		findOrders([albertReady, bettyMill]);
		await useOpenOrdersStore().load("Walk-In", "betty");
		expect(api.call.mock.calls[0][1]).toMatchObject({ customer: null, search: "betty" });
		expect(meta.size).toBe(0);
	});
	it("a full page says there may be more", async () => {
		findOrders(Array.from({ length: ORDERS_LIMIT }, (_, i) => ({ ...bettyMill, name: "SO-" + i })));
		expect((await useOpenOrdersStore().load(null))!.truncated).toBe(true);
	});
	it("offline: the last known list with its time, searched on the till", async () => {
		findOrders([albertReady, albertWaiting, bettyMill]);
		const store = useOpenOrdersStore();
		const online = await store.load(null);
		net.state.isOnline = false;
		api.call.mockClear();
		const offline = await store.load(null, "betty");
		expect(api.call).not.toHaveBeenCalled();
		expect(offline).toMatchObject({ live: false, fetchedAt: online!.fetchedAt });
		expect(offline!.rows.map((r) => r.name)).toEqual(["SAL-ORD-3"]);
		// A customer never fetched on their own: their rows from the complete everyone list.
		expect((await store.load("MC-4112"))!.rows.map((r) => r.name)).toEqual(["SAL-ORD-1", "SAL-ORD-2"]);
	});
	it("offline with nothing kept: not known (null), never an empty list", async () => {
		net.state.isOnline = false;
		expect(await useOpenOrdersStore().load("MC-4112")).toBeNull();
	});
	it("a request that cannot reach the server falls back to the last known list", async () => {
		findOrders([bettyMill]);
		const store = useOpenOrdersStore();
		await store.load(null);
		api.call.mockRejectedValue(new Error("Failed to fetch"));
		expect(await store.load(null)).toMatchObject({ live: false, rows: [bettyMill] });
	});
	it("a server refusal is an error, not an empty list", async () => {
		api.call.mockRejectedValue(new Error("This register is not assigned to you."));
		await expect(useOpenOrdersStore().load(null)).rejects.toThrow("not assigned");
	});
});

function router() {
	const r = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: "/pos", name: "pos", component: { template: "<div/>" } },
			{ path: "/orders", name: "orders", component: { template: "<div/>" } },
		],
	});
	return r;
}

describe("the indicator next to the customer's name", () => {
	let wrapper: ReturnType<typeof mount> | null = null;
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
	});
	async function badgeFor(customer: string) {
		const r = router();
		await r.push("/pos");
		useCartStore().setCustomer({ name: customer, customer_name: customer });
		wrapper = mount(CustomerOrdersBadge, { global: { plugins: [r] } });
		await flushPromises();
		return { r, badge: wrapper.find("[data-testid='customer-orders-indicator']") };
	}

	it("a ready order stands out, and clicking opens their orders", async () => {
		findOrders([albertReady, albertWaiting]);
		const { r, badge } = await badgeFor("MC-4112");
		expect(badge.exists()).toBe(true);
		expect(badge.text()).toContain("1 ready");
		expect(badge.classes()).toContain("bg-emerald-600");
		await badge.trigger("click");
		await flushPromises();
		expect(r.currentRoute.value.name).toBe("orders");
		expect(r.currentRoute.value.query.customer).toBe("MC-4112");
	});
	it("a delivered order is shown, but never as ready for pickup", async () => {
		findOrders([albertDelivered]);
		const { badge } = await badgeFor("MC-4112");
		expect(badge.text()).toContain("1 order · 1 delivered");
		expect(badge.classes()).not.toContain("bg-emerald-600");
		expect(badge.attributes("data-ready")).toBe("0");
	});
	it("orders in flight but none ready: a quiet count", async () => {
		findOrders([albertWaiting]);
		const { badge } = await badgeFor("MC-4112");
		expect(badge.text()).toContain("1 order");
		expect(badge.classes()).not.toContain("bg-emerald-600");
	});
	it("a customer with none: no indicator", async () => {
		findOrders([bettyMill]);
		expect((await badgeFor("MC-4112")).badge.exists()).toBe(false);
	});
	it("walk-in: no indicator and no request", async () => {
		findOrders([bettyMill]);
		expect((await badgeFor("Walk-In")).badge.exists()).toBe(false);
		expect(api.call.mock.calls.filter(([method]) => String(method).endsWith("find_orders"))).toEqual([]);
	});
	it("offline: the last known count with its time, or nothing", async () => {
		net.state.isOnline = false;
		expect((await badgeFor("MC-4112")).badge.exists()).toBe(false);
		wrapper!.unmount();
		meta.set(openOrdersCacheKey("Till", "MC-4112"), JSON.stringify({ rows: [albertReady], fetchedAt: Date.now(), live: true, truncated: false }));
		const { badge } = await badgeFor("MC-4112");
		expect(badge.text()).toMatch(/1 ready\s*\(.+\)/);
		expect(badge.attributes("title")).toContain("last known");
	});
});

describe("the Orders view", () => {
	let wrapper: ReturnType<typeof mount> | null = null;
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
	});
	async function view(query: Record<string, string> = {}) {
		const r = router();
		await r.push({ path: "/orders", query });
		wrapper = mount(OpenOrdersPanel, { global: { plugins: [r] } });
		await flushPromises();
		return { r, w: wrapper };
	}

	it("no customer: all in flight, searchable", async () => {
		findOrders([albertReady, bettyMill]);
		const { w } = await view();
		expect(w.get("[data-testid='open-orders-scope']").text()).toBe("All orders in flight");
		expect(w.findAll("[data-testid='open-order']")).toHaveLength(2);
		expect(w.get("[data-readiness='ready']").text()).toContain("Ready for pickup");
	});
	it("the cart's customer: theirs, with a way to see everyone", async () => {
		findOrders([albertReady, bettyMill]);
		useCartStore().setCustomer({ name: "MC-4112", customer_name: "ALBERT ADKINS" });
		const { w, r } = await view();
		expect(w.get("[data-testid='open-orders-scope']").text()).toBe("Orders for ALBERT ADKINS");
		expect(w.findAll("[data-testid='open-order']")).toHaveLength(1);
		await w.get("[data-testid='open-orders-show-all']").trigger("click");
		await flushPromises();
		expect(r.currentRoute.value.query.customer).toBe("");
		expect(w.findAll("[data-testid='open-order']")).toHaveLength(2);
	});
	it("a customer with none online: an honest empty list", async () => {
		findOrders([bettyMill]);
		const { w } = await view({ customer: "MC-4112" });
		expect(w.get("[data-testid='open-orders-empty']").text()).toContain("No orders in flight for");
	});
	it("offline with nothing kept: says it does not know, never 'no orders'", async () => {
		net.state.isOnline = false;
		const { w } = await view();
		expect(w.find("[data-testid='open-orders-unknown']").exists()).toBe(true);
		expect(w.text()).not.toMatch(/No orders/);
	});
	it("offline with a kept list: shows it, its time, and cannot load for payment", async () => {
		meta.set(openOrdersCacheKey("Till", "*"), JSON.stringify({ rows: [bettyMill], fetchedAt: Date.now(), live: true, truncated: false }));
		net.state.isOnline = false;
		const { w } = await view();
		expect(w.get("[data-testid='open-orders-last-known']").text()).toContain("last known");
		expect(w.findAll("[data-testid='open-order']")).toHaveLength(1);
		expect(w.get("[data-testid='open-order-load']").attributes("disabled")).toBeDefined();
	});

	it("Load for payment maps the order on the server, says when a delivery became a pickup, and loads the till", async () => {
		const notice = "Switched to pickup: the delivery charge was removed.";
		const doc = { name: "ACC-SINV-1", customer: "MC-0007", customer_name: "BETTY BROWN", items: [], mule_notice: notice };
		api.call.mockImplementation(async (method: string) => (method.endsWith("find_orders") ? [bettyMill] : doc));
		const cart = useCartStore();
		const loaded = vi.spyOn(cart, "loadFromInvoice").mockImplementation(() => {});
		const { w, r } = await view();
		await w.get("[data-testid='open-order-load']").trigger("click");
		await flushPromises();
		expect(api.call).toHaveBeenCalledWith("mulecity_erpnext.pos_workspace.pickup_invoice", { pos_profile: "Till", sales_order: "SAL-ORD-3" });
		expect(api.showInfo).toHaveBeenCalledWith(notice);
		expect(loaded).toHaveBeenCalledWith(doc);
		expect(r.currentRoute.value.name).toBe("pos");
	});
	it("a delivered order says so and cannot be loaded for payment, with the reason", async () => {
		findOrders([albertDelivered, bettyMill]);
		const { w } = await view();
		const rows = w.findAll("[data-testid='open-order']");
		const delivered = rows.find((r) => r.attributes("data-readiness") === "delivered")!;
		expect(delivered.get("[data-testid='open-order-readiness']").text()).toBe("Delivered — not billed");
		expect(delivered.get("[data-testid='open-order-blocked']").text()).toBe(
			"Already delivered on MAT-DN-1; bill it from the Delivery Note at the desk.",
		);
		expect(delivered.get("[data-testid='open-order-load']").attributes("disabled")).toBeDefined();
		const other = rows.find((r) => r.attributes("data-readiness") === "in_production")!;
		expect(other.get("[data-testid='open-order-load']").attributes("disabled")).toBeUndefined();
	});
	it("an ordinary pickup says nothing extra", async () => {
		api.call.mockImplementation(async (method: string) => (method.endsWith("find_orders") ? [bettyMill] : { name: "ACC-SINV-2", items: [] }));
		vi.spyOn(useCartStore(), "loadFromInvoice").mockImplementation(() => {});
		const { w } = await view();
		await w.get("[data-testid='open-order-load']").trigger("click");
		await flushPromises();
		expect(api.showInfo).not.toHaveBeenCalled();
	});
});
