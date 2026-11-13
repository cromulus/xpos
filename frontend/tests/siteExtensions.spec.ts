/**
 * @vitest-environment jsdom
 *
 * XPOS on a plain ERPNext site: no app has registered a till extension, so the
 * boot has no `xpos_site` map. Every site feature stays off and nothing calls a
 * site method; the till's own defaults (taxes through ERPNext's party
 * resolution) are used. And no shipped file names a site app.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), isNetworkError: () => false, default: { call: vi.fn() } }));
vi.mock("@/services/dbBridge", () => ({
	getSyncMeta: vi.fn(async () => null),
	setSyncMeta: vi.fn(async () => undefined),
	getOfflineMeta: vi.fn(async () => null),
	setOfflineMeta: vi.fn(async () => undefined),
}));
vi.mock("@/stores/posStore", () => ({ usePosStore: vi.fn(() => ({ profileName: "Counter", defaultCustomer: "" })) }));
vi.mock("@/stores/offlineStore", () => ({ useOfflineStore: vi.fn(() => ({ isOnline: true })) }));
vi.mock("@/stores/authStore", () => ({ useAuthStore: vi.fn(() => ({ userName: "cashier@example.com" })) }));
vi.mock("@/services/electronBridge", () => ({ getApiBaseUrlSync: () => "" }));

import { call } from "@/services/api";
import { requireSiteMethod, siteFeature, siteMethod, siteValue } from "@/services/siteExtensions";
import { ordersInFlightEnabled, useOpenOrdersStore } from "@/stores/openOrdersStore";
import { refreshPrintBrand } from "@/services/printBrand";
import { attachOfflineCoverage, prepareVfdPickup, queuedInvoiceMethod, refreshVfdContext } from "@/services/vfdOffline";
import { orderLineFields } from "@/services/orderLineFields";
import { customerCodes } from "@/utils/customerMatch";
import { installSiteExtension } from "./helpers/siteExtension";

const sale = {
	local_id: "L1",
	pos_profile: "Counter",
	customer: "C1",
	items: [{ item_code: "FEED", qty: 1, mule_vfd: "VFD-1", so_detail: "SOD-1" }],
} as never;

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	(window as any).xpos = { boot: {} };
});

afterEach(() => {
	delete (window as any).xpos;
});

describe("a site with no till extensions", () => {
	it("taxes through XPOS's own methods, and has no other site method", () => {
		expect(siteMethod("tax_context")).toBe("xpos.api.party_taxes.tax_context");
		expect(siteMethod("tax_contexts")).toBe("xpos.api.party_taxes.tax_contexts");
		for (const key of ["find_orders", "pickup_invoice", "mix.quote", "mix.checkout", "charge_override.sale",
			"item_details", "print_brand", "help", "vfd.replay"]) {
			expect(siteMethod(key)).toBeUndefined();
			expect(() => requireSiteMethod(key)).toThrow();
		}
		for (const flag of ["mix", "charge_override", "help", "practice_site", "vfd"]) {
			expect(siteFeature(flag)).toBe(false);
		}
	});

	it("negative: a site may turn a default off", () => {
		installSiteExtension({ tax_context: "", tax_contexts: false });
		expect(siteMethod("tax_context")).toBeUndefined();
		expect(siteMethod("tax_contexts")).toBeUndefined();
	});

	it("works with no boot at all (a desktop start before login)", () => {
		delete (window as any).xpos;
		expect(siteValue("mix")).toBeUndefined();
		expect(siteMethod("tax_context")).toBe("xpos.api.party_taxes.tax_context");
	});

	it("shows no orders in flight and never asks for them", async () => {
		expect(ordersInFlightEnabled()).toBe(false);
		expect(await useOpenOrdersStore().load(null, "")).toBeNull();
		await useOpenOrdersStore().prefetchAll();
		expect(call).not.toHaveBeenCalled();
	});

	it("prints the offline receipt without a site brand, and never asks for one", async () => {
		expect(await refreshPrintBrand(null)).toBeNull();
		expect(call).not.toHaveBeenCalled();
	});

	it("never checks or prepares a regulated pickup, and replays every sale through create_invoice", async () => {
		await refreshVfdContext("Counter");
		await prepareVfdPickup(sale);
		await attachOfflineCoverage(sale);
		expect((sale as any).mule_vfd_offline).toBeUndefined();
		expect(queuedInvoiceMethod(sale)).toBe("xpos.api.invoices.create_invoice");
		expect(call).not.toHaveBeenCalled();
	});

	it("carries only native order links on a line, and shows no site customer codes", () => {
		expect(orderLineFields({ so_detail: "SOD-1", mule_vfd: "VFD-1", bom_no: "BOM-1" })).toEqual({
			so_detail: "SOD-1",
			bom_no: "BOM-1",
		});
		expect(customerCodes({ name: "C1", mule_filepro_alias_codes: "2980" })).toBe("");
	});
});

describe("the site map only names methods", () => {
	it("a site's map is read by dotted key; values pass through unchanged", () => {
		installSiteExtension({ mix: { quote: "site_app.mixes.quote" }, practice_site: true, order_line_fields: ["x_line"] });
		expect(siteMethod("mix.quote")).toBe("site_app.mixes.quote");
		expect(siteFeature("mix")).toBe(true);
		expect(siteFeature("practice_site")).toBe(true);
		expect(orderLineFields({ x_line: "1", other: "2" })).toEqual({ x_line: "1" });
		// A list is not a group of methods.
		expect(siteMethod("order_line_fields.0")).toBeUndefined();
	});
});

describe("no shipped file names a site app", () => {
	const root = resolve(__dirname, "..");
	function files(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
			return /\.(ts|vue|js|mjs)$/.test(name) ? [path] : [];
		});
	}
	it("src, electron, sw and scripts never mention mulecity_erpnext", () => {
		const offenders = ["src", "electron", "sw", "scripts"]
			.flatMap((dir) => files(join(root, dir)))
			.filter((path) => readFileSync(path, "utf8").includes("mulecity_erpnext"));
		expect(offenders).toEqual([]);
	});
});
