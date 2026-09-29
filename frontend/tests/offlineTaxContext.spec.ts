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

const { call, cache, online } = vi.hoisted(() => ({
	call: vi.fn(),
	cache: new Map<string, unknown>(),
	online: { value: true },
}));

vi.mock("@/services/api", () => ({ call, default: { call }, showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	cacheTaxContext: vi.fn(async (p: string, c: string, ctx: unknown) => void cache.set(`${p}|${c}`, ctx)),
	getCachedTaxContext: vi.fn(async (p: string, c: string) => cache.get(`${p}|${c}`) ?? null),
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
		expect(cart.muleTaxError).toMatch(/Tax lookup failed/);
	});
});
