/**
 * @vitest-environment jsdom
 *
 * Default pickup/delivery day (Mule City MuleCity-nd08.1, spec custom-mix-formulation-v2 §7.2).
 *
 * User story: on Thursday 2026-11-19 Leslie puts Steve's goat mix in the cart.
 * The mill needs two business days, so the order's pickup day already reads
 * Monday 2026-11-23 (the site's `default_ready_date` method skips the weekend
 * and the company's Holiday List); a delivery added to the sale goes that day
 * too. She can still pick any other day. A site without the extension, an
 * offline till or a failed call falls back to today, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

const { online } = vi.hoisted(() => ({ online: { value: true } }));

vi.mock("@/services/api", () => ({
	call: vi.fn(),
	default: { call: vi.fn() },
}));

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
	cacheTaxContext: vi.fn(async () => undefined),
	getCachedTaxContext: vi.fn(async () => null),
	getCachedCategoryTaxContext: vi.fn(async () => null),
}));

vi.mock("@/utils", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	isOnline: () => online.value,
}));

vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profileName: "Mule City Retail",
		companyName: "Mule City",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores - MC",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: true,
		stockSettings: { allow_negative_stock: false },
	})),
}));

vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({
		updates: [],
		free_lines: [],
		invoice_updates: { additional_discount_percentage: 0, discount_amount: 0, apply_discount_on: "Grand Total", from_pricing_rule: false },
		source: "server",
	})),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));

import { call } from "@/services/api";
import { useCartStore } from "@/stores/cartStore";
import type { POSItem } from "@/types/pos.types";
import { installSiteExtension, SITE_FIXTURE } from "./helpers/siteExtension";
import { siteMapChanged } from "@/services/siteExtensions";

const mockedCall = vi.mocked(call);
const READY = "mulecity_erpnext.operating_defaults.get_default_ready_date";

function mix(overrides: Partial<POSItem> = {}): POSItem {
	return {
		item_code: "MC-MIX-STEVE",
		item_name: "Steve's goat mix",
		rate: 20,
		uom: "Nos",
		stock_uom: "Nos",
		conversion_factor: 1,
		item_group: "Feed",
		is_stock_item: true,
		actual_qty: 0,
		is_made_to_order: 1,
		...overrides,
	} as POSItem;
}

const policy = { item: { item_code: "DELIVERY", item_name: "Delivery", item_group: "Services", stock_uom: "Nos" } } as never;
const address = { name: "ADDR-FARM", address_line1: "77 Feed Lot Ln", city: "Benson", miles: 0 } as never;
const quote = { source: "standing", description: "Standing charge", amount: 25 } as never;

function withReadyDate(reply: unknown) {
	installSiteExtension({ ...SITE_FIXTURE, default_ready_date: READY });
	mockedCall.mockImplementation(async (method: string) => {
		if (method !== READY) return undefined;
		if (reply instanceof Error) throw reply;
		return reply;
	});
}

describe("the default pickup/delivery day", () => {
	beforeEach(() => {
		// Thursday 2026-11-19, mid-morning local time.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 10, 19, 10, 0, 0));
		setActivePinia(createPinia());
		vi.clearAllMocks();
		mockedCall.mockReset();
		online.value = true;
	});

	afterEach(() => {
		vi.useRealTimers();
		const boot = (globalThis as { xpos?: { boot?: Record<string, unknown> } }).xpos?.boot;
		if (boot) delete boot.xpos_site;
		siteMapChanged();
	});

	it("a mix order's pickup day starts at the site's ready date (Thursday -> Monday)", async () => {
		withReadyDate({ date: "2026-11-23" });
		const cart = useCartStore();
		cart.addItem(mix());
		await flushPromises();
		expect(cart.pickupDate).toBe("2026-11-23");
		expect(mockedCall).toHaveBeenCalledWith(READY, { company: "Mule City" });
	});

	it("a delivery added without a day goes on the ready date, and the order's pickup follows it", async () => {
		withReadyDate({ date: "2026-11-23" });
		const cart = useCartStore();
		await cart.loadDefaultReadyDate();
		cart.setDelivery(policy, address, quote, 25);
		expect(cart.deliveryDate).toBe("2026-11-23");
		expect(cart.defaultReadyDate()).toBe("2026-11-23");
	});

	it("asks the site once a day, not once a line", async () => {
		withReadyDate({ date: "2026-11-23" });
		const cart = useCartStore();
		cart.addItem(mix());
		await flushPromises();
		cart.clearCart();
		cart.addItem(mix({ item_code: "MC-MIX-OTHER" }));
		await flushPromises();
		expect(cart.pickupDate).toBe("2026-11-23");
		expect(mockedCall.mock.calls.filter(([method]) => method === READY)).toHaveLength(1);
	});

	it("keeps a pickup day the clerk already chose", async () => {
		withReadyDate({ date: "2026-11-23" });
		const cart = useCartStore();
		cart.pickupDate = "2026-11-30";
		cart.addItem(mix());
		await flushPromises();
		expect(cart.pickupDate).toBe("2026-11-30");
	});

	it("negative: a site without the extension uses today, without asking", async () => {
		installSiteExtension(SITE_FIXTURE);
		const cart = useCartStore();
		cart.addItem(mix());
		await flushPromises();
		expect(cart.pickupDate).toBe("2026-11-19");
		cart.setDelivery(policy, address, quote, 25);
		expect(cart.deliveryDate).toBe("2026-11-19");
		expect(mockedCall).not.toHaveBeenCalledWith(READY, expect.anything());
	});

	it("negative: a failed call, a junk reply or a past date falls back to today", async () => {
		for (const reply of [new Error("down"), { date: "Monday" }, null, { date: "2026-11-18" }]) {
			setActivePinia(createPinia());
			withReadyDate(reply);
			const cart = useCartStore();
			cart.addItem(mix());
			await flushPromises();
			expect(cart.pickupDate).toBe("2026-11-19");
		}
	});

	it("negative: an offline till's delivery goes today, without asking", async () => {
		// (An offline till refuses mix orders, so only a delivery takes the day.)
		withReadyDate({ date: "2026-11-23" });
		online.value = false;
		const cart = useCartStore();
		expect(await cart.loadDefaultReadyDate()).toBe("2026-11-19");
		cart.setDelivery(policy, address, quote, 25);
		expect(cart.deliveryDate).toBe("2026-11-19");
		expect(mockedCall).not.toHaveBeenCalledWith(READY, expect.anything());
	});

	it("negative: a sale with no order line gets no pickup day", async () => {
		withReadyDate({ date: "2026-11-23" });
		const cart = useCartStore();
		cart.addItem(mix({ actual_qty: 5 }));
		await flushPromises();
		expect(cart.pickupDate).toBe("");
	});
});
