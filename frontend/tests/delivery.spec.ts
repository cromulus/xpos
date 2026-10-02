/**
 * @vitest-environment jsdom
 *
 * Delivery at the counter, priced by miles (Bill 2026-09-29, MuleCity-6nb1).
 *
 * User stories: Leslie rings up a customer who wants their feed delivered. She
 * presses "Add delivery" on the customer card. One address is quoted straight
 * away; with several, she picks one (street and town). The address becomes the
 * sale's shipping address and one delivery line is added at the site's quote
 * (the customer's standing charge, their free-delivery exception, or miles from
 * HQ by the load's weight band); with no quote she types the charge. When the
 * till is offline it prices the delivery itself from what it cached, and a new
 * address is typed with its one-way miles, flagged for review on sync.
 *
 * The till's pricing must give the site's cents: tests/fixtures/delivery_charge_vectors.json
 * is a byte-for-byte copy of the site's shared cases,
 * erpnext/custom_apps/mulecity_erpnext/mulecity_erpnext/pricing/data/delivery_charge_vectors.json
 * in the Mule City repo. When the site's file changes, copy it here again
 * (cp <MuleCity>/erpnext/custom_apps/mulecity_erpnext/mulecity_erpnext/pricing/data/delivery_charge_vectors.json
 * frontend/tests/fixtures/) and run this spec; `cmp` the two files to check they match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import vectors from "./fixtures/delivery_charge_vectors.json";

const state = vi.hoisted(() => ({
	online: true,
	meta: new Map<string, string>(),
	items: new Map<string, Record<string, unknown>>(),
	call: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@/services/api", () => ({ call: state.call, showSuccess: state.toast, showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/utils", async (importOriginal) => ({ ...(await importOriginal<object>()), isOnline: () => state.online }));
vi.mock("@/services/dbBridge", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getSyncMeta: vi.fn(async (key: string) => state.meta.get(key) ?? null),
	setSyncMeta: vi.fn(async (key: string, value: string) => void state.meta.set(key, value)),
	getItem: vi.fn(async (code: string) => state.items.get(code) ?? null),
	getCustomer: vi.fn(async () => null),
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

import {
	autoDeliveryAddress,
	bandOf,
	cartWeight,
	deliveryCharge,
	deliveryOffered,
	isWalkInCustomer,
	quoteOffline,
	type DeliveryPolicy,
} from "@/services/delivery";
import { useCartStore } from "@/stores/cartStore";
import AddDelivery from "@/components/cart/AddDelivery.vue";

const policy: DeliveryPolicy = {
	...vectors.policy,
	item_code: "MC-ITEM-DEL",
	item: { item_code: "MC-ITEM-DEL", item_name: "Delivery Charge", stock_uom: "Nos", item_group: "Services" },
};
const farm = { name: "ADDR-FARM", address_line1: "4410 Old Fairground Rd", city: "Dunn", miles: 42, miles_source: "routes" };
const barn = { name: "ADDR-BARN", address_line1: "12 Mill Rd", city: "Angier", miles: 17.4, miles_source: "routes" };

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

/** The site's quote, as xpos.api.delivery.quote_delivery answers online. */
function siteQuote(overrides: Record<string, unknown> = {}) {
	return { amount: 105, source: "miles", rule: "Miles from HQ", miles: 42, miles_source: "routes", band: 2, description: "42 mi, band 2 (1,600 lb)", ...overrides };
}

function serve(details: Record<string, unknown>, quote = siteQuote()) {
	state.call.mockImplementation(async (method: string) => {
		if (method.endsWith("get_delivery_policy")) return policy;
		if (method.endsWith("get_customer_delivery")) return details;
		if (method.endsWith("quote_delivery")) return quote;
		throw new Error(`unexpected ${method}`);
	});
}

/** A cart for `customer` with 32 bags of 50 lb feed (1,600 lb), and "Add delivery" on the card. */
async function counter(customer: Record<string, unknown>) {
	const cart = useCartStore();
	cart.setCustomer({ name: "MC-CUST-4112", customer_name: "Albert Adkins", ...customer });
	cart.items.push({ uid: "r1", item_code: "FEED-50", item_name: "Layer feed 50 lb", qty: 32, rate: 18, uom: "Bag", conversion_factor: 1, discount_percentage: 0, discount_amount: 0 });
	const wrapper = mount(AddDelivery, { global: { stubs } });
	await flushPromises();
	return { cart, wrapper };
}

