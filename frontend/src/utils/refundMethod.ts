/**
 * How a return gives the money back (Mule City, Bill 2026-11-12, MuleCity-rj2o).
 *
 * At Pay on a return the cashier picks: a tender (cash, card, or a check written
 * at the counter: its number is asked for), "Credit on account" (nothing paid
 * out; the customer spends the credit later), or "Mail a check" (nothing paid
 * out; the accountant is asked to mail the check). The last two need a named
 * customer and the internet: they post a credit note on the customer's account.
 * The site holds the same rules (xpos.api.invoices.apply_refund_method).
 */
export const REFUND_ON_ACCOUNT = "Credit on account";
export const REFUND_MAIL_CHECK = "Mail a check";
export const REFUND_PAID_OUT = "Paid out";
export const ACCOUNT_REFUNDS = [REFUND_ON_ACCOUNT, REFUND_MAIL_CHECK] as const;

export function isAccountRefund(method: string | null | undefined): boolean {
	return (ACCOUNT_REFUNDS as readonly string[]).includes(method || "");
}

/** A paper check, by the Mode of Payment's name (the tender icons use the same test). */
export function isCheckMode(mode: string | null | undefined): boolean {
	const name = (mode || "").toLowerCase();
	return name.includes("check") || name.includes("cheque");
}

export function canRefundToAccount(opts: {
	isReturnMode: boolean;
	online: boolean;
	customer: string | undefined | null;
	defaultCustomer: string | undefined | null;
}): boolean {
	if (!opts.isReturnMode || !opts.online || !opts.customer) return false;
	return !opts.defaultCustomer || opts.customer !== opts.defaultCustomer;
}

/** Each check row carries the check's number (``reference_no``). */
export function withCheckNumber<T extends { mode_of_payment: string }>(
	payments: T[],
	checkNumber: string,
): (T & { reference_no?: string })[] {
	const number = checkNumber.trim();
	if (!number) return payments;
	return payments.map((row) => (isCheckMode(row.mode_of_payment) ? { ...row, reference_no: number } : row));
}
