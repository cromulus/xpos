import {
	getSiteDateLocale,
	getSystemTimeZone,
	getUserDateFormat,
	getUserDatetimeFormat,
	getUserTimeFormat,
	getUserTimeZone,
	SYSTEM_DATE_FORMAT,
	SYSTEM_DATETIME_FORMAT,
	SYSTEM_TIME_FORMAT,
} from "./formats";
import { dayjs, type DayjsInput, type DayjsInstance } from "./dayjs";
import { OpUnitType } from "dayjs";

function isMissingValue(value: DayjsInput | undefined | null): boolean {
	return value === undefined || value === null || value === "";
}

function parseValue(value: DayjsInput | undefined | null): DayjsInstance | null {
	if (isMissingValue(value)) {
		return null;
	}

	const parsed = dayjs(value);
	return parsed.isValid() ? parsed : null;
}

function formatOrFallback(value: DayjsInstance | null, format: string, fallback = ""): string {
	return value?.isValid() ? value.format(format) : fallback;
}

function nowInConfiguredTimeZone(useSystemTime = false): DayjsInstance {
	const timeZone = useSystemTime ? getSystemTimeZone() : getUserTimeZone() || getSystemTimeZone();
	return timeZone ? dayjs().tz(timeZone) : dayjs();
}

export { dayjs } from "./dayjs";
export {
	getSiteDateFormat,
	getSiteDateLocale,
	getSiteTimeFormat,
	getSystemTimeZone,
	getUserDateFormat,
	getUserDatetimeFormat,
	getUserTimeFormat,
	getUserTimeZone,
	SYSTEM_DATE_FORMAT,
	SYSTEM_DATETIME_FORMAT,
	SYSTEM_TIME_FORMAT,
} from "./formats";
export type { DayjsInput, DayjsInstance } from "./dayjs";

export function nowDate(): string {
	return nowInConfiguredTimeZone().format(SYSTEM_DATE_FORMAT);
}

export function nowTime(): string {
	return nowInConfiguredTimeZone().format(SYSTEM_TIME_FORMAT);
}

export function nowDatetime(): string {
	return nowInConfiguredTimeZone().format(SYSTEM_DATETIME_FORMAT);
}

export function toDate(value: DayjsInput | undefined | null, fallback = ""): string {
	return formatOrFallback(parseValue(value), SYSTEM_DATE_FORMAT, fallback);
}

export function toDateOrNow(value: DayjsInput | undefined | null): string {
	return toDate(value, nowDate());
}

export function toTime(value: DayjsInput | undefined | null, fallback = ""): string {
	return formatOrFallback(parseValue(value), SYSTEM_TIME_FORMAT, fallback);
}

export function toDatetime(value: DayjsInput | undefined | null, fallback = ""): string {
	return formatOrFallback(parseValue(value), SYSTEM_DATETIME_FORMAT, fallback);
}

export function toDatetimeOrNow(value: DayjsInput | undefined | null): string {
	return toDatetime(value, nowDatetime());
}

export function formatDate(value: DayjsInput | undefined | null, format = getUserDateFormat()): string {
	return formatOrFallback(parseValue(value), format);
}

export function formatTime(value: DayjsInput | undefined | null, format = getUserTimeFormat()): string {
	return formatOrFallback(parseValue(value), format);
}

export function formatDatetime(
	value: DayjsInput | undefined | null,
	format = getUserDatetimeFormat(),
): string {
	return formatOrFallback(parseValue(value), format);
}

export function convertToUserTz(
	value: DayjsInput | undefined | null,
	format = SYSTEM_DATETIME_FORMAT,
): string {
	if (isMissingValue(value)) {
		return "";
	}

	const systemTimeZone = getSystemTimeZone();
	const userTimeZone = getUserTimeZone();

	if (!systemTimeZone || !userTimeZone) {
		return toDatetime(value, "");
	}

	const dateValue = String(value);
	const parsed = dayjs.tz(dateValue, SYSTEM_DATETIME_FORMAT, systemTimeZone).tz(userTimeZone);
	return formatOrFallback(parsed, format);
}

export function convertToSystemTz(
	value: DayjsInput | undefined | null,
	format = SYSTEM_DATETIME_FORMAT,
): string {
	if (isMissingValue(value)) {
		return "";
	}

	const systemTimeZone = getSystemTimeZone();
	const userTimeZone = getUserTimeZone();

	if (!systemTimeZone || !userTimeZone) {
		return toDatetime(value, "");
	}

	const dateValue = String(value);
	const parsed = dayjs.tz(dateValue, getUserDatetimeFormat(), userTimeZone).tz(systemTimeZone);
	return formatOrFallback(parsed, format);
}

