// The till's clock in US Eastern, where a UTC-midnight read lands on the day before.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import { formatLocalDate, parseLocalDate } from "@/utils/localDate";
import { deliveryDayLabel } from "@/services/receiptTemplate";

const SHORT: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };

/**
 * MuleCity-jh8j: ACC-SINV-49747/49748 (posting_date 2026-10-01, rung ~22:45 EDT)
 * were listed as "Sep 30, 2026" in the till's Orders list.
 */
describe("date-only values read as local days", () => {
	it("runs in a zone west of UTC (the old parse shows the day before)", () => {
		expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(240);
		expect(new Date("2026-10-01").toLocaleDateString("en-US", SHORT)).toBe("Sep 30, 2026");
	});

	it("shows a posting_date on its own day", () => {
		expect(formatLocalDate("2026-10-01", SHORT, "en-US")).toBe("Oct 1, 2026");
		expect(formatLocalDate("2026-01-01", SHORT, "en-US")).toBe("Jan 1, 2026");
		const day = parseLocalDate("2026-10-01")!;
		expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([2026, 9, 1, 0]);
	});

	it("leaves real datetimes to new Date", () => {
		expect(parseLocalDate("2026-10-02T02:45:00Z")!.getTime()).toBe(new Date("2026-10-02T02:45:00Z").getTime());
		expect(formatLocalDate("2026-10-02T02:45:00Z", SHORT, "en-US")).toBe("Oct 1, 2026");
		expect(parseLocalDate("2026-10-01 22:45:00")!.getDate()).toBe(1);
	});

	it("is empty for nothing or nonsense", () => {
		expect(formatLocalDate("", SHORT)).toBe("");
		expect(formatLocalDate(null, SHORT)).toBe("");
		expect(formatLocalDate("not a date", SHORT)).toBe("");
	});

	it("the delivery day uses the same reading", () => {
		expect(deliveryDayLabel("2026-10-05")).toBe("Monday, October 5, 2026");
		expect(deliveryDayLabel("2026-10-05 09:00:00")).toBe("Monday, October 5, 2026");
		expect(deliveryDayLabel("")).toBe("");
	});
});