function deliveryLines(cart: ReturnType<typeof useCartStore>) {
	return cart.items.filter((i) => i.item_code === "MC-ITEM-DEL").map((i) => [i.qty, i.rate, i.description]);
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	state.online = true;
	state.meta = new Map([["delivery_policy", JSON.stringify(policy)]]);
	state.items = new Map([["FEED-50", { item_code: "FEED-50", weight_per_unit: 50 }]]);
});

describe("the till prices delivery exactly as the site does (shared vectors)", () => {
	it.each(vectors.cases)("$case", ({ miles, weight_lb, band, amount }) => {
		expect(bandOf(vectors.policy, weight_lb)).toBe(band);
		expect(deliveryCharge(vectors.policy, miles, weight_lb)).toBe(amount);
	});

	it("words the line as the site does: miles, band and pounds", () => {
		expect(quoteOffline(policy, null, { ...farm }, 2500).description).toBe("42 mi, band 3 (2,500 lb)");
		expect(quoteOffline(policy, null, { ...farm, miles: 42.3 }, 999.99).description).toBe("42.3 mi, band 1 (1,000 lb)");
	});

	it("keeps the site's precedence: free exception, then standing charge, then miles, else typed", () => {
		const details = (standing: number, free: boolean) => ({ standing_charge: standing, no_charge: free, addresses: [] });
		expect(quoteOffline(policy, details(80, true), farm, 1600)).toMatchObject({ amount: 0, source: "exception" });
		expect(quoteOffline(policy, details(80, false), farm, 1600)).toMatchObject({ amount: 80, source: "standing", description: "Standing rate" });
		expect(quoteOffline(policy, details(0, false), farm, 1600)).toMatchObject({ amount: 105, source: "miles", band: 2 });
		expect(quoteOffline(policy, details(0, false), { ...farm, miles: null }, 1600)).toMatchObject({ amount: null, source: "none" });
	});

	it("weighs the load as ERPNext does: weight per stock unit x qty x conversion factor", () => {
		const weights: Record<string, number> = { BAG: 50, LB: 1 };
		const lines = [
			{ item_code: "BAG", qty: 10, conversion_factor: 1 },
			{ item_code: "LB", qty: 2, conversion_factor: 50 },
			{ item_code: "NONE", qty: 3 },
		];
		expect(cartWeight(lines, (code) => weights[code] || 0)).toBe(600);
	});
});

