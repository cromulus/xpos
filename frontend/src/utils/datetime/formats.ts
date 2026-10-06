import { siteLocale } from "@/utils/siteLocale";

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

/** The boot's sysdefaults, else the site's saved locale (the desktop app offline, MuleCity-mon6). */
function getBootSysDefaults(): BootSysDefaults {
	const boot = (window.xpos?.boot as { sysdefaults?: BootSysDefaults } | undefined)?.sysdefaults;
	if (boot?.date_format) return boot;
	const saved = siteLocale();
	return saved ? { date_format: saved.date_format, time_format: saved.time_format } : boot || {};
}

function getBootTimeZones(): BootTimeZones {
	const zones = (window.xpos?.boot as { time_zone?: BootTimeZones } | undefined)?.time_zone;
	if (zones?.system || zones?.user) return zones;
	const zone = siteLocale()?.time_zone;
	return zone ? { system: zone, user: zone } : {};
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
