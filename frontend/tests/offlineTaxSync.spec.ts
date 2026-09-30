/**
 * @vitest-environment jsdom
 *
 * User story (MuleCity-ispl): while online, the till's background sync keeps
 * every tax category's taxes (Mule City's tax_contexts) beside the customers
 * and products, so later, offline, any synced customer can be taxed. The data
 * sync status lists it as "Taxes"; a failure shows there, not as a crash.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { call, cacheTaxContexts } = vi.hoisted(() => ({
	call: vi.fn(),
	cacheTaxContexts: vi.fn(async () => {}),
}));

vi.mock("@/services/api", () => ({ call, default: { call }, showError: vi.fn(), showSuccess: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	cacheTaxContexts,
}));

import { useOfflineStore } from "@/stores/offlineStore";
import { useCacheStatus } from "@/stores/cacheStatus";

const CONTEXTS = {
	"": { tax_category: null, taxes: [{ rate: 6.75 }] },
	"Mule City Exempt": { tax_category: "Mule City Exempt", taxes: [] },
};

beforeEach(() => {
	setActivePinia(createPinia());
	call.mockReset();
	cacheTaxContexts.mockClear();
});

describe("the offline sync keeps every category's taxes", () => {
	it("asks for the register's tax contexts and keeps them", async () => {
		call.mockResolvedValueOnce(CONTEXTS);
		await useOfflineStore().cacheTaxContextsForOffline("Mule City Retail");

		expect(call).toHaveBeenCalledWith("mulecity_erpnext.pos_workspace.tax_contexts", { pos_profile: "Mule City Retail" });
		expect(cacheTaxContexts).toHaveBeenCalledWith("Mule City Retail", CONTEXTS);
		const state = useCacheStatus().states.Taxes;
		expect(state).toMatchObject({ profile: "Mule City Retail", count: 2, complete: true, error: false });
	});

	it("records a failed refresh without keeping anything", async () => {
		call.mockRejectedValueOnce(new Error("Server error"));
		await expect(useOfflineStore().cacheTaxContextsForOffline("Mule City Retail")).rejects.toThrow();
		expect(cacheTaxContexts).not.toHaveBeenCalled();
		expect(useCacheStatus().states.Taxes).toMatchObject({ error: true, loading: false });
	});
});
