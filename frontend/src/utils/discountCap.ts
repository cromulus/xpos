/**
 * The counter's discount cap, as the cart checks it while a discount is typed.
 *
 * The POS Profile's ``max_discount_percentage_allowed`` limits how much a
 * cashier may take off a ticket. The server refuses a sale over it at Pay
 * (``xpos.api.invoices.check_discount_cap``); these functions mirror that check
 * so the cart can stop the value as it is typed instead:
 *
 * - the ticket is measured from each line's rate after Pricing Rules
 *   (``ruleRate``), so a Pricing Rule's own discount does not count;
 * - line discounts and the additional (whole-ticket) discount count together;
 * - a line's ``discount_amount`` is taken per unit, as the server posts it
 *   (``rate = price_list_rate - discount_amount``);
 * - free items are left out (the caller filters them), quantities count as
 *   absolute values.
 *
 * All functions are pure; the cart store supplies the lines and decides whether
 * the cap applies at all (returns and users who may change the price are not
 * capped).
 */

/** One capped cart line, in the terms the server check uses. */
export interface CapLine {
	qty: number;
	/** The line's price list rate as the cart holds it (before any line discount). */
	rate: number;
	/** The rate after Pricing Rules, before any counter discount. */
	ruleRate: number;
	discountPercentage: number;
	/** Per-unit discount amount (used when no percentage is set). */
	discountAmount: number;
}

/** The additional (whole-ticket) discount: a percentage, else an amount. */
export interface AdditionalDiscount {
	percentage: number;
	amount: number;
}

export type DiscountKind = "percentage" | "amount";

/** What a line charges per unit after its own discount. */
function netUnitRate(line: CapLine): number {
	if (line.discountPercentage) return line.rate * (1 - line.discountPercentage / 100);
	return line.rate - (line.discountAmount || 0);
}

/** The ticket before counter discounts: each line at its post-rule rate. */
function ticketBefore(lines: CapLine[]): number {
	return lines.reduce((sum, line) => sum + Math.abs(line.qty) * line.ruleRate, 0);
}

/** What the lines charge after their own discounts, before the additional discount. */
function linesCharged(lines: CapLine[]): number {
	return lines.reduce((sum, line) => sum + Math.abs(line.qty) * netUnitRate(line), 0);
}

/** Round down to 2 places, so a value at the cap never reads as over it. */
function floor2(value: number): number {
	return Math.floor(value * 100 + 1e-9) / 100;
}

/** The lowest amount the ticket may charge, or null when there is nothing to cap. */
function ticketFloor(lines: CapLine[], capPercent: number): number | null {
	const before = ticketBefore(lines);
	if (capPercent <= 0 || before <= 0) return null;
	return before * (1 - capPercent / 100);
}

/**
 * The largest discount line ``index`` may take, in ``kind`` terms (percent, or
 * per-unit amount), with the other lines and the additional discount as they
 * are. Null when the ticket has nothing to cap.
 */
export function maxLineDiscount(
	lines: CapLine[],
	index: number,
	kind: DiscountKind,
	additional: AdditionalDiscount,
	capPercent: number,
): number | null {
	const floor = ticketFloor(lines, capPercent);
	const line = lines[index];
	if (floor === null || !line) return null;
	const units = Math.abs(line.qty);
	const gross = units * line.rate;
	if (units <= 0 || gross <= 0) return null;

	const others = linesCharged(lines.filter((_, i) => i !== index));
	// The least this line may charge so the whole ticket stays at the floor.
	const lineFloor = additional.percentage
		? floor / (1 - additional.percentage / 100) - others
		: floor + Math.abs(additional.amount || 0) - others;

	const allowed =
		kind === "percentage" ? (1 - lineFloor / gross) * 100 : (gross - lineFloor) / units;
	const ceiling = kind === "percentage" ? 100 : line.rate;
	return floor2(Math.min(Math.max(allowed, 0), ceiling));
}

/**
 * The largest additional (whole-ticket) discount, in ``kind`` terms, with the
 * line discounts as they are. Null when the ticket has nothing to cap.
 */
export function maxAdditionalDiscount(
	lines: CapLine[],
	kind: DiscountKind,
	capPercent: number,
): number | null {
	const floor = ticketFloor(lines, capPercent);
	if (floor === null) return null;
	const charged = linesCharged(lines);
	if (charged <= 0) return 0;
	const allowed = kind === "percentage" ? (1 - floor / charged) * 100 : charged - floor;
	return floor2(Math.max(allowed, 0));
}