describe("Add delivery at the counter (online: the site quotes)", () => {
	it("one address: quoted straight away, one delivery line at the quote, shipped there", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm] });
		const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 1 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(state.call).toHaveBeenCalledWith("xpos.api.delivery.quote_delivery", {
			customer: "MC-CUST-4112",
			address: "ADDR-FARM",
			items: JSON.stringify([{ item_code: "FEED-50", qty: 32, conversion_factor: 1 }]),
		});
		expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb)"]]);
		expect(wrapper.find("[data-testid='delivery-dialog']").exists()).toBe(false);
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect(sale.shipping_address_name).toBe("ADDR-FARM");
		expect(sale.items.at(-1)).toMatchObject({ item_code: "MC-ITEM-DEL", qty: 1, rate: 105, description: "42 mi, band 2 (1,600 lb)" });
		expect(sale.xpos_new_shipping_address).toBeUndefined();
	});

	it("several addresses: a picker lists street, town, miles and cost, and the chosen one is quoted", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm, barn] }, siteQuote({ amount: 45, miles: 17.4, description: "17.4 mi, band 2 (1,600 lb)" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 2 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		const choices = wrapper.findAll("[data-testid='delivery-address']");
		expect(choices.map((c) => c.get("[data-testid='delivery-address-text']").text())).toEqual(["4410 Old Fairground Rd, Dunn", "12 Mill Rd, Angier"]);
		expect(choices.map((c) => c.get("[data-testid='delivery-address-miles']").text())).toEqual(["42 mi", "17.4 mi"]);
		// 1,600 lb, band 2: 42 mi -> $105; 17.4 mi -> $87 full load -> $45 (the shared vectors).
		expect(choices.map((c) => c.get("[data-testid='delivery-address-cost']").text())).toEqual([
			expect.stringContaining("105.00"),
			expect.stringContaining("45.00"),
		]);
		await choices[1].trigger("click");
		await wrapper.get("[data-testid='delivery-use']").trigger("click");
		await flushPromises();
		expect(state.call).toHaveBeenCalledWith("xpos.api.delivery.quote_delivery", expect.objectContaining({ address: "ADDR-BARN" }));
		expect(deliveryLines(cart)).toEqual([[1, 45, "17.4 mi, band 2 (1,600 lb)"]]);
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("ADDR-BARN");
	});

	it("a standing-charge customer gets their charge; adding delivery again updates the one line", async () => {
		serve({ standing_charge: 80, no_charge: false, addresses: [farm] }, siteQuote({ amount: 80, source: "standing", description: "Standing rate" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(deliveryLines(cart)).toEqual([[1, 80, "Standing rate"]]);
	});

	it("a free-delivery exception adds a $0 line", async () => {
		serve({ standing_charge: 0, no_charge: true, addresses: [farm] }, siteQuote({ amount: 0, source: "exception", description: "No delivery charge (standing exception)" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(deliveryLines(cart)).toEqual([[1, 0, "No delivery charge (standing exception)"]]);
	});

	it("no quote (no miles yet): the picker says no miles; leaving them empty, Leslie types the charge", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [{ ...farm, miles: null, miles_source: null }] },
			siteQuote({ amount: null, source: "none", miles: null, band: null, description: "No miles for this address; type the delivery charge" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.get("[data-testid='delivery-address-miles']").text()).toBe("no miles");
		await wrapper.get("[data-testid='delivery-use']").trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("No miles for this address; type the delivery charge");
		expect(deliveryLines(cart)).toEqual([]);
		await wrapper.get("[data-testid='delivery-amount']").setValue("60");
		await wrapper.get("[data-testid='delivery-amount-use']").trigger("click");
		expect(deliveryLines(cart)).toEqual([[1, 60, "Delivery (typed)"]]);
	});

	it("negative: not offered when the site quotes no delivery", async () => {
		state.meta = new Map([["delivery_policy", "null"]]);
		state.call.mockResolvedValue(null);
		const { wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 1 });
		expect(wrapper.find("[data-testid='add-delivery']").exists()).toBe(false);
	});
});

/** Fill the add-address form (street, line 2, city, state, ZIP, name, miles). */
async function fillNewAddress(wrapper: Awaited<ReturnType<typeof counter>>["wrapper"], fields: Record<string, string>) {
	const form = wrapper.get("[data-testid='delivery-new-address']");
	for (const [key, value] of Object.entries(fields)) await form.get(`[data-testid='delivery-new-${key}']`).setValue(value);
}

const NEW_FARM = { line1: "88 New Ground Rd", city: "Coats", state: "NC", zip: "27521" };

describe("Bill's address rule (2026-10-01 22:52, MuleCity-qajl)", () => {
	const shipping = (address: Record<string, unknown>) => ({ ...address, address_type: "Shipping" });
	const billing = (address: Record<string, unknown>) => ({ ...address, address_type: "Billing" });

	it("the choice: the only address; else the only Shipping address; else the clerk picks", () => {
		expect(autoDeliveryAddress([farm])).toBe(farm);
		expect(autoDeliveryAddress([billing(farm), shipping(barn)])).toMatchObject({ name: "ADDR-BARN" });
		expect(autoDeliveryAddress([shipping(farm), shipping(barn)])).toBeNull();
		expect(autoDeliveryAddress([billing(farm), billing(barn)])).toBeNull();
		expect(autoDeliveryAddress([])).toBeNull();
	});

	it("a delivery needs a real customer: no customer, the profile's walk-in and the site's walk-ins get none", () => {
		const site = { ...policy, walk_in_customers: ["CASH 338"] };
		expect(isWalkInCustomer("", site, "Walk-In")).toBe(true);
		expect(isWalkInCustomer("Walk-In", site, "Walk-In")).toBe(true);
		expect(isWalkInCustomer("CASH 338", site, "Walk-In")).toBe(true);
		expect(isWalkInCustomer("MC-CUST-4112", site, "Walk-In")).toBe(false);
		expect(deliveryOffered({ policy: site, customer: "MC-CUST-4112", defaultCustomer: "Walk-In" })).toBe(true);
		expect(deliveryOffered({ policy: site, customer: "MC-CUST-4112", isReturnMode: true })).toBe(false);
		expect(deliveryOffered({ policy: null, customer: "MC-CUST-4112" })).toBe(false);
	});

	for (const online of [true, false]) {
		const mode = online ? "online" : "offline";

		it(`${mode}: the walk-in accounts never see Add delivery`, async () => {
			state.meta = new Map([["delivery_policy", JSON.stringify({ ...policy, walk_in_customers: ["CASH 338"] })]]);
			state.online = online;
			for (const name of ["Walk-In", "CASH 338"]) {
				setActivePinia(createPinia());
				const { wrapper } = await counter({ name, customer_name: name, xpos_has_address: true, xpos_address_count: 1 });
				expect(wrapper.find("[data-testid='add-delivery']").exists()).toBe(false);
			}
		});
	}

	it("online: the one Shipping address among several is quoted and added without asking", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [billing(farm), shipping(barn)] },
			siteQuote({ amount: 45, miles: 17.4, description: "17.4 mi, band 2 (1,600 lb)" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 2 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.find("[data-testid='delivery-dialog']").exists()).toBe(false);
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("ADDR-BARN");
		// "Change delivery" shows the list, with "Add new address".
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.findAll("[data-testid='delivery-address']")).toHaveLength(2);
		expect(wrapper.find("[data-testid='delivery-add-address']").exists()).toBe(true);
	});

	it("online: a named customer with no address gets the button; it opens the add form; the site makes it with Google's miles", async () => {
		const added = { name: "Albert Adkins-Shipping", title: null, address_type: "Shipping", address_line1: "88 New Ground Rd",
			address_line2: null, city: "Coats", state: "NC", pincode: "27521", miles: 42, miles_source: "routes",
			is_primary_address: true, is_shipping_address: true, miles_pending: false, quote: siteQuote({ band: 1 }) };
		state.call.mockImplementation(async (method: string) => {
			if (method.endsWith("get_customer_delivery")) return { standing_charge: 0, no_charge: false, addresses: [] };
			if (method.endsWith("add_delivery_address")) return added;
			if (method.endsWith("quote_delivery")) return siteQuote();
			throw new Error(`unexpected ${method}`);
		});
		const { cart, wrapper } = await counter({ xpos_has_address: false, xpos_address_count: 0 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.findAll("[data-testid='delivery-address']")).toHaveLength(0);
		await fillNewAddress(wrapper, NEW_FARM);
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(state.call).toHaveBeenCalledWith("xpos.api.customers.add_delivery_address", {
			customer: "MC-CUST-4112", address_line1: "88 New Ground Rd", address_line2: null, city: "Coats", state: "NC",
			pincode: "27521", title: null, delivery_miles: null, miles_source: "manual",
		});
		// The cart's quote weighs this cart (the add's own quote has no cart).
		expect(state.call).toHaveBeenCalledWith("xpos.api.delivery.quote_delivery", expect.objectContaining({ address: "Albert Adkins-Shipping" }));
		expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb)"]]);
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("Albert Adkins-Shipping");
		// The picker (and the cached row) know it at once.
		expect(cart.customer?.xpos_delivery?.addresses.map((a) => a.name)).toEqual(["Albert Adkins-Shipping"]);
	});

	it("online: Google finds no miles: the form asks; the typed miles go on the address and price it", async () => {
		const base = { name: "Albert Adkins-Shipping", address_type: "Shipping", address_line1: "88 New Ground Rd", city: "Coats",
			state: "NC", pincode: "27521", is_primary_address: true, is_shipping_address: true };
		const adds: Array<Record<string, unknown>> = [];
		state.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method.endsWith("get_customer_delivery")) return { standing_charge: 0, no_charge: false, addresses: [] };
			if (method.endsWith("add_delivery_address")) {
				adds.push(args);
				return args.delivery_miles
					? { ...base, miles: 42, miles_source: "manual", miles_pending: false, quote: siteQuote({ miles_source: "manual" }) }
					: { ...base, miles: null, miles_source: null, miles_pending: true, quote: siteQuote({ amount: null, source: "none", miles: null }) };
			}
			if (method.endsWith("quote_delivery")) return siteQuote({ miles_source: "manual" });
			throw new Error(`unexpected ${method}`);
		});
		const { cart, wrapper } = await counter({ xpos_has_address: false });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		await fillNewAddress(wrapper, NEW_FARM);
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(wrapper.find("[data-testid='delivery-new-miles-asked']").exists()).toBe(true);
		expect(deliveryLines(cart)).toEqual([]);
		await fillNewAddress(wrapper, { miles: "42" });
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(adds.map((a) => [a.delivery_miles, a.miles_source])).toEqual([[null, "manual"], [42, "manual"]]);
		expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb)"]]);
	});

	it("the picker always offers Add new address, online too", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm, barn] });
		const { wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 2 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.find("[data-testid='delivery-new-address']").exists()).toBe(false);
		await wrapper.get("[data-testid='delivery-add-address']").trigger("click");
		expect(wrapper.find("[data-testid='delivery-new-address']").exists()).toBe(true);
		await wrapper.get("[data-testid='delivery-new-address-back']").trigger("click");
		expect(wrapper.findAll("[data-testid='delivery-address']")).toHaveLength(2);
	});
});

