/**
 * Clear the customer and the basket (Mule City, Bill 2026-10-01, MuleCity-zstm.22).
 *
 * One control at the customer's name puts the till back to the register's
 * walk-in customer with an empty basket, no discounts and no delivery. It is
 * a different act from the trash button, which empties the basket but keeps
 * the customer. Pure client state, so it works offline.
 */

export interface ClearCustomerState {
	/** The chosen customer's ID, if any. */
	customer: string | null | undefined;
	/** The POS Profile's default (walk-in) customer, "" when none. */
	defaultCustomer: string | null | undefined;
	isEmpty: boolean;
	isReturnMode: boolean;
}

/** Whether there is anything to clear: a basket, or a customer other than walk-in. Never in return mode. */
export function canClearCustomer(state: ClearCustomerState): boolean {
	if (state.isReturnMode) return false;
	if (!state.isEmpty) return true;
	return !!state.customer && state.customer !== (state.defaultCustomer || "");
}

/** Clearing a basket with lines in it asks first; a customer alone is cleared at once. */
export function clearNeedsConfirm(state: ClearCustomerState): boolean {
	return !state.isEmpty;
}
