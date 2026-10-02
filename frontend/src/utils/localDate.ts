/**
 * Date-only values ("2026-10-01": posting_date, transaction_date, a delivery
 * day) read as a day on the till's own calendar (Mule City MuleCity-jh8j).
 *
 * Why: `new Date("2026-10-01")` is UTC midnight, which in US Eastern is the
 * evening of Sep 30, so a sale rung at 22:45 EDT on Oct 1 was listed as
 * "Sep 30". A date-only string is read as local midnight instead. Anything
 * with a time (a real datetime) is parsed by `new Date` as before.
 *
 * Kept free of imports so the receipt template and its tests can use it.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLocalDate(value: string | null | undefined): Date | null {
	const text = String(value ?? "").trim();
	if (!text) return null;
	const match = DATE_ONLY.exec(text);
	const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** `toLocaleDateString` of a date-only (or datetime) value; "" when unreadable. */
export function formatLocalDate(
	value: string | null | undefined,
	options?: Intl.DateTimeFormatOptions,
	locale?: string | string[],
): string {
	const date = parseLocalDate(value);
	return date ? date.toLocaleDateString(locale, options) : "";
}
