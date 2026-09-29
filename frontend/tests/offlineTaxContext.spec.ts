/**
 * @vitest-environment jsdom
 *
 * User story (Mule City staging drill, 2026-09-29): the internet drops; Leslie
 * rings up a walk-in sale, then a second one. Every new cart looks the
 * customer's taxes up again (Mule City's tax_context); offline that call fails,
 * so the second cart said "Tax lookup failed" and could not be paid. The till
 * keeps each customer's tax context from when it was online and uses it for
 * the next cart while offline. Online, a failed lookup still stops payment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const { call, cache, categories, synced, online } = vi.hoisted(() => ({
	call: vi.fn(),
	cache: new Map<string, unknown>(),
	// What the offline sync keeps: every category's taxes, and the customer rows.
	categories: new Map<string, unknown>(),
	synced: new Map<string, Record<string, unknown>>(),
	online: { value: true },
}));

vi.mock("@/services/api", () => ({ call, default: { call }, showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	cacheTaxContext: vi.fn(async (p: string, c: string, ctx: unknown) => void cache.set(`${p}|${c}`, ctx)),
	getCachedTaxContext: vi.fn(async (p: string, c: string) => cache.get(`${p}|${c}`) ?? null),
	getCachedCategoryTaxContext: vi.fn(async (p: string, category: string | null) => categories.get(`${p}|${category || ""}`) ?? null),
	getCustomer: vi.fn(async (name: string) => synced.get(name) ?? null),
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
		companyName: "Mule City Specialty Feeds",
		profile: { name: "Mule City Retail", currency: "USD" },
		currency: "USD",
		tenderModeFor: vi.fn(() => undefined),
	})),
}));

import { useCartStore } from "@/stores/cartStore";

const CONTEXT = { taxes: [{ account_head: "NC Sales Tax", rate: 6.75 }], tax_category: "", tax_exempt_reason: "" };

async function pick(cart: ReturnType<typeof useCartStore>, name: string) {
	cart.customer = { name } as never;
	await flushPromises();
}

beforeEach(() => {
	setActivePinia(createPinia());
	call.mockReset();
	cache.clear();
	categories.clear();
	synced.clear();
	online.value = true;
});

describe("the customer's tax context while offline", () => {
	it("taxes the next walk-in cart from the context kept while online", async () => {
		const cart = useCartStore();
		call.mockResolvedValueOnce(CONTEXT);
		await pick(cart, "Walk-In Customer");
		expect(cart.muleTaxError).toBe("");

		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		await pick(cart, "");
		await pick(cart, "Walk-In Customer");

		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxPending).toBe(false);
	});

	it("still stops payment when a lookup fails online, or offline with nothing kept", async () => {
		const cart = useCartStore();
		call.mockRejectedValue(new Error("Server error"));
		await pick(cart, "Named Farm");
		expect(cart.muleTaxError).toMatch(/Tax lookup failed/);

		online.value = false;
		await pick(cart, "Never Seen Farm");
		expect(cart.muleTaxError).toMatch(/No tax information for this customer on this till yet/);
	});
});

const PROFILE = "Mule City Retail";
const TAXABLE = { taxes: [{ account_head: "NC Sales Tax", rate: 6.75 }], tax_category: "Mule City Taxable", taxes_and_charges: "Mule City NC Sales Tax 6.75% - MCSF" };
const EXEMPT = { taxes: [], tax_category: "Mule City Exempt", taxes_and_charges: "Mule City Tax Exempt - MCSF" };

describe("a customer this till never looked up online (MuleCity-ispl)", () => {
	beforeEach(() => {
		categories.set(`${PROFILE}|Mule City Taxable`, TAXABLE);
		categories.set(`${PROFILE}|Mule City Exempt`, EXEMPT);
		categories.set(`${PROFILE}|`, TAXABLE);
	});

	it("is taxed offline by the category on their synced row", async () => {
		const cart = useCartStore();
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		cart.customer = { name: "Sharp Farms", tax_category: "Mule City Exempt" } as never;
		await flushPromises();
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
	});

	it("finds the category on the synced row when the cart's customer lacks it", async () => {
		const cart = useCartStore();
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		synced.set("Named Farm", { name: "Named Farm", tax_category: "Mule City Taxable" });
		await pick(cart, "Named Farm");
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Taxable");
	});

	it("uses the synced category over a stale per-customer context (Brandy moved them to Farm)", async () => {
		const cart = useCartStore();
		// Rung up online last week as Taxable: that context is kept per customer.
		cache.set(`${PROFILE}|Moved Farm`, { ...TAXABLE, tax_exempt_reason: null });
		// Since then Brandy made them exempt; the offline sync's row says so.
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		cart.customer = { name: "Moved Farm", tax_category: "Mule City Exempt" } as never;
		await flushPromises();
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
	});

	it("falls back to the per-customer context when the row predates synced categories", async () => {
		const cart = useCartStore();
		cache.set(`${PROFILE}|Old Row`, { ...EXEMPT, tax_exempt_reason: "Farm" });
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		await pick(cart, "Old Row");
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
		expect(cart.muleTaxExemptReason).toBe("Farm");
	});

	it("still stops payment offline when neither a category nor a kept context exists", async () => {
		const cart = useCartStore();
		categories.clear();
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		cart.customer = { name: "Brand New", tax_category: "Mule City Taxable" } as never;
		await flushPromises();
		expect(cart.muleTaxError).toMatch(/No tax information for this customer on this till yet/);
	});
});