describe("Add delivery with the till offline (priced from the cache)", () => {
	it("one cached address with miles is priced from the cache and added at once", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(state.call).not.toHaveBeenCalled();
		expect(wrapper.find("[data-testid='delivery-dialog']").exists()).toBe(false);
		// 32 bags x 50 lb = 1,600 lb, band 2; 42 mi x $5 = $210 x 50% = $105 (a shared vector).
		expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb)"]]);
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBe("ADDR-FARM");
	});

	it("a standing charge still wins offline", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 80, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(deliveryLines(cart)).toEqual([[1, 80, "Standing rate"]]);
	});

	it("a new address added offline is queued, priced from the typed miles, and the sale names it by its local id", async () => {
		state.online = false;
		state.items.set("FEED-50", { item_code: "FEED-50", weight_per_unit: 125 }); // 32 x 125 = 4,000 lb, band 4
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click"); // the farm, at once
		await flushPromises();
		await wrapper.get("[data-testid='add-delivery']").trigger("click"); // Change delivery: the list
		await flushPromises();
		await wrapper.get("[data-testid='delivery-add-address']").trigger("click");
		await fillNewAddress(wrapper, { ...NEW_FARM, line2: "Back gate", miles: "17.4" });
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(state.call).not.toHaveBeenCalled();
		// 17.4 mi x $5 = $87 -> $85 at full load (a shared vector).
		expect(deliveryLines(cart)).toEqual([[1, 85, "17.4 mi, band 4 (4,000 lb), miles typed offline"]]);
		const [queued] = JSON.parse(state.meta.get("pending_delivery_addresses")!);
		expect(queued).toMatchObject({ customer: "MC-CUST-4112", address_line1: "88 New Ground Rd", address_line2: "Back gate",
			city: "Coats", state: "NC", pincode: "27521", miles: 17.4 });
		expect(queued.local_id).toMatch(/^LOCAL-ADDR-/);
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect(sale.shipping_address_name).toBeUndefined();
		expect(sale.xpos_new_shipping_address).toEqual({ address_line1: "88 New Ground Rd", address_line2: "Back gate", city: "Coats",
			state: "NC", pincode: "27521", miles: 17.4, local_id: queued.local_id });
		expect(sale.xpos_delivery).toMatchObject({ source: "miles", amount: 85, miles: 17.4, miles_source: "manual_offline", address: queued.local_id });
		expect([sale.pos_delivery_miles, sale.pos_delivery_miles_source]).toEqual([17.4, "manual"]);
		// The picker shows it for the next sale.
		expect(cart.customer?.xpos_delivery?.addresses.map((a) => a.name)).toEqual(["ADDR-FARM", queued.local_id]);
	});

	it("a named customer with no address on file goes straight to the add form offline; a parked tab carries the flag", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({ xpos_has_address: false, xpos_address_count: 0 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.findAll("[data-testid='delivery-address']")).toHaveLength(0);
		await fillNewAddress(wrapper, { ...NEW_FARM, miles: "42" });
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb), miles typed offline"]]);
		// Save as draft sends getInvoiceData(); save_draft_invoice flags the tab with a Comment.
		const parked = cart.getInvoiceData("Till", "SHIFT-1");
		expect(parked.xpos_delivery).toMatchObject({ source: "miles", miles: 42, miles_source: "manual_offline" });
		expect(parked.xpos_new_shipping_address).toMatchObject({ address_line1: "88 New Ground Rd", miles: 42 });
	});

	it("offline with no miles typed, the clerk types the charge", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({ xpos_has_address: false });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		await fillNewAddress(wrapper, NEW_FARM);
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		await wrapper.get("[data-testid='delivery-amount']").setValue("60");
		await wrapper.get("[data-testid='delivery-amount-use']").trigger("click");
		expect(deliveryLines(cart)).toEqual([[1, 60, "Delivery (typed)"]]);
		expect(cart.getInvoiceData("Till", "SHIFT-1").xpos_new_shipping_address).toMatchObject({ miles: 0 });
	});

	it("negative: a new address needs a street, a city, a state and a ZIP; typed miles must be above zero", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({ xpos_has_address: false });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		const use = () => wrapper.get("[data-testid='delivery-new-address-use']").attributes("disabled");
		await fillNewAddress(wrapper, { line1: "88 New Ground Rd", city: "Coats" });
		await fillNewAddress(wrapper, { state: "" });
		expect(use()).toBeDefined();
		await fillNewAddress(wrapper, { state: "NC" });
		expect(use()).toBeDefined(); // no ZIP
		await fillNewAddress(wrapper, { zip: "27521", miles: "0" });
		expect(use()).toBeDefined();
		await fillNewAddress(wrapper, { miles: "" });
		expect(use()).toBeUndefined();
		expect(deliveryLines(cart)).toEqual([]);
	});
});

