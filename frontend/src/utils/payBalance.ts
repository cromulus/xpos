/**
 * "Pay balance" at the till (Bill 2026-11-05, MuleCity-biez): a customer pays
 * toward what they owe as a line in the cart, with the normal tenders, alone or
 * with today's goods. The site names the item and the checkout
 * (xpos.api.payments.get_pay_balance_settings, from its `xpos_pay_balance` hook);
 * the checkout posts the payment as Payment Entries against the customer's
 * account, never as a sale.
 */
export interface PayBalanceSettings {
	item_code: string;
	item_name?: string;
	/** The site method a cart holding the line is paid through. */
	checkout_method: string;
	/** The print format for a payment-only cart's receipt (a Payment Entry). */
	receipt_format?: string;
}

/** The site checkout's answer. */
export interface PayBalanceCheckoutResult {
	payments: { payment_entry: string; mode_of_payment: string; amount: number; unallocated_amount: number }[];
	paid_on_account: number;
	invoice: { name: string } | null;
	change_amount: number;
	balance_after: number;
	duplicate?: boolean;
}

/** Why Pay can't take this cart with the card reader, offline, or on account. */
export function payBalanceTenderRefusal(opts: { online: boolean; electron: boolean; onAccount: boolean }): string {
	if (!opts.online || opts.electron) return "A balance payment needs the till online. Take it when the connection is back.";
	if (opts.onAccount) return "A balance payment is paid now: it can't go on the customer's account.";
	return "";
}
