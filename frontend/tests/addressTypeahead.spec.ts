/**
 * @vitest-environment jsdom
 *
 * Google address typeahead in the till's add-address form (Mule City, MuleCity-p644).
 *
 * User stories: Leslie adds a delivery address for Albert. She types "88 New
 * Gr" in the street field; after a short pause Google's addresses show under
 * it. She arrows to one and presses Enter (or taps it): street, town, state
 * and ZIP fill in and the form shows Google's miles; the saved address keeps
 * the point and county. If the site cannot look up (no key, Google refused,
 * too many lookups) she sees "Address lookup isn't available — type the
 * address" and types it, with typed miles, as before. Offline nothing is asked.
 * Every lookup of one address shares one session token; the next address gets
 * a new one.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const state = vi.hoisted(() => ({
	online: true,
	meta: new Map<string, string>(),
	call: vi.fn(),
}));

vi.mock("@/services/api", () => ({ call: state.call, isNetworkError: () => false, showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/utils", async (importOriginal) => ({ ...(await importOriginal<object>()), isOnline: () => state.online }));
vi.mock("@/services/dbBridge", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getSyncMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
	setSyncMeta: vi.fn(async (key: string, value: string) => void state.meta.set(key, value)),
	getItem: vi.fn(async () => ({ item_code: "FEED-50", weight_per_unit: 50 })),
	getCustomer: vi.fn(async () => null),
	upsertCustomers: vi.fn(async () => undefined),
	getCachedStockForItem: vi.fn(async () => null),
	getCachedItemByCode: vi.fn(async () => null),
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({ taxes: [], taxInclusiveMode: false, currency: "USD", tenderModeFor: vi.fn(), defaultCustomer: "Walk-In" })),
}));
vi.mock("@/lib/translate", () => {
	const __ = (text: string, args: string[] = []) => args.reduce((out, arg, i) => out.replace(`{${i}}`, arg), text);
	return { __, default: __ };
});

import vectors from "./fixtures/delivery_charge_vectors.json";
import { useCartStore } from "@/stores/cartStore";
import AddDelivery from "@/components/cart/AddDelivery.vue";
import { LOOKUP_DEBOUNCE_MS, resetLookupCooldown } from "@/services/addressLookup";
import type { DeliveryPolicy } from "@/services/delivery";

const policy: DeliveryPolicy = {
	...vectors.policy,
	item_code: "MC-ITEM-DEL",
	item: { item_code: "MC-ITEM-DEL", item_name: "Delivery Charge", stock_uom: "Nos", item_group: "Services" },
};

const stubs = {
	Button: { props: ["disabled"], template: "<button :disabled='disabled' v-bind='$attrs'><slot /></button>" },
	Input: {
		props: ["modelValue", "placeholder"],
		emits: ["update:modelValue"],
		template: "<input :placeholder='placeholder' :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />",
	},
	Dialog: { props: ["open"], template: "<div v-if='open' data-testid='delivery-dialog'><slot /></div>" },
	DialogContent: { template: "<div><slot /></div>" },
	DialogHeader: { template: "<div><slot /></div>" },
	DialogTitle: { template: "<div><slot /></div>" },
	DialogDescription: { template: "<div><slot /></div>" },
};

const SUGGESTIONS = [
	{ place_id: "PLACE-88", description: "88 New Ground Rd, Coats, NC, USA" },
	{ place_id: "PLACE-880", description: "880 New Ground Rd, Dunn, NC, USA" },
];
const RESOLVED = {
	address_line1: "880 New Ground Rd", address_line2: null, city: "Dunn", county: "Harnett County", state: "NC",
	pincode: "28334", country: "United States", latitude: 35.3061, longitude: -78.6089, validated: true,
	formatted_address: "880 New Ground Rd, Dunn, NC 28334, USA", place_id: "PLACE-880", delivery_miles: 12.4,
};
const ADDED = {
	name: "Albert Adkins-Shipping", title: null, address_type: "Shipping", address_line1: "880 New Ground Rd",
	address_line2: null, city: "Dunn", state: "NC", pincode: "28334", miles: 12.4, miles_source: "routes",
	is_primary_address: true, is_shipping_address: true, miles_pending: false, latitude: 35.3061, longitude: -78.6089,
	quote: { amount: 45, source: "miles", rule: "Miles from HQ", miles: 12.4, miles_source: "routes", band: 1, description: "12.4 mi" },
};

type Calls = Array<[string, Record<string, unknown>]>;

/** The site: no addresses yet for Albert; the lookup answers as `lookup` says. */
function serve(lookup: "ok" | "unavailable" | "forbidden" | "rate-limited" | "network" = "ok") {
	const calls: Calls = [];
	state.call.mockImplementation(async (method: string, args: Record<string, unknown> = {}) => {
		calls.push([method, args]);
		if (method.endsWith("get_customer_delivery")) return { standing_charge: 0, no_charge: false, addresses: [] };
		if (method.endsWith("address_autocomplete") || method.endsWith("address_resolve")) {
			if (lookup === "network") throw new Error("Failed to fetch");
			if (lookup === "unavailable") throw Object.assign(new Error("Address lookup is unavailable — type the address by hand."), { excType: "AddressLookupUnavailable" });
			if (lookup === "forbidden") throw Object.assign(new Error("Forbidden"), { excType: "PermissionError" });
			if (lookup === "rate-limited") throw Object.assign(new Error("Too many address lookups"), { excType: "RateLimitExceededError" });
			return method.endsWith("address_autocomplete") ? SUGGESTIONS : RESOLVED;
		}
		if (method.endsWith("add_delivery_address")) return { ...ADDED, address_line1: args.address_line1, city: args.city, pincode: args.pincode };
		if (method.endsWith("quote_delivery")) return ADDED.quote;
		throw new Error(`unexpected ${method}`);
	});
	return calls;
}

