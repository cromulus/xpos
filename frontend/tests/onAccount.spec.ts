/**
 * Bill (2026-09-29, MuleCity-nfxn.4): "Pay on account" is one of the payment
 * options at Pay. It charges the ticket to a named customer's account (XPOS's
 * credit sale) and is offered only when that can be checked against their
 * credit limit: online, on a sale, for a named customer.
 */
import { describe, expect, it } from "vitest";
import { canChargeToAccount, canReceiveOnAccount, ON_ACCOUNT } from "@/utils/onAccount";

const base = {
	allowCreditSale: true,
	online: true,
	isReturnMode: false,
	customer: "MC-CUST-4085",
	defaultCustomer: "Walk-In Customer",
};

describe("the On Account tender", () => {
	it("is offered for a named customer's sale when the till is online", () => {
		expect(ON_ACCOUNT).toBe("On Account");
		expect(canChargeToAccount(base)).toBe(true);
	});

	it("is not offered to the walk-in account, offline, on a return, or when the profile forbids charges", () => {
		expect(canChargeToAccount({ ...base, customer: "Walk-In Customer" })).toBe(false);
		expect(canChargeToAccount({ ...base, online: false })).toBe(false);
		expect(canChargeToAccount({ ...base, isReturnMode: true })).toBe(false);
		expect(canChargeToAccount({ ...base, allowCreditSale: false })).toBe(false);
		expect(canChargeToAccount({ ...base, customer: null })).toBe(false);
	});
});

/**
 * Bill (2026-09-29, MuleCity-nfxn.3): "Receive on Account should be a payment
 * option!" It sits at Pay next to the tenders, and the empty cart's Pay button
 * becomes "Receive on Account", so a customer can pay down their balance with
 * nothing in the cart, as with the old button on the cart.
 */
describe("Receive on Account at Pay", () => {
	const account = { allowSettlement: true, online: true, isReturnMode: false, balance: 1250 };

	it("is offered when the customer owes and the till may settle online", () => {
		expect(canReceiveOnAccount(account)).toBe(true);
	});

	it("is not offered with nothing owed, offline, on a return, or without the settle right", () => {
		expect(canReceiveOnAccount({ ...account, balance: 0 })).toBe(false);
		expect(canReceiveOnAccount({ ...account, balance: -40 })).toBe(false);
		expect(canReceiveOnAccount({ ...account, online: false })).toBe(false);
		expect(canReceiveOnAccount({ ...account, isReturnMode: true })).toBe(false);
		expect(canReceiveOnAccount({ ...account, allowSettlement: false })).toBe(false);
	});
});
