/**
 * A line's money discount, between what the cashier sees and what the server posts.
 *
 * The cart keeps a line's ``discount_amount`` as the discount on the whole line
 * (type $10 on 4 bags and the line shows -$10). The server posts it per unit
 * (``xpos.api.invoices.create_invoice``: ``rate = price_list_rate -
 * discount_amount``, then ``amount = rate × qty`` to the cent), so the cart
 * divides by the quantity before posting and multiplies when it loads a line
 * back from the server or the offline queue.
 *
 * The per-unit figure keeps the invoice line's rate precision (9 places for
 * per-pound feed). Where the division does not come out even ($10 over 3
 * bags), the last place is chosen so the line the server posts comes to the
 * cent the cart showed.
 */

/** Round half away from zero at ``places``, as Frappe's Commercial Rounding does. */
function roundTo(value: number, places: number): number {
	const factor = 10 ** places;
	return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
}

/** Discount per unit = line discount / |qty|, as the server takes it. */
function share(lineDiscount: number, qty: number, precision: number): number {
	return roundTo(Math.abs(lineDiscount) / Math.abs(qty), precision);
}

/** What the server posts for the line (before sign): |qty| × its rounded rate, to the cent. */
function postedLine(units: number, rate: number, perUnit: number, precision: number): number {
	return units * roundTo(rate - perUnit, precision);
}

/**
 * The per-unit discount to post for a line whose discount the cashier sees as
 * ``lineDiscount`` on ``qty`` units at ``rate`` (the price list rate the line
 * posts). The posted line comes to the cent the screen shows: ``|qty| × rate
 * − lineDiscount`` rounded to 2 places.
 */
export function perUnitDiscount(lineDiscount: number, qty: number, rate: number, precision: number): number {
	const units = Math.abs(qty);
	if (!lineDiscount || !units) return 0;
	const first = share(lineDiscount, qty, precision);
	// The line total as the cart shows it (CartItem's lineTotal).
	const shown = Math.round((units * rate - Math.abs(lineDiscount) + Number.EPSILON) * 100) / 100;
	const step = 10 ** -precision;
	// Nudge the last place until the posted line sits inside the shown cent,
	// clear of its edges so no rounding convention can move it to the next one.
	for (let k = 0; k <= 1000; k++) {
		for (const candidate of k ? [first - k * step, first + k * step] : [first]) {
			const perUnit = roundTo(candidate, precision);
			if (Math.abs(postedLine(units, rate, perUnit, precision) - shown) < 0.005 - 1e-7) return perUnit;
		}
	}
	return first;
}

/** The discount on the whole line for a per-unit discount the server posted. */
export function lineDiscountFromPerUnit(perUnit: number, qty: number): number {
	return Math.abs(perUnit || 0) * Math.abs(qty || 0);
}
