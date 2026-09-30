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
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({ taxes: [], taxInclusiveMode: false, currency: "USD", tenderModeFor: vi.fn() })),
}));
vi.mock("@/lib/translate", () => {
	const __ = (text: string, args: string[] = []) => args.reduce((out, arg, i) => out.replace(`{${i}}`, arg), text);
	return { __, default: __ };
});

import { bandOf, cartWeight, deliveryCharge, quoteOffline, type DeliveryPolicy } from "@/services/delivery";
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

	it("several addresses: a picker lists street and town, and the chosen one is quoted", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm, barn] }, siteQuote({ amount: 45, miles: 17.4, description: "17.4 mi, band 2 (1,600 lb)" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 2 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		const choices = wrapper.findAll("[data-testid='delivery-address']");
		expect(choices.map((c) => c.text())).toEqual(["4410 Old Fairground Rd, Dunn · 42 mi", "12 Mill Rd, Angier · 17.4 mi"]);
		await choices[1].trigger("click");
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

	it("no quote (no miles yet): Leslie types the charge", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [{ ...farm, miles: null, miles_source: null }] },
			siteQuote({ amount: null, source: "none", miles: null, band: null, description: "No miles for this address; type the delivery charge" }));
		const { cart, wrapper } = await counter({ xpos_has_address: true });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.text()).toContain("No miles for this address; type the delivery charge");
		expect(deliveryLines(cart)).toEqual([]);
		await wrapper.get("[data-testid='delivery-amount']").setValue("60");
		await wrapper.get("[data-testid='delivery-amount-use']").trigger("click");
		expect(deliveryLines(cart)).toEqual([[1, 60, "Delivery (typed)"]]);
	});

	it("negative: not offered for a customer with no address, or when the site quotes no delivery", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [] });
		const { wrapper } = await counter({ xpos_has_address: false, xpos_address_count: 0 });
		expect(wrapper.find("[data-testid='add-delivery']").exists()).toBe(false);

		setActivePinia(createPinia());
		state.meta = new Map([["delivery_policy", "null"]]);
		state.call.mockResolvedValue(null);
		const other = await counter({ xpos_has_address: true, xpos_address_count: 1 });
		expect(other.wrapper.find("[data-testid='add-delivery']").exists()).toBe(false);
	});
});

describe("Add delivery with the till offline (priced from the cache)", () => {
	it("prices a known address from its cached miles, the cached policy and cached item weights", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		await wrapper.get("[data-testid='delivery-address']").trigger("click");
		await flushPromises();
		expect(state.call).not.toHaveBeenCalled();
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
		await wrapper.get("[data-testid='delivery-address']").trigger("click");
		await flushPromises();
		expect(deliveryLines(cart)).toEqual([[1, 80, "Standing rate"]]);
	});

	it("a new address typed offline is priced from the typed miles, and the sale and address are flagged", async () => {
		state.online = false;
		state.items.set("FEED-50", { item_code: "FEED-50", weight_per_unit: 125 }); // 32 x 125 = 4,000 lb, band 4
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		const form = wrapper.get("[data-testid='delivery-new-address']");
		await form.get("input[placeholder='Street address']").setValue("88 New Ground Rd");
		await form.get("input[placeholder='City']").setValue("Coats");
		await form.get("input[placeholder='Miles one way']").setValue("17.4");
		await wrapper.get("[data-testid='delivery-new-address-use']").trigger("click");
		await flushPromises();
		// 17.4 mi x $5 = $87 -> $85 at full load (a shared vector).
		expect(deliveryLines(cart)).toEqual([[1, 85, "17.4 mi, band 4 (4,000 lb), miles typed offline"]]);
		const sale = cart.getInvoiceData("Till", "SHIFT-1");
		expect(sale.shipping_address_name).toBeUndefined();
		expect(sale.xpos_new_shipping_address).toEqual({ address_line1: "88 New Ground Rd", city: "Coats", miles: 17.4 });
		expect(sale.xpos_delivery).toMatchObject({ source: "miles", amount: 85, miles: 17.4, miles_source: "manual_offline", address: "" });
	});

	it("negative: a new address needs a street, a town and miles above zero", async () => {
		state.online = false;
		const { cart, wrapper } = await counter({
			xpos_has_address: true,
			xpos_delivery: { standing_charge: 0, no_charge: false, addresses: [farm] },
		});
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		const form = wrapper.get("[data-testid='delivery-new-address']");
		await form.get("input[placeholder='Street address']").setValue("88 New Ground Rd");
		await form.get("input[placeholder='City']").setValue("Coats");
		await form.get("input[placeholder='Miles one way']").setValue("0");
		expect(wrapper.get("[data-testid='delivery-new-address-use']").attributes("disabled")).toBeDefined();
		expect(deliveryLines(cart)).toEqual([]);
	});

	it("the online picker offers no typed new address (Edit Customer adds addresses online)", async () => {
		serve({ standing_charge: 0, no_charge: false, addresses: [farm, barn] });
		const { wrapper } = await counter({ xpos_has_address: true, xpos_address_count: 2 });
		await wrapper.get("[data-testid='add-delivery']").trigger("click");
		await flushPromises();
		expect(wrapper.find("[data-testid='delivery-new-address']").exists()).toBe(false);
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
