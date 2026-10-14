/**
 * Mule City has one branch (2026-10-14): the branch-transfer summaries read
 * Stock Entry, which the counter login may not, so the Reports tab does not
 * offer them, by list or by link.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/userRights", () => ({ hasPermission: () => true }));

import { getAccessibleReports, getReportDefinition, isReportAccessible } from "@/services/reports";

describe("the Reports tab", () => {
	it("leaves out the branch-transfer summaries and keeps the stock reports", () => {
		const slugs = getAccessibleReports().map((r) => r.slug);
		expect(slugs).not.toContain("branch-item-summary");
		expect(slugs).not.toContain("branch-set-summary");
		expect(slugs).toContain("current-stock-report");
		expect(isReportAccessible(getReportDefinition("branch-set-summary")!)).toBe(false);
	});
});
