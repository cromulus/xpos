// The till's clock in US Eastern.
process.env.TZ = "America/New_York";

/**
 * MuleCity-mon6: every offline print and screen formats dates and numbers with the site's
 * format (boot sysdefaults), never the browser's. Mule City's dates are mm-dd-yyyy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const meta = vi.hoisted(() => new Map<string, string>());
vi.mock("@/services/dbBridge", () => ({
	setSyncMeta: vi.fn(async (key: string, value: string) => void meta.set(key, value)),
	getSyncMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
	getCachedCurrencyMeta: vi.fn().mockResolvedValue([]),
}));

import {
	formatSiteDate,
	formatSiteInstant,
	formatSiteTime,
	loadSiteLocale,
	primeSiteLocale,
	saveSiteLocale,
	setSiteLocale,
	siteDateLocale,
	siteLocaleFromBoot,
	SITE_LOCALE_KEY,
} from "@/utils/siteLocale";
import { formatLocalDate } from "@/utils/localDate";
import { getUserDateFormat, getUserTimeZone } from "@/utils/datetime/formats";
import { sanitizeBoot } from "@/services/sessionBoot";
import { formatFor, formatWithSymbol, resetCurrencyCache } from "@/composables/useCurrency";
import { resetNumberFormatSettings } from "@/utils/numberFormat";

const MULE_BOOT = {
	user: { name: "counter@mulecity.com" },
	csrf_token: "secret-token",
	sysdefaults: {
		date_format: "mm-dd-yyyy",
		time_format: "HH:mm:ss",
		number_format: "#,###.##",
		currency: "USD",
		currency_precision: "2",
		float_precision: "3",
		api_key: "nope",
	},
	time_zone: { system: "America/New_York", user: "America/New_York" },
	currencies: [{ name: "USD", symbol: "$", number_format: "#,###.##" }],
};

beforeEach(() => {
	meta.clear();
	setSiteLocale(null);
	(window as any).xpos = { boot: JSON.parse(JSON.stringify(MULE_BOOT)) };
	resetNumberFormatSettings();
	resetCurrencyCache();
});

describe("the site's locale", () => {
	it("keeps only the seven locale values of the boot, never a secret", () => {
		const locale = siteLocaleFromBoot(MULE_BOOT)!;
		expect(Object.keys(locale).sort()).toEqual(
			["currency", "currency_precision", "date_format", "float_precision", "number_format", "time_format", "time_zone"].sort(),
		);
		expect(JSON.stringify(locale)).not.toMatch(/secret|nope|token/);
		expect(locale.date_format).toBe("mm-dd-yyyy");
		expect(locale.time_zone).toBe("America/New_York");
	});

	it("survives the saved offline boot (q8aq strips the token, keeps sysdefaults)", () => {
		const saved = sanitizeBoot(MULE_BOOT as any);
		expect(JSON.stringify(saved)).not.toContain("secret-token");
		expect(siteLocaleFromBoot(saved as any)!.date_format).toBe("mm-dd-yyyy");
	});

	it("formats a date in the site's format", () => {
		expect(formatSiteDate("2026-10-06")).toBe("10-06-2026");
		expect(formatSiteDate("2026-10-06", "dd-mm-yyyy")).toBe("06-10-2026");
		expect(formatSiteDate("2026-10-06", "yyyy-mm-dd")).toBe("2026-10-06");
		expect(formatSiteDate("2026-10-06", "mm/dd/yyyy")).toBe("10/06/2026");
		// Unknown format: ISO, not a guess.
		expect(formatSiteDate("2026-10-06", "")).toBe("2026-10-06");
	});

	it("formats a time in the site's time format", () => {
		expect(formatSiteTime("15:03:00.123456")).toBe("15:03:00");
		expect(formatSiteTime("15:03:00", "HH:mm")).toBe("15:03");
		expect(formatSiteTime("15:03:00", "hh:mm a")).toBe("03:03 PM");
	});

	it("gives the screens' toLocale calls the site's day/month order", () => {
		expect(siteDateLocale()).toBe("en-US");
		expect(formatLocalDate("2026-10-06")).toBe("10/6/2026");
		(window as any).xpos.boot.sysdefaults.date_format = "dd-mm-yyyy";
		expect(siteDateLocale()).toBe("en-GB");
		expect(formatLocalDate("2026-10-06")).toBe("06/10/2026");
	});

	it("shows instants in the site's time zone, not the device's", () => {
		(window as any).xpos.boot.time_zone = { system: "Asia/Karachi", user: "Asia/Karachi" };
		// 2026-10-06 20:00 UTC is Oct 7, 01:00 in Karachi, Oct 6 16:00 in New York.
		expect(formatSiteInstant("2026-10-06T20:00:00Z", { month: "short", day: "numeric" }, "date")).toBe("Oct 7");
	});
});

describe("offline cold start without a boot (the desktop app)", () => {
	it("is saved online (seven values) and restored offline", async () => {
		await saveSiteLocale(siteLocaleFromBoot(MULE_BOOT));
		expect(JSON.parse(meta.get(SITE_LOCALE_KEY)!)).toEqual(siteLocaleFromBoot(MULE_BOOT));

		// Cold start: no boot at all.
		setSiteLocale(null);
		(window as any).xpos = {};
		expect(siteDateLocale()).toBeUndefined();
		await primeSiteLocale();

		expect(await loadSiteLocale()).toEqual(siteLocaleFromBoot(MULE_BOOT));
		expect(formatSiteDate("2026-10-06")).toBe("10-06-2026");
		expect(formatLocalDate("2026-10-06")).toBe("10/6/2026");
		expect(getUserDateFormat()).toBe("MM-DD-YYYY");
		expect(getUserTimeZone()).toBe("America/New_York");
	});
});

describe("money offline", () => {
	it("formats with the site's number format from the restored boot", () => {
		(window as any).xpos = { boot: sanitizeBoot(MULE_BOOT as any) };
		expect(formatWithSymbol("USD", 1234.5)).toBe("$1,234.50");
	});

	it("follows a site whose number format differs from the browser's", () => {
		const boot = JSON.parse(JSON.stringify(MULE_BOOT));
		boot.sysdefaults.number_format = "#.###,##";
		(window as any).xpos = { boot: sanitizeBoot(boot) };
		resetNumberFormatSettings();
		expect(formatFor("USD", 1234.5)).toBe("1.234,50");
	});
});