const lookups = (calls: Calls) => calls.filter(([method]) => /address_(autocomplete|resolve)$/.test(method));

async function openNewAddressForm() {
	const cart = useCartStore();
	cart.setCustomer({ name: "MC-CUST-4112", customer_name: "Albert Adkins", xpos_has_address: false, xpos_address_count: 0 });
	cart.items.push({ uid: "r1", item_code: "FEED-50", item_name: "Layer feed 50 lb", qty: 32, rate: 18, uom: "Bag", conversion_factor: 1, discount_percentage: 0, discount_amount: 0 });
	const wrapper = mount(AddDelivery, { global: { stubs } });
	await flushPromises();
	await wrapper.get("[data-testid='add-delivery']").trigger("click");
	await flushPromises();
	expect(wrapper.find("[data-testid='delivery-new-address']").exists()).toBe(true);
	return { cart, wrapper };
}

type Wrapper = Awaited<ReturnType<typeof openNewAddressForm>>["wrapper"];

/** Type in the street field and let the pause pass. */
async function typeStreet(wrapper: Wrapper, text: string) {
	await wrapper.get("[data-testid='delivery-new-line1']").setValue(text);
	await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
	await flushPromises();
}

async function key(wrapper: Wrapper, name: string) {
	await wrapper.get("[data-testid='delivery-new-line1']").trigger("keydown", { key: name });
	await flushPromises();
}

const value = (wrapper: Wrapper, field: string) => (wrapper.get(`[data-testid='delivery-new-${field}']`).element as HTMLInputElement).value;

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	resetLookupCooldown();
	state.online = true;
	state.meta = new Map([["delivery_policy", JSON.stringify(policy)]]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("online: type, pick, the form fills in", () => {
	it("suggestions appear after 4 characters and a pause, not before", async () => {
		const calls = serve();
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 ");
		expect(lookups(calls)).toEqual([]);
		await wrapper.get("[data-testid='delivery-new-line1']").setValue("88 N");
		await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS - 50);
		expect(lookups(calls)).toEqual([]); // still typing
		await wrapper.get("[data-testid='delivery-new-line1']").setValue("88 New Gr");
		await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
		await flushPromises();
		// One lookup for the pause, with what she typed last.
		expect(lookups(calls).map(([, args]) => args.text)).toEqual(["88 New Gr"]);
		expect(wrapper.findAll("[data-testid='delivery-new-suggestion']").map((row) => row.text())).toEqual(SUGGESTIONS.map((s) => s.description));
		expect(wrapper.find("[data-testid='delivery-lookup-unavailable']").exists()).toBe(false);
	});

	it("arrows and Enter pick: the fields fill, Google's miles show, and the point and county reach the add", async () => {
		const calls = serve();
		const { cart, wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New Gr");
		await key(wrapper, "ArrowDown");
		await key(wrapper, "Enter");
		await flushPromises();
		expect(calls.find(([method]) => method.endsWith("address_resolve"))?.[1].place_id).toBe("PLACE-880");
		expect(wrapper.find("[data-testid='delivery-new-suggestions']").exists()).toBe(false);
		expect([value(wrapper, "line1"), value(wrapper, "city"), value(wrapper, "state"), value(wrapper, "zip")]).toEqual(["880 New Ground Rd", "Dunn", "NC", "28334"]);
		expect(wrapper.get("[data-testid='delivery-new-found-miles']").text()).toBe("Google: 12.4 mi one way");
		// The pick filled the street: no new lookup for it.
		await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
		expect(lookups(calls).filter(([method]) => method.endsWith("address_autocomplete"))).toHaveLength(1);
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(state.call).toHaveBeenCalledWith("xpos.api.customers.add_delivery_address", {
			customer: "MC-CUST-4112", address_line1: "880 New Ground Rd", address_line2: null, city: "Dunn", state: "NC",
			pincode: "28334", title: null, delivery_miles: null, county: "Harnett County", latitude: 35.3061,
			longitude: -78.6089, miles_source: "manual",
		});
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("Albert Adkins-Shipping");
	});

	it("a tap picks too; Esc closes the list without closing the form", async () => {
		const calls = serve();
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New Gr");
		await key(wrapper, "Escape");
		expect(wrapper.find("[data-testid='delivery-new-suggestions']").exists()).toBe(false);
		expect(wrapper.find("[data-testid='delivery-new-address']").exists()).toBe(true);
		await typeStreet(wrapper, "88 New Gro");
		await wrapper.findAll("[data-testid='delivery-new-suggestion']")[0].trigger("click");
		await flushPromises();
		expect(calls.find(([method]) => method.endsWith("address_resolve"))?.[1].place_id).toBe("PLACE-88");
		expect(value(wrapper, "city")).toBe("Dunn");
	});

	it("changing the street after a pick drops the picked point: the add sends none", async () => {
		serve();
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New Gr");
		await key(wrapper, "Enter");
		await flushPromises();
		await wrapper.get("[data-testid='delivery-new-zip']").setValue("27521");
		expect(wrapper.find("[data-testid='delivery-new-found']").exists()).toBe(false);
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		const add = state.call.mock.calls.find(([method]) => String(method).endsWith("add_delivery_address"))!;
		expect(add[1]).not.toHaveProperty("latitude");
		expect(add[1]).not.toHaveProperty("county");
		expect(add[1].pincode).toBe("27521");
	});

	it("one session token per address: every lookup of it shares one; the pick ends it; the next form starts another", async () => {
		const calls = serve();
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New");
		await typeStreet(wrapper, "88 New Gr");
		await key(wrapper, "Enter");
		await flushPromises();
		await typeStreet(wrapper, "12 Mill Rd"); // typing again after the pick
		const tokens = lookups(calls).map(([method, args]) => [method.split(".").pop(), args.session_token]);
		expect(tokens.map(([method]) => method)).toEqual(["address_autocomplete", "address_autocomplete", "address_resolve", "address_autocomplete"]);
		const [first, second, resolve, after] = tokens.map(([, token]) => token as string);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).toBe(first);
		expect(resolve).toBe(first);
		expect(after).not.toBe(first);
		// Cancel: the next form gets a new one too.
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		await typeStreet(wrapper, "4410 Old Fair");
		const last = lookups(calls).at(-1)![1].session_token;
		expect([first, after]).not.toContain(last);
	});
});

