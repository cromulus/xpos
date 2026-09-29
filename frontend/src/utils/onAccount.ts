/**
 * "On Account" at Pay (Mule City, Bill 2026-09-29): ring the ticket as a charge
 * to the customer's account (XPOS's credit sale), within their credit limit,
 * which ERPNext checks when the ticket is saved.
 *
 * Offered only when the profile allows credit sales, the till is online (the
 * limit can't be checked offline), it is a sale (not a return), and a named
 * customer is chosen (the walk-in account can't be charged).
 */
export const ON_ACCOUNT = "On Account";

export function canChargeToAccount(opts: {
	allowCreditSale: boolean;
	online: boolean;
	isReturnMode: boolean;
	customer: string | undefined | null;
	defaultCustomer: string | undefined | null;
}): boolean {
	if (!opts.allowCreditSale || !opts.online || opts.isReturnMode || !opts.customer) return false;
	return !opts.defaultCustomer || opts.customer !== opts.defaultCustomer;
}
