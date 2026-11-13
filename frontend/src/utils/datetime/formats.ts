export const SYSTEM_DATE_FORMAT = "YYYY-MM-DD";
export const SYSTEM_TIME_FORMAT = "HH:mm:ss";
export const SYSTEM_DATETIME_FORMAT = `${SYSTEM_DATE_FORMAT} ${SYSTEM_TIME_FORMAT}`;

const DEFAULT_USER_DATE_FORMAT = SYSTEM_DATE_FORMAT;
const DEFAULT_USER_TIME_FORMAT = SYSTEM_TIME_FORMAT;

type BootSysDefaults = {
	date_format?: string;
	time_format?: string;
};

type BootTimeZones = {
	user?: string;
	system?: string;
};

function getBootSysDefaults(): BootSysDefaults {
	return (window.xpos?.boot as { sysdefaults?: BootSysDefaults } | undefined)?.sysdefaults || {};
}

function getBootTimeZones(): BootTimeZones {
	return (window.xpos?.boot as { time_zone?: BootTimeZones } | undefined)?.time_zone || {};
}

function normalizeDateFormat(format?: string): string {
	return (format || DEFAULT_USER_DATE_FORMAT)
		.replace(/yyyy/g, "YYYY")
		.replace(/yy/g, "YY")
		.replace(/dd/g, "DD")
		.replace(/mm/g, "MM");
}

function normalizeTimeFormat(format?: string): string {
	return (format || DEFAULT_USER_TIME_FORMAT).replace(/a/g, "A");
}

export function getUserDateFormat(): string {
	return normalizeDateFormat(getBootSysDefaults().date_format);
}

export function getUserTimeFormat(): string {
	return normalizeTimeFormat(getBootSysDefaults().time_format);
}

export function getUserDatetimeFormat(): string {
	return `${getUserDateFormat()} ${getUserTimeFormat()}`;
}

export function getUserTimeZone(): string | undefined {
	return getBootTimeZones().user;
}

export function getSystemTimeZone(): string | undefined {
	return getBootTimeZones().system;
}

/** The site's date format (dayjs tokens), or undefined when the boot carries none (e.g. Electron). */
export function getSiteDateFormat(): string | undefined {
	const format = getBootSysDefaults().date_format;
	return format ? normalizeDateFormat(format) : undefined;
}

/** The site's time format (dayjs tokens), or undefined when the boot carries none. */
export function getSiteTimeFormat(): string | undefined {
	const format = getBootSysDefaults().time_format;
	return format ? normalizeTimeFormat(format) : undefined;
}

/**
 * A BCP 47 locale whose day/month order matches the site's date format, for
 * `Intl`/`toLocale*String` calls: "en-US" when the month comes first
 * (mm-dd-yyyy), "en-GB" when the day does, "en-CA" (2026-10-06) when the year
 * does. Undefined, i.e. the browser's own locale, when the site sets no format.
 */
export function getSiteDateLocale(): string | undefined {
	const format = (getBootSysDefaults().date_format || "").toLowerCase();
	if (!format) return undefined;
	const first = ["y", "m", "d"]
		.filter((part) => format.includes(part))
		.sort((a, b) => format.indexOf(a) - format.indexOf(b))[0];
	if (first === "y") return "en-CA";
	if (first === "d") return "en-GB";
	return "en-US";
}
