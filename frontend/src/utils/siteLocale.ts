/**
 * The site's own date, time, number and currency settings, for every print and screen,
 * online or offline (Mule City MuleCity-mon6).
 *
 * Why: the offline receipt printed "06-10-2026" for October 6 (a hard-coded day-month), and
 * a few screens used the browser's locale. Bill 2026-10-06: every offline print and screen
 * formats dates and numbers with the site's format, never the browser default; Mule's dates
 * are mm-dd-yyyy.
 *
 * Where it comes from: the boot's sysdefaults (date_format, time_format, number_format,
 * currency, currency_precision, float_precision) and time_zone. The web till's offline start
 * restores the saved boot (q8aq), which carries them. The desktop app has no boot: each
 * online start saves the same seven values, and nothing else, from get_receipt_context under
 * the "site_locale" meta key, so its offline cold start formats as the site does too.
 */

export const SITE_LOCALE_KEY = "site_locale";

export interface SiteLocale {
	date_format: string;
	time_format: string;
	number_format: string;
	currency: string;
	currency_precision: string;
	float_precision: string;
	time_zone: string;
}

type BootLike = {
	sysdefaults?: Record<string, unknown>;
	time_zone?: { system?: string; user?: string } | string;
};

let primed: SiteLocale | null = null;

function text(value: unknown): string {
	return value === null || value === undefined ? "" : String(value).trim();
}

/** The seven locale values of a boot (a whitelist: no other key is ever kept), or null. */
export function siteLocaleFromBoot(boot: BootLike | null | undefined): SiteLocale | null {
	const sys = boot?.sysdefaults;
	if (!sys || typeof sys !== "object") return null;
	const zone = boot?.time_zone;
	const timeZone =
		typeof zone === "string" ? zone : text(zone?.system) || text(zone?.user) || text(sys.time_zone);
	return {
		date_format: text(sys.date_format),
		time_format: text(sys.time_format),
		number_format: text(sys.number_format),
		currency: text(sys.currency),
		currency_precision: text(sys.currency_precision),
		float_precision: text(sys.float_precision),
		time_zone: timeZone,
	};
}

/** Keep only the seven known keys of a stored record. */
export function normalizeSiteLocale(value: unknown): SiteLocale | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	return {
		date_format: text(v.date_format),
		time_format: text(v.time_format),
		number_format: text(v.number_format),
		currency: text(v.currency),
		currency_precision: text(v.currency_precision),
		float_precision: text(v.float_precision),
		time_zone: text(v.time_zone),
	};
}

/** Put a locale in place for this page (tests, and the startup prime). */
export function setSiteLocale(locale: SiteLocale | null): void {
	primed = locale;
}

/** The site's locale: the live boot's, else the one saved by the last online start. */
export function siteLocale(): SiteLocale | null {
	const live = siteLocaleFromBoot((window as { xpos?: { boot?: BootLike } }).xpos?.boot);
	if (live && live.date_format) return live;
	return primed;
}

/** The site's date format, Frappe style ("mm-dd-yyyy"); "" when unknown. */
export function siteDateFormat(): string {
	return siteLocale()?.date_format || "";
}

/** The site's time zone ("America/New_York"), or undefined when unknown. */
export function siteTimeZone(): string | undefined {
	return siteLocale()?.time_zone || undefined;
}

/**
 * A BCP 47 locale whose day/month order matches the site's date format, for the screens'
 * `toLocale*String` calls: "en-US" for month-first (mm-dd-yyyy, mm/dd/yyyy), "en-GB" for
 * day-first, "en-CA" (2026-10-06) for year-first. Undefined when the site's format is unknown.
 */
