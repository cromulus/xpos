/**
 * Whether the cart shows a customer's balance and credit limit.
 *
 * Not for the profile's default customer (the walk-in account): everyone who
 * isn't a named customer is rung up as it, it never runs a balance, and a shop
 * may give it a tiny credit limit so it can't be charged (Mule City: $0.01).
 * The cart's "exceeds the credit limit" warning counts the cart as owed before
 * payment, so on that account it would warn on every cash sale.
 */
export function showsCreditInfo(opts: {
	showCustomerBalance: boolean;
	isReturnMode: boolean;
	isDefaultCustomer: boolean;
	balance: number;
	creditLimit: number;
}): boolean {
	if (!opts.showCustomerBalance || opts.isReturnMode || opts.isDefaultCustomer) return false;
	return opts.balance > 0 || opts.creditLimit > 0;
}
