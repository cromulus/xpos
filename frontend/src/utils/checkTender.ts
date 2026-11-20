/**
 * A paper check at the counter (Mule City, Bill 2026-11-19, MuleCity-zegl).
 *
 * "We should be recording the check number, and the customer (can't take a
 * check for a walk in customer)": every check taken at the till carries the
 * number printed on it, and a check is never taken from the walk-in account.
 * The close lists each check (number, customer, amount) so the cashier can
 * tick the paper checks off and type their total in Closing.
 *
 * The site refuses the same things (its own validate hooks), so an
 * old till or an offline sale that slipped past here is still stopped; these
 * checks only give the cashier the reason before anything is sent.
 */
import __ from "@/lib/translate";
import { isCheckMode } from "@/utils/refundMethod";

export { isCheckMode };

/** The number as typed, without spaces ("10 452" -> "10452"). */
export function cleanCheckNumber(value: string | null | undefined): string {
	return (value || "").replace(/\s+/g, "");
}

/** Why the typed check number cannot be saved, or null when it can. */
export function checkNumberProblem(value: string | null | undefined, refund = false): string | null {
	const number = cleanCheckNumber(value);
	if (!number) {
		return refund
			? __("Write the number of the refund check before saving the return.")
			: __("Type the check number (printed on the check) before saving.");
	}
	if (!/^[0-9]+$/.test(number)) {
		return __("The check number is the number printed on the check: digits only.");
	}
	return null;
}

export const WALK_IN_CHECK_MESSAGE = "Checks need a named customer: pick the customer first.";

/** A check taken from the walk-in account is refused (``walkIn``: no customer or a walk-in one). */
export function checkCustomerProblem(walkIn: boolean): string | null {
	return walkIn ? __(WALK_IN_CHECK_MESSAGE) : null;
}
