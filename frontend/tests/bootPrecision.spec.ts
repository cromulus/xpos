/**
 * @vitest-environment jsdom
 *
 * The web app reads its precisions from the page's boot. Without them the cart
 * rounded every line rate to a 3-place fallback, whatever the site's float
 * precision: a rate of 0.291628665 showed as 0.292.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/services/dbBridge", () => ({
	cacheERPSettings: vi.fn(),
	getCachedERPSettings: vi.fn(async () => null),
	getCachedItemByCode: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ taxes: [], posProfile: null, useOfflineMode: false }),
}));

import { useSettingsStore } from "@/stores/settingsStore";
import { useCartStore } from "@/stores/cartStore";

function setBoot(boot: Record<string, unknown>) {
	(window as unknown as { xpos: unknown }).xpos = {
		boot: { selling_settings: {}, buying_settings: {}, stock_settings: {}, accounts_settings: {}, ...boot },
	};
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
	delete (window as unknown as { xpos?: unknown }).xpos;
});

describe("precisions from the boot", () => {
	it("uses the boot's currency_precision for line rates", async () => {
		setBoot({ currency_precision: { currency_precision: "2", float_precision: "9" } });
		const settings = useSettingsStore();
		await settings.fetchSettings();

		expect(settings.currencyPrecision.float_precision).toBe("9");
		expect(settings.currencyPrecision.currency_precision).toBe("2");
		expect(useCartStore().itemRatePrecision).toBe(9);
	});

	it("falls back to the boot's sysdefaults when the server sends no currency_precision", async () => {
		setBoot({ sysdefaults: { currency_precision: "2", float_precision: "6" } });
		const settings = useSettingsStore();
		await settings.fetchSettings();

		expect(settings.currencyPrecision.float_precision).toBe("6");
		expect(useCartStore().itemRatePrecision).toBe(6);
	});

	it("keeps the 3-place default only when the site sets no float precision", async () => {
		setBoot({ sysdefaults: {} });
		await useSettingsStore().fetchSettings();
		expect(useCartStore().itemRatePrecision).toBe(3);
	});
});
