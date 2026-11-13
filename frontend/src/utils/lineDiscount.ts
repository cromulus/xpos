/**
 * A line's money discount, between what the cashier sees and what the server posts.
 *
 * The cart keeps a line's `discount_amount` as the discount on the whole line: type $10
 * on 4 units and the line shows -$10 (CartItem's lineTotal, the cart subtotal and taxes
 * all read it that way). `xpos.api.invoices.create_invoice` takes a line's
 * `discount_amount` per unit (`rate = price_list_rate - discount_amount`, then ERPNext's
 * `amount = rate × qty`), so the cart divides by the quantity before posting and
 * multiplies when it loads a line back from the server or the offline queue.
 *
 * create_invoice keeps the per-unit discount to the cent. Where the division does not
 * come out even ($5 over 3 units), the cent is chosen so the posted line comes as close
 * as it can to the total the cart showed; it can differ from it by less than
 * |qty| × half a cent.
 */

/** Decimals create_invoice keeps for a line's per-unit discount_amount. */
export const POSTED_DISCOUNT_PRECISION = 2;

/** Round half away from zero at `places`, as Frappe's flt does. */
function roundTo(value: number, places: number): number {
	const factor = 10 ** places;
	// toFixed drops binary noise first, so 1.005 × 100 rounds to 101, not 100.
	return (Math.sign(value) * Math.round(Number((Math.abs(value) * factor).toFixed(6)))) / factor;
}

/**
 * The per-unit discount to post for a line whose discount the cashier sees as
 * `lineDiscount` on `qty` units at `rate` (the price list rate the line posts, kept to
 * `ratePrecision` places). Of the per-unit values nearest `lineDiscount / |qty|`, the
 * one whose posted line (`|qty| × round(rate − perUnit)`) lands closest to the line
 * total the cart shows (`|qty| × rate − lineDiscount`, to the cent).
 */
export function perUnitDiscount(
	lineDiscount: number,
	qty: number,
	rate: number,
	ratePrecision: number,
	discountPrecision: number = POSTED_DISCOUNT_PRECISION,
): number {
	const units = Math.abs(qty || 0);
	const discount = Math.abs(lineDiscount || 0);
	if (!discount || !units) return 0;
	const first = roundTo(discount / units, discountPrecision);
	const shown = roundTo(units * rate - discount, 2);
	const step = 10 ** -discountPrecision;
	let best = first;
	let bestError = Infinity;
	for (const candidate of [first, first - step, first + step]) {
		const perUnit = roundTo(candidate, discountPrecision);
		if (perUnit < 0) continue;
		const posted = units * roundTo(rate - perUnit, ratePrecision);
		const error = Math.abs(roundTo(posted, 2) - shown);
		if (error < bestError - 1e-9) {
			best = perUnit;
			bestError = error;
		}
	}
	return best;
}

/** The discount on the whole line for a per-unit discount the server posted. */
export function lineDiscountFromPerUnit(perUnit: number | null | undefined, qty: number | null | undefined): number {
	return roundTo(Math.abs(perUnit || 0) * Math.abs(qty || 0), 9);
}