export function userToDate(value: string, fallback = ""): string {
	if (!value) {
		return fallback;
	}

	const userDateFormat = getUserDateFormat();
	const parsed = dayjs(value, [userDateFormat.replace("YYYY", "YY"), userDateFormat], true);
	return formatOrFallback(parsed, SYSTEM_DATE_FORMAT, fallback);
}

export function userToDatetime(value: string, fallback = ""): string {
	if (!value) {
		return fallback;
	}

	const userDatetimeFormat = getUserDatetimeFormat();
	const parsed = dayjs(value, [userDatetimeFormat.replace("YYYY", "YY"), userDatetimeFormat], true);
	return formatOrFallback(parsed, SYSTEM_DATETIME_FORMAT, fallback);
}

export function getDiff(value1: DayjsInput, value2: DayjsInput, unit: OpUnitType = "day"): number {
	return dayjs(value1).diff(value2, unit);
}

export function getDayDiff(value1: DayjsInput, value2: DayjsInput): number {
	return getDiff(value1, value2, "day");
}

export function getHourDiff(value1: DayjsInput, value2: DayjsInput): number {
	return getDiff(value1, value2, "hour");
}

export function getMinuteDiff(value1: DayjsInput, value2: DayjsInput): number {
	return getDiff(value1, value2, "minute");
}

export function addDays(value: DayjsInput, days: number): string {
	return dayjs(value).add(days, "day").format(SYSTEM_DATE_FORMAT);
}

export function addMonths(value: DayjsInput, months: number): string {
	return dayjs(value).add(months, "month").format(SYSTEM_DATE_FORMAT);
}

export function weekStart(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).startOf("week").format(SYSTEM_DATE_FORMAT);
}

export function weekEnd(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).endOf("week").format(SYSTEM_DATE_FORMAT);
}

export function monthStart(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).startOf("month").format(SYSTEM_DATE_FORMAT);
}

export function monthEnd(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).endOf("month").format(SYSTEM_DATE_FORMAT);
}

export function quarterStart(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).startOf("quarter").format(SYSTEM_DATE_FORMAT);
}

export function quarterEnd(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).endOf("quarter").format(SYSTEM_DATE_FORMAT);
}

export function yearStart(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).startOf("year").format(SYSTEM_DATE_FORMAT);
}

export function yearEnd(value?: DayjsInput): string {
	return (parseValue(value) || nowInConfiguredTimeZone()).endOf("year").format(SYSTEM_DATE_FORMAT);
}

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * An instant as a Date. A server datetime without an offset ("2026-10-06 15:03:00")
 * is wall time in the site's system time zone, so it is read there, not in the
 * device's zone; ISO strings with Z or an offset, epoch ms and Dates are taken as is.
 */
function toInstant(value: Date | number | string): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === "number") return new Date(value);
	const text = value.trim();
	const systemZone = getSystemTimeZone();
	if (systemZone && NAIVE_DATETIME.test(text)) {
		try {
			const parsed = dayjs.tz(text, systemZone);
			if (parsed.isValid()) return parsed.toDate();
		} catch {
			// An unknown zone: fall back to the device's.
		}
	}
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * An instant (a Date, epoch ms or datetime string) for display, in the site's
 * time zone (the user's, else the system's) and the site's day/month order,
 * rather than the browser's. Takes the usual `Intl.DateTimeFormat` options.
 * Without a configured zone or format, the device's are used. "" when unreadable.
 */
export function formatInstant(
	value: Date | number | string | null | undefined,
	options: Intl.DateTimeFormatOptions,
	kind: "datetime" | "date" | "time" = "datetime",
): string {
	if (value === null || value === undefined || value === "") return "";
	const date = toInstant(value);
	if (!date) return "";
	const locale = getSiteDateLocale();
	const timeZone = getUserTimeZone() || getSystemTimeZone();
	const render = (opts: Intl.DateTimeFormatOptions) =>
		kind === "date"
			? date.toLocaleDateString(locale, opts)
			: kind === "time"
				? date.toLocaleTimeString(locale, opts)
				: date.toLocaleString(locale, opts);
	try {
		return render(timeZone ? { ...options, timeZone } : options);
	} catch {
		return render(options);
	}
}
