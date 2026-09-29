/**
 * Bill (2026-09-29, MuleCity-nfxn.4): "Pay on account" is one of the payment
 * options at Pay. It charges the ticket to a named customer's account (XPOS's
 * credit sale) and is offered only when that can be checked against their
 * credit limit: online, on a sale, for a named customer.
 */
import { describe, expect, it } from "vitest";
import { canChargeToAccount, ON_ACCOUNT } from "@/utils/onAccount";

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
