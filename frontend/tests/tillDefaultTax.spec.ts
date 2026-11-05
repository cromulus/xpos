/**
 * @vitest-environment jsdom
 *
 * User story (Bill, staging 2026-11-05, MuleCity-s9jt): "saving a draft pos cart,
 * we get this error: 'Tax lookup failed. Reselect the customer to retry before
 * taking payment.' should be default sales tax if we have no customer."
 *
 * Saving a draft resets the cart to the walk-in; that lookup landed in a deploy's
 * maintenance window (HTTP 503) and the till gave up, on an empty walk-in cart with
 * nobody to reselect. Now: a server down for a moment is treated like offline (the
 * context the till kept); any other failure is asked once more; no buyer is taxed at
 * the default rate; a named customer whose lookup really fails is never charged the
 * default rate (a farm customer would be overcharged), and Retry asks again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const { call, cache, categories, online, pos } = vi.hoisted(() => ({
	call: vi.fn(),
	cache: new Map<string, unknown>(),
	categories: new Map<string, unknown>(),
	online: { value: true },
	pos: {
		taxes: [] as unknown[],
		taxInclusiveMode: false,
		profileName: "Mule City Retail",
		companyName: "Mule City Specialty Feeds",
		defaultCustomer: "Walk-In Customer",
		profile: { name: "Mule City Retail", currency: "USD" },
		currency: "USD",
		tenderModeFor: () => undefined,
	},
}));

vi.mock("@/services/api", () => ({ call, default: { call }, showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	cacheTaxContext: vi.fn(async (p: string, c: string, ctx: unknown) => void cache.set(`${p}|${c}`, ctx)),
	getCachedTaxContext: vi.fn(async (p: string, c: string) => cache.get(`${p}|${c}`) ?? null),
	getCachedCategoryTaxContext: vi.fn(async (p: string, category: string | null) => categories.get(`${p}|${category || ""}`) ?? null),
	getCustomer: vi.fn(async () => null),
}));
vi.mock("@/utils", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isOnline: () => online.value }));
vi.mock("@/stores/posStore", () => ({ usePosStore: vi.fn(() => pos) }));

import { muleTaxTiming, useCartStore } from "@/stores/cartStore";

const PROFILE = "Mule City Retail";
const TAXABLE = { taxes: [{ account_head: "NC Sales Tax Payable - MCSF", rate: 6.75 }], tax_category: "Mule City Taxable", taxes_and_charges: "Mule City NC Sales Tax 6.75% - MCSF", tax_exempt_reason: null };
const EXEMPT = { taxes: [], tax_category: "Mule City Exempt", taxes_and_charges: "Mule City Tax Exempt - MCSF", tax_exempt_reason: "Farm" };

/** An HTTP error as services/api throws it. */
function httpError(status: number, message = "Server error"): Error {
	return Object.assign(new Error(message), { status });
}

const taxContextCalls = () => call.mock.calls.filter(([method]) => method === "mulecity_erpnext.pos_workspace.tax_context");

async function settle() {
	for (let i = 0; i < 4; i++) {
		await flushPromises();
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function pick(cart: ReturnType<typeof useCartStore>, name: string | null) {
	cart.customer = (name ? { name } : null) as never;
	await settle();
}

const rates = () => (pos.taxes as { rate: number }[]).map((t) => t.rate);

beforeEach(() => {
	setActivePinia(createPinia());
	call.mockReset();
	cache.clear();
	categories.clear();
	online.value = true;
	pos.taxes = [];
	muleTaxTiming.retryMs = 0;
});

describe("a cart with no customer (MuleCity-s9jt)", () => {
	it("is taxed at the default rate from the server, asked with no customer", async () => {
		const cart = useCartStore();
		call.mockResolvedValue(EXEMPT);
		await pick(cart, "Sharp Farms");
		call.mockResolvedValue(TAXABLE);
		await pick(cart, null);
		expect(taxContextCalls().at(-1)).toEqual(["mulecity_erpnext.pos_workspace.tax_context", { customer: null, pos_profile: PROFILE }]);
		expect(cart.muleTaxError).toBe("");
		expect(rates()).toEqual([6.75]);
	});

	it("goes back to the default rate when an exempt customer is cleared", async () => {
		const cart = useCartStore();
		call.mockImplementation(async (_m: string, args: { customer: string | null }) => (args.customer === "Sharp Farms" ? EXEMPT : TAXABLE));
		await pick(cart, "Sharp Farms");
		expect(rates()).toEqual([]);
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
		await pick(cart, null);
		expect(rates()).toEqual([6.75]);
		expect(cart.muleTaxCategory).toBe("Mule City Taxable");
	});

	it("offline with nothing kept: no error, the walk-in is taxed when it is put on", async () => {
		const cart = useCartStore();
		online.value = false;
		call.mockRejectedValue(new Error("Failed to fetch"));
		await pick(cart, null);
		expect(cart.muleTaxError).toBe("");
	});
});

describe("the server is down for a moment (a deploy's maintenance window)", () => {
	it("the walk-in after a draft save is taxed from the context the till kept, no error", async () => {
		const cart = useCartStore();
		call.mockResolvedValueOnce(TAXABLE);
		await pick(cart, "Walk-In Customer");
		expect(rates()).toEqual([6.75]);

		// Draft saved; the cart resets to the walk-in and the lookup gets a 503.
		await pick(cart, "Sharp Farms");
		pos.taxes = [];
		call.mockRejectedValue(httpError(503, "Service Unavailable"));
		await pick(cart, "Walk-In Customer");
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxPending).toBe(false);
		expect(rates()).toEqual([6.75]);
	});

	it("a customer in a kept category is taxed by that category on a 502", async () => {
		const cart = useCartStore();
		categories.set(`${PROFILE}|Mule City Exempt`, EXEMPT);
		call.mockRejectedValue(httpError(502));
		cart.customer = { name: "Sharp Farms", tax_category: "Mule City Exempt" } as never;
		await settle();
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
	});

	it("nothing kept: asks once more and takes the answer", async () => {
		const cart = useCartStore();
		call.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(EXEMPT);
		await pick(cart, "Sharp Farms");
		expect(taxContextCalls()).toHaveLength(2);
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
	});
});

describe("a named customer whose lookup really fails", () => {
	it("is asked exactly twice, keeps the message, and is never charged the default rate", async () => {
		const cart = useCartStore();
		call.mockRejectedValue(httpError(500));
		await pick(cart, "Sharp Farms");
		expect(taxContextCalls()).toHaveLength(2);
		expect(cart.muleTaxError).toMatch(/Tax lookup failed/);
		expect(cart.muleTaxError).toMatch(/Retry/);
		expect(rates()).toEqual([]);
	});

	it("Retry asks again and clears the message when it answers", async () => {
		const cart = useCartStore();
		call.mockRejectedValue(httpError(500));
		await pick(cart, "Sharp Farms");
		expect(cart.muleTaxError).toMatch(/Tax lookup failed/);

		call.mockReset();
		call.mockResolvedValue(EXEMPT);
		cart.retryTaxLookup();
		await settle();
		expect(taxContextCalls()).toHaveLength(1);
		expect(cart.muleTaxError).toBe("");
		expect(cart.muleTaxCategory).toBe("Mule City Exempt");
	});
});