export function siteDateLocale(): string | undefined {
	const format = siteDateFormat().toLowerCase();
	if (!format) return undefined;
	const order = ["y", "m", "d"].sort((a, b) => format.indexOf(a) - format.indexOf(b)).join("");
	if (order.startsWith("y")) return "en-CA";
	if (order.startsWith("d")) return "en-GB";
	return "en-US";
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A date in the site's format, as Frappe's formatDate prints it: "2026-10-06" with
 * "mm-dd-yyyy" is "10-06-2026". With no format known, the ISO date itself (never a guess
 * at day-month order).
 */
export function formatSiteDate(value: string | null | undefined, format: string = siteDateFormat()): string {
	const match = DATE_ONLY.exec(String(value ?? "").trim());
	if (!match) return String(value ?? "");
	const [, yyyy, mm, dd] = match;
	if (!format) return `${yyyy}-${mm}-${dd}`;
	return format
		.replace(/yyyy/gi, yyyy)
		.replace(/mm/gi, mm)
		.replace(/dd/gi, dd);
}

/**
 * A time ("15:03:00.123456") in the site's time format: "HH:mm:ss" (Frappe's default and
 * what the Ticket prints) or "HH:mm"; a 12-hour format ("hh:mm a") prints "03:03 PM".
 */
export function formatSiteTime(value: string | null | undefined, format: string = siteLocale()?.time_format || ""): string {
	const parts = String(value ?? "").split(".")[0].split(":");
	if (parts.length < 2) return String(value ?? "");
	const [h, m, s = "00"] = parts;
	const hour = Number(h);
	const fmt = format || "HH:mm:ss";
	const twelve = /h/.test(fmt) && !/H/.test(fmt);
	const hh = twelve ? String(hour % 12 || 12).padStart(2, "0") : String(hour).padStart(2, "0");
	let out = fmt.replace(/HH|hh/, hh).replace(/mm/, m.padStart(2, "0")).replace(/ss/, s.padStart(2, "0"));
	if (twelve) out = out.replace(/\s*[aA]$/, "") + (hour >= 12 ? " PM" : " AM");
	return out;
}

/** Save the boot's locale for the next offline start. Best-effort. */
export async function saveSiteLocale(locale: SiteLocale | null): Promise<void> {
	if (!locale || !locale.date_format) return;
	primed = locale;
	const { setSyncMeta } = await import("@/services/dbBridge");
	await setSyncMeta(SITE_LOCALE_KEY, JSON.stringify(locale));
}

/** Load the locale saved by the last online start. */
export async function loadSiteLocale(): Promise<SiteLocale | null> {
	const { getSyncMeta } = await import("@/services/dbBridge");
	const raw = await getSyncMeta(SITE_LOCALE_KEY);
	if (!raw) return null;
	try {
		return normalizeSiteLocale(typeof raw === "string" ? JSON.parse(raw) : raw);
	} catch {
		return null;
	}
}

/**
 * At startup. The web till always has a boot: the server's online, the saved offline_boot
 * (q8aq, secrets stripped, sysdefaults kept) offline, so its locale is read live. The
 * desktop app has none: put the locale saved by its last online start in place
 * (refreshReceiptContext saves it from get_receipt_context).
 */
export async function primeSiteLocale(): Promise<void> {
	const live = siteLocaleFromBoot((window as { xpos?: { boot?: BootLike } }).xpos?.boot);
	if (live && live.date_format) {
		primed = live;
		return;
	}
	primed = (await loadSiteLocale()) || primed;
}

/**
 * An instant (a Date, epoch ms or ISO datetime) in the site's day/month order and time zone,
 * for the screens that showed the browser's (MuleCity-mon6). `toLocaleString` options as
 * usual; an unknown time zone falls back to the device's. "" when unreadable.
 */
export function formatSiteInstant(
	value: Date | number | string | null | undefined,
	options: Intl.DateTimeFormatOptions,
	kind: "datetime" | "date" | "time" = "datetime",
): string {
	if (value === null || value === undefined || value === "") return "";
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const locale = siteDateLocale();
	const zone = siteTimeZone();
	const render = (opts: Intl.DateTimeFormatOptions) =>
		kind === "date"
			? date.toLocaleDateString(locale, opts)
			: kind === "time"
				? date.toLocaleTimeString(locale, opts)
				: date.toLocaleString(locale, opts);
	try {
		return render(zone ? { ...options, timeZone: zone } : options);
	} catch {
		return render(options);
	}
}
