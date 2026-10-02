/**
 * Bill 2026-10-01 (MuleCity-qajl.1): "online and in sync can be combined into one
 * thing." One label in the top bar reads right online, offline and with a sale
 * waiting to post.
 */
import { describe, expect, it } from "vitest";
import { statusSummary, type StatusInput } from "@/utils/statusSummary";

const base: StatusInput = { online: true, syncing: false, pending: 0, deadLetters: 0, offlineMode: true, cacheLoading: false, cacheReady: true };

describe("the one status label", () => {
	it("online and in sync", () => {
		expect(statusSummary(base)).toEqual({ label: "Online · in sync", tone: "ok" });
	});
	it("offline, on the saved data", () => {
		expect(statusSummary({ ...base, online: false, cacheReady: false })).toEqual({ label: "Offline · saved data", tone: "bad" });
	});
	it("offline with a sale waiting", () => {
		expect(statusSummary({ ...base, online: false, pending: 1 })).toEqual({ label: "Offline · 1 pending · saved data", tone: "bad" });
	});
	it("back online with a sale still waiting", () => {
		expect(statusSummary({ ...base, pending: 2 })).toEqual({ label: "Online · 2 pending · in sync", tone: "warn" });
	});
	it("posting the waiting sales", () => {
		expect(statusSummary({ ...base, syncing: true, pending: 2 }).label).toBe("Syncing… · 2 pending · in sync");
	});
	it("a refused sale needs attention", () => {
		expect(statusSummary({ ...base, deadLetters: 1 })).toEqual({ label: "Online · 1 need attention · in sync", tone: "bad" });
	});
	it("the cache is stale or refreshing", () => {
		expect(statusSummary({ ...base, cacheReady: false })).toEqual({ label: "Online · check data sync", tone: "warn" });
		expect(statusSummary({ ...base, cacheLoading: true, cacheReady: false })).toEqual({ label: "Online · refreshing data", tone: "busy" });
	});
	it("a register without offline mode reports no cache", () => {
		expect(statusSummary({ ...base, offlineMode: false, pending: 1 }).label).toBe("Online · 1 pending");
	});
});