describe("the delivery belongs to the buyer", () => {
	it("changing the customer drops the chosen shipping address", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm] });
		const { cart, wrapper } = await counter({ xpos_has_address: true });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		cart.setCustomer({ name: "MC-CUST-9", customer_name: "Someone else" });
		expect(cart.getInvoiceData("Till", "SHIFT-1").shipping_address_name).toBeUndefined();
	});
});

describe("a parked delivery sale", () => {
	it("keeps its delivery line's wording and its shipping address when the tab is reopened", async () => {
		state.call.mockResolvedValue({
			name: "SINV-9",
			customer: "MC-CUST-4112",
			customer_name: "Albert Adkins",
			shipping_address_name: "ADDR-FARM",
			items: [{ item_code: "MC-ITEM-DEL", item_name: "Delivery Charge", qty: 1, rate: 105, price_list_rate: 105, amount: 105,
				uom: "Nos", discount_percentage: 0, discount_amount: 0, description: "42 mi, band 2 (1,600 lb)" }],
		});
		const cart = useCartStore();
		await cart.loadDraftInvoice("SINV-9");
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect(sale.shipping_address_name).toBe("ADDR-FARM");
		expect(sale.items[0]).toMatchObject({ item_code: "MC-ITEM-DEL", rate: 105, description: "42 mi, band 2 (1,600 lb)" });
	});
});