describe("fallbacks: the typed form always works", () => {
	it.each(["unavailable", "forbidden", "rate-limited"] as const)(
		"%s: a short note, no retry loop, and the typed address with typed miles saves",
		async (lookup) => {
			const calls = serve(lookup);
			const { cart, wrapper } = await openNewAddressForm();
			await typeStreet(wrapper, "88 New Ground Rd");
			expect(wrapper.get("[data-testid='delivery-lookup-unavailable']").text()).toBe("Address lookup isn't available — type the address");
			expect(wrapper.find("[data-testid='delivery-new-suggestions']").exists()).toBe(false);
			// More typing asks nobody.
			await typeStreet(wrapper, "88 New Ground Rd W");
			expect(lookups(calls)).toHaveLength(1);
			for (const [field, text] of Object.entries({ city: "Coats", state: "NC", zip: "27521", miles: "18" })) {
				await wrapper.get(`[data-testid='delivery-new-${field}']`).setValue(text);
			}
			await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
			await flushPromises();
			expect(state.call).toHaveBeenCalledWith("xpos.api.customers.add_delivery_address", {
				customer: "MC-CUST-4112", address_line1: "88 New Ground Rd W", address_line2: null, city: "Coats", state: "NC",
				pincode: "27521", title: null, delivery_miles: 18, miles_source: "manual",
			});
			expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("Albert Adkins-Shipping");
			// Opening the form again a moment later still asks nobody (the cooldown).
			await wrapper.get("[data-testid='add-delivery']").trigger("click");
			await flushPromises();
			await typeStreet(wrapper, "4410 Old Fair");
			expect(lookups(calls)).toHaveLength(1);
			expect(wrapper.find("[data-testid='delivery-lookup-unavailable']").exists()).toBe(true);
		},
	);

	it("offline: no lookups at all; the typed address is queued as today", async () => {
		const calls = serve();
		state.online = false;
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New Ground Rd");
		expect(lookups(calls)).toEqual([]);
		expect(wrapper.find("[data-testid='delivery-new-suggestions']").exists()).toBe(false);
		expect(wrapper.find("[data-testid='delivery-lookup-unavailable']").exists()).toBe(false);
		for (const [field, text] of Object.entries({ city: "Coats", state: "NC", zip: "27521", miles: "18" })) {
			await wrapper.get(`[data-testid='delivery-new-${field}']`).setValue(text);
		}
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(calls.map(([method]) => method)).not.toContain("xpos.api.customers.add_delivery_address");
		const queued = JSON.parse(state.meta.get("pending_delivery_addresses") || "[]");
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ address_line1: "88 New Ground Rd", miles: 18 });
	});

	it("a network failure while typing is no note and no cooldown (the till went offline)", async () => {
		const calls = serve("network");
		const { wrapper } = await openNewAddressForm();
		await typeStreet(wrapper, "88 New Gr");
		expect(wrapper.find("[data-testid='delivery-lookup-unavailable']").exists()).toBe(false);
		await typeStreet(wrapper, "88 New Gro");
		expect(lookups(calls)).toHaveLength(2);
	});
});
