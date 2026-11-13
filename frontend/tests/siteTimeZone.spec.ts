// The device runs in UTC while the site is in US Eastern: times must follow the site.
process.env.TZ = "UTC";

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatInstant, getSiteDateLocale } from "@/utils/datetime";
import { buildReceiptHtml } from "@/services/receiptTemplate";
import { resetCurrencyCache } from "@/composables/useCurrency";
import type { ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";

vi.mock("@/services/dbBridge", () => ({
	getCachedCurrencyMeta: vi.fn().mockResolvedValue([]),
}));

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
};

function setBoot(boot: Record<string, unknown>) {
	(window as any).xpos = {
		boot: { currencies: [{ name: "USD", symbol: "$", number_format: "#,###.##" }], ...boot },
	};
	resetCurrencyCache();
}

afterEach(() => {
	delete (window as any).xpos;
});

describe("formatInstant", () => {
	it("shows an instant in the site's time zone, not the device's", () => {
		setBoot({ time_zone: { system: "America/New_York", user: "America/New_York" } });
		// 19:30 UTC is 15:30 in New York (EDT).
		expect(formatInstant("2026-10-06T19:30:00Z", TIME, "time")).toMatch(/3:30/);
		expect(formatInstant(Date.UTC(2026, 9, 6, 19, 30), TIME, "time")).toMatch(/3:30/);
	});

	it("reads a server datetime without an offset as the site's wall time", () => {
		setBoot({ time_zone: { system: "America/New_York", user: "America/New_York" } });
		expect(formatInstant("2026-10-06 15:03:00.123456", TIME, "time")).toMatch(/3:03/);
	});

	it("uses the site's day/month order", () => {
		setBoot({ sysdefaults: { date_format: "mm-dd-yyyy" }, time_zone: { system: "UTC" } });
		expect(getSiteDateLocale()).toBe("en-US");
		expect(formatInstant("2026-10-06T08:05:00Z", DATE_TIME)).toBe("10/06/2026, 08:05");

		setBoot({ sysdefaults: { date_format: "dd-mm-yyyy" }, time_zone: { system: "UTC" } });
		expect(getSiteDateLocale()).toBe("en-GB");
		expect(formatInstant("2026-10-06T08:05:00Z", DATE_TIME)).toBe("06/10/2026, 08:05");

		setBoot({ sysdefaults: { date_format: "yyyy-mm-dd" } });
		expect(getSiteDateLocale()).toBe("en-CA");
	});

	it("falls back to the device's zone and locale without a boot, and is empty when unreadable", () => {
		expect(getSiteDateLocale()).toBeUndefined();
		expect(formatInstant("2026-10-06T19:30:00Z", { hour: "2-digit", minute: "2-digit", hour12: false }, "time")).toBe(
			"19:30",
		);
		expect(formatInstant("", TIME)).toBe("");
		expect(formatInstant(null, TIME)).toBe("");
		expect(formatInstant("not a date", TIME)).toBe("");
	});
});

const context: ReceiptContext = {
	company_name: "Acme Store",
	company_phone: "",
	company_email: "",
	company_website: "",
	company_address: "",
	company_tax_id: "",
	company_logo: "",
	receipt_header: "",
	receipt_footer: "",
	currency: "USD",
	print_discount_amount: 0,
	print_format: "XPOS Thermal Receipt",
	css: "",
};

const snapshot = {
	name: "LOCAL-1",
	posting_date: "2026-10-06",
	posting_time: "15:03:00.123456",
	is_return: false,
	cashier: "Cashier",
	customer_name: "Walk-in Customer",
	items: [],
	taxes: [],
	payments: [],
	subtotal: 0,
	total_discount: 0,
	net_total: 0,
	grand_total: 0,
	total_qty: 0,
	change: 0,
} as unknown as ReceiptSnapshot;

describe("offline receipt date and time", () => {
	it("prints in the site's date and time format", () => {
		setBoot({ sysdefaults: { date_format: "mm-dd-yyyy", time_format: "HH:mm:ss" } });
		const html = buildReceiptHtml(snapshot, context);
		expect(html).toContain("10-06-2026 15:03:00");
	});

	it("honours a 12-hour site time format", () => {
		setBoot({ sysdefaults: { date_format: "dd.mm.yyyy", time_format: "hh:mm a" } });
		const html = buildReceiptHtml(snapshot, context);
		expect(html).toContain("06.10.2026 03:03 PM");
	});

	it("keeps dd-mm-yyyy and hh:mm AM/PM when the boot carries no format", () => {
		setBoot({});
		const html = buildReceiptHtml(snapshot, context);
		expect(html).toContain("06-10-2026 03:03 PM");
	});
});