describe("the customer card's Add delivery button (Bill 2026-10-01, MuleCity-qajl.2)", () => {
	it("is a button on its own line, shown for one address and for several", async () => {
		for (const count of [1, 3]) {
			setActivePinia(createPinia());
			serve({ standing_charge: 0, no_charge: false, addresses: [farm] });
			const { wrapper } = await counter({ xpos_has_address: true, xpos_address_count: count });
			expect(wrapper.get("[data-testid='delivery-row']").find("[data-testid='add-delivery']").exists()).toBe(true);
		}
	});

	it("negative: never in return mode, online or offline", async () => {
		for (const online of [true, false]) {
			setActivePinia(createPinia());
			state.online = online;
			const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 1 });
			cart.isReturnMode = true;
			await flushPromises();
			expect(wrapper.find("[data-testid='add-delivery']").exists()).toBe(false);
		}
	});

	it("the card no longer has Recent purchases (Repeat is in the top bar), keeps Credit limit, and puts Add delivery below the account row", async () => {
		const source = (await import("@/components/cart/Cart.vue?raw")).default as string;
		expect(source).not.toContain("Recent purchases");
		expect(source).not.toContain("openRecentPurchases");
		expect(source).toContain('data-testid="customer-credit-limit"');
		const row = source.indexOf('data-testid="customer-account-row"');
		const rowEnd = source.indexOf("</div>", row);
		expect(source.indexOf("<AddDelivery", row)).toBeGreaterThan(rowEnd);
	});
});

