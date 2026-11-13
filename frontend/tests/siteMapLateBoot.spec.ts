/**
 * @vitest-environment jsdom
 *
 * The till is opened signed out (a Guest boot, no `xpos_site` map) and the
 * cashier signs in inside the SPA, with no page reload. The signed-in boot
 * arrives later (sessionBoot); the site's features must follow it, not stay as
 * they were when the stores were made (review of MuleCity-py8t.76).
 *
 * And the offline feed check fails closed: a till that has checked coverage
 * before keeps checking while it cannot tell whether the site still wants it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const meta = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/services/dbBridge", () => ({
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
	getOfflineMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
	setOfflineMeta: vi.fn(async (key: string, value: unknown) => void meta.set(key, value)),
}));
vi.mock("@/services/idbService", () => ({
	setMeta: vi.fn(async () => undefined),
	getMeta: vi.fn(async () => undefined),
	deleteMeta: vi.fn(async () => undefined),
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({
		taxes: [],
		taxInclusiveMode: false,
		profileName: "Counter",
		companyName: "Mill",
		sellingPriceList: "Standard Selling",
		warehouse: "Stores",
		currency: "USD",
		currencySymbol: "$",
		disableRoundedTotal: true,
		allowChangePostingDate: false,
		blockSaleBeyondAvailableQty: false,
		stockSettings: { allow_negative_stock: true },
	})),
}));
vi.mock("@/stores/authStore", () => ({ useAuthStore: vi.fn(() => ({ userName: "Clerk" })) }));
vi.mock("@/services/pricingService", () => ({
	resolveCartPricing: vi.fn(async () => ({
		updates: [],
		free_lines: [],
		invoice_updates: { additional_discount_percentage: 0, discount_amount: 0, apply_discount_on: "Grand Total", from_pricing_rule: false },
		source: "server",
	})),
	refreshPricingRuleSnapshot: vi.fn(async () => []),
}));
vi.mock("@/services/api", () => ({ call: vi.fn(async () => undefined), default: { call: vi.fn() } }));

import { call } from "@/services/api";
import { ensureFreshSession, markSessionStale, resetSessionState } from "@/services/sessionBoot";
import { siteFeature, siteMapChanged, siteMapComplete } from "@/services/siteExtensions";
import { attachOfflineCoverage, queuedInvoiceMethod, refreshVfdContext } from "@/services/vfdOffline";
import { useCartStore } from "@/stores/cartStore";
import type { InvoiceData, POSItem } from "@/types/pos.types";
import { computed } from "vue";

const SITE = {
	tax_context: "site_app.pos.tax_context",
	mix: { quote: "site_app.mixes.quote", checkout: "site_app.mixes.checkout" },
	vfd: { context: "site_app.vfd.context", prepare: "site_app.vfd.prepare", replay: "site_app.vfd.replay" },
};

function setBoot(boot: Record<string, unknown>): void {
	(window as any).xpos = { boot };
	siteMapChanged();
}

function signedInBoot(site: Record<string, unknown> = SITE) {
	return { user: { name: "Clerk" }, xpos_site: site };
}

function mix(): POSItem {
	return {
		item_code: "MIX-1",
		item_name: "A customer's mix",
		rate: 20,
		uom: "Bag",
		stock_uom: "Bag",
		conversion_factor: 1,
		item_group: "Feed",
		is_stock_item: true,
		actual_qty: 0,
		is_made_to_order: 1,
	} as POSItem;
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	meta.clear();
	resetSessionState();
	setBoot({ user: { name: "Guest" } });
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete (window as any).xpos;
	siteMapChanged();
});

describe("signing in inside the SPA, no reload", () => {
	it("a cart made on the Guest boot treats a custom mix as an order once the signed-in boot arrives", async () => {
		const cart = useCartStore();
		const mixesOn = computed(() => siteFeature("mix"));
		cart.addItem(mix());
		// The Guest boot has no map: no mixes yet.
		expect(mixesOn.value).toBe(false);
		expect(cart.hasOrderLines).toBe(false);

		// The login marks the session stale and fetches the signed-in boot (authStore.login).
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ message: { boot: signedInBoot(), csrf_token: "tok" } }),
			})),
		);
		markSessionStale();
		await ensureFreshSession();

		expect(mixesOn.value).toBe(true);
		expect(cart.hasOrderLines).toBe(true);
		expect(cart.isOrderLine(cart.items[0].uid)).toBe(true);
	});

	it("negative: a plain site's signed-in boot (no mix) leaves the mix an ordinary line", async () => {
		const cart = useCartStore();
		cart.addItem(mix());
		setBoot(signedInBoot({ tax_context: "xpos.api.party_taxes.tax_context" }));
		expect(cart.hasOrderLines).toBe(false);
	});
});

const sale = () =>
	({
		local_id: "L1",
		pos_profile: "Counter",
		customer: "C1",
		items: [{ item_code: "FEED", qty: 1, mule_vfd: "VFD-1", so_detail: "SOD-1" }],
	}) as unknown as InvoiceData;

const CONTEXT = {
	profile: "Counter",
	company: "Mill",
	cached_at: "2026-11-01 08:00:00",
	timezone: "America/New_York",
	items: { FEED: true },
	directives: { "VFD-1": 1 },
	user: "Clerk",
};

describe("the offline feed check fails closed", () => {
	async function cacheCoverage() {
		setBoot(signedInBoot());
		vi.mocked(call).mockResolvedValueOnce(CONTEXT as never);
		await refreshVfdContext("Counter");
	}

	it("the cached coverage keeps the site's replay method", async () => {
		await cacheCoverage();
		const cached = [...meta.values()][0] as Record<string, unknown>;
		expect(cached.replay_method).toBe("site_app.vfd.replay");
	});

	it("a Guest or stale boot (no map) still checks a till that has cached coverage", async () => {
		await cacheCoverage();
		setBoot({ user: { name: "Guest" } });
		expect(siteMapComplete()).toBe(false);
		// No prepared pickup on the device: refused, not queued unchecked.
		await expect(attachOfflineCoverage(sale())).rejects.toThrow(/Prepare this exact medicated pickup online/);
	});

	it("a failed site extension still checks, and replays through the cached method", async () => {
		await cacheCoverage();
		setBoot(signedInBoot({ tax_context: "xpos.api.party_taxes.tax_context", extension_errors: ["site_app.till.site_map"] }));
		expect(siteMapComplete()).toBe(false);
		await expect(attachOfflineCoverage(sale())).rejects.toThrow();
		// An ordinary item not in the cached coverage is refused too (go online first).
		const corn = { ...sale(), items: [{ item_code: "CORN", qty: 1 }] } as unknown as InvoiceData;
		await expect(attachOfflineCoverage(corn)).rejects.toThrow(/no cached feed coverage/);
		const queued = { mule_vfd_offline: { replay_method: "site_app.vfd.replay" } };
		expect(queuedInvoiceMethod(queued)).toBe("site_app.vfd.replay");
	});

	it("a whole map without vfd clears the cache and stops checking", async () => {
		await cacheCoverage();
		setBoot(signedInBoot({ tax_context: "xpos.api.party_taxes.tax_context" }));
		expect(siteMapComplete()).toBe(true);
		await refreshVfdContext("Counter");
		const plain = sale();
		await attachOfflineCoverage(plain);
		expect((plain as any).mule_vfd_offline).toBeUndefined();
		expect(queuedInvoiceMethod(plain)).toBe("xpos.api.invoices.create_invoice");
	});

	it("negative: a till that never cached coverage on a plain site sells offline unchecked", async () => {
		setBoot({ user: { name: "Guest" } });
		const plain = sale();
		await attachOfflineCoverage(plain);
		expect((plain as any).mule_vfd_offline).toBeUndefined();
	});
});