describe("the address picker (Bill 2026-10-01, MuleCity-qajl.3)", () => {
	// Three places: the yard is the primary shipping address though listed last.
	const shed = { name: "ADDR-SHED", title: "Back shed", address_line1: "5 Back Rd", city: "Dunn", miles: null, miles_source: null,
		is_primary_address: false, is_shipping_address: false };
	const yard = { name: "ADDR-YARD", title: "Hollow Creek yard", address_line1: "77 Feed Lot Ln", address_line2: "Gate 3", city: "Benson",
		state: "NC", pincode: "27504", miles: 42, miles_source: "routes", is_primary_address: true, is_shipping_address: true };
	const places = { standing_charge: 0, no_charge: false, addresses: [{ ...barn, is_primary_address: true }, shed, yard] };

	async function picker(online: boolean, details: Record<string, unknown> = places) {
		state.online = online;
		serve(details);
		const opened = await counter({ xpos_has_address: true, xpos_address_count: 3, xpos_delivery: details });
		await opened.wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		return opened;
	}
	const rows = (wrapper: Awaited<ReturnType<typeof picker>>["wrapper"]) => wrapper.findAll("[data-testid='delivery-address']");
	const selectedText = (wrapper: Awaited<ReturnType<typeof picker>>["wrapper"]) =>
		rows(wrapper).filter((r) => r.attributes("data-selected") === "true").map((r) => r.get("[data-testid='delivery-address-text']").text());

	for (const online of [true, false]) {
		const mode = online ? "online" : "offline";

		it(`${mode}: opens on the primary shipping address; each row shows its miles and cost, or "no miles"`, async () => {
			const { wrapper } = await picker(online);
			expect(selectedText(wrapper)).toEqual(["77 Feed Lot Ln, Gate 3, Benson, NC 27504"]);
			expect(rows(wrapper).map((r) => r.get("[data-testid='delivery-address-miles']").text())).toEqual(["17.4 mi", "no miles", "42 mi"]);
			const costs = rows(wrapper).map((r) => r.get("[data-testid='delivery-address-cost']").text());
			expect(costs[0]).toContain("45.00");
			expect(costs[1]).toBe("—");
			expect(costs[2]).toContain("105.00");
		});

		it(`${mode}: the search narrows by street, town or name, and another choice is added`, async () => {
			const { cart, wrapper } = await picker(online);
			await wrapper.get("[data-testid='delivery-search']").setValue("angier");
			expect(rows(wrapper).map((r) => r.get("[data-testid='delivery-address-text']").text())).toEqual(["12 Mill Rd, Angier"]);
			await wrapper.get("[data-testid='delivery-search']").setValue("creek yard");
			expect(rows(wrapper)).toHaveLength(1);
			await wrapper.get("[data-testid='delivery-search']").setValue("mill");
			await rows(wrapper)[0].trigger("click");
			if (online) serve(places, siteQuote({ amount: 45, miles: 17.4, description: "17.4 mi, band 2 (1,600 lb)" }));
			await wrapper.get("[data-testid='delivery-use']").trigger("click");
			await flushPromises();
			expect(deliveryLines(cart)).toEqual([[1, 45, "17.4 mi, band 2 (1,600 lb)"]]);
			const sale = cart.getInvoiceData("Till", "SHIFT-1");
			expect([sale.shipping_address_name, sale.pos_delivery_miles, sale.pos_delivery_miles_source]).toEqual(["ADDR-BARN", 17.4, "address"]);
		});

		it(`${mode}: a standing-charge customer sees that amount on every row, with or without miles`, async () => {
			const { wrapper } = await picker(online, { ...places, standing_charge: 80 });
			for (const row of rows(wrapper)) expect(row.get("[data-testid='delivery-address-cost']").text()).toContain("80.00");
		});

		it(`${mode}: an address with no miles: the typed miles are priced by the policy and kept as typed`, async () => {
			const { cart, wrapper } = await picker(online);
			await rows(wrapper)[1].trigger("click");
			await wrapper.get("[data-testid='delivery-miles']").setValue("42");
			expect(rows(wrapper)[1].get("[data-testid='delivery-address-cost']").text()).toContain("105.00");
			await wrapper.get("[data-testid='delivery-use']").trigger("click");
			await flushPromises();
			// Priced at the till; the site has no miles for the shed to quote from.
			expect(state.call).not.toHaveBeenCalledWith("xpos.api.delivery.quote_delivery", expect.anything());
			expect(deliveryLines(cart)).toEqual([[1, 105, "42 mi, band 2 (1,600 lb), miles typed at the till"]]);
			const sale = cart.getInvoiceData("Till", "SHIFT-1");
			expect([sale.shipping_address_name, sale.pos_delivery_miles, sale.pos_delivery_miles_source]).toEqual(["ADDR-SHED", 42, "manual"]);
			// The site flags a sale priced from typed miles (xpos.api.delivery.note_typed_miles).
			expect(sale.xpos_delivery).toMatchObject({ source: "miles", miles: 42, miles_source: "manual", address: "ADDR-SHED" });
		});
	}

	it("the clerk picks the day; it goes on the sale, and a counter order takes it as its pickup (delivery) date", async () => {
		const { cart, wrapper } = await picker(true);
		expect((wrapper.get("[data-testid='delivery-day']").element as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		await wrapper.get("[data-testid='delivery-day']").setValue("2026-10-05");
		await wrapper.get("[data-testid='delivery-use']").trigger("click");
		await flushPromises();
		expect(cart.getInvoiceData("Till", "SHIFT-1").pos_delivery_date).toBe("2026-10-05");
		// Changed on the card afterwards.
		const card = wrapper.get("[data-testid='delivery-day-card']");
		await card.setValue("2026-10-06");
		await card.trigger("change");
		expect(cart.deliveryDate).toBe("2026-10-06");
		expect(wrapper.get("[data-testid='delivery-summary']").text()).toBe("To 77 Feed Lot Ln, Benson · 42 mi");
	});

	it("one address with miles is added at once with today's day; a counter order's date follows the day", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm] });
		const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 1 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.find("[data-testid='delivery-dialog']").exists()).toBe(false);
		expect(cart.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// A custom mix the mill still has to make: an order line (its Sales Order's delivery_date is pickup_date).
		cart.items.push({ uid: "r2", item_code: "MIX-1", item_name: "Custom mix", qty: 500, rate: 0.4, uom: "Pound", conversion_factor: 1,
			discount_percentage: 0, discount_amount: 0, is_made_to_order: 1, actual_qty: 0 } as never);
		expect(cart.hasOrderLines).toBe(true);
		cart.setDeliveryDate("2026-10-07");
		const sale = cart.getInvoiceData("Till", "SHIFT-1") as Record<string, unknown>;
		expect([sale.pos_delivery_date, sale.pickup_date]).toEqual(["2026-10-07", "2026-10-07"]);
	});

	it("the receipt snapshot carries the delivery's address, miles and day; removing the line drops it", async () => {
		const { cart, wrapper } = await picker(false);
		await wrapper.get("[data-testid='delivery-day']").setValue("2026-10-05");
		await wrapper.get("[data-testid='delivery-use']").trigger("click");
		await flushPromises();
		expect(cart.getReceiptSnapshot("SINV-1").delivery).toEqual({
			address_name: "ADDR-YARD", address: "77 Feed Lot Ln, Gate 3, Benson, NC 27504", miles: 42, miles_source: "address", date: "2026-10-05",
		});
		cart.items.splice(cart.items.findIndex((i) => i.item_code === "MC-ITEM-DEL"), 1);
		expect(cart.getReceiptSnapshot("SINV-1").delivery).toBeUndefined();
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect([sale.shipping_address_name, sale.pos_delivery_miles, sale.pos_delivery_date]).toEqual([undefined, undefined, undefined]);
	});

	it("negative: a pickup sale has no delivery on its snapshot or its data", async () => {
		const { cart } = await counter({ xpos_has_address: true });
		expect(cart.getReceiptSnapshot("SINV-2").delivery).toBeUndefined();
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect([sale.pos_delivery_miles, sale.pos_delivery_miles_source, sale.pos_delivery_date]).toEqual([undefined, undefined, undefined]);
	});
});
