/**
 * User story (Mule City, 2026-09-29): Walk-In Customer has a $0.01 credit limit
 * so it can't be charged. Leslie rings up walk-in cash sales all day; the cart
 * must not warn "This sale exceeds the credit limit" on every one of them. A
 * named customer still shows their balance and limit.
 */
import { describe, expect, it } from "vitest";
import { showsCreditInfo } from "@/utils/creditPanel";

const base = { showCustomerBalance: true, isReturnMode: false, isDefaultCustomer: false, balance: 0, creditLimit: 0 };

describe("the cart's balance and credit panel", () => {
	it("is hidden for the walk-in (profile default) customer, whatever its limit", () => {
		expect(showsCreditInfo({ ...base, isDefaultCustomer: true, creditLimit: 0.01 })).toBe(false);
	});

	it("shows for a named customer with a balance or a limit", () => {
		expect(showsCreditInfo({ ...base, balance: 120 })).toBe(true);
		expect(showsCreditInfo({ ...base, creditLimit: 3500 })).toBe(true);
	});

	it("stays hidden when the profile doesn't show balances, in returns, or with nothing to show", () => {
		expect(showsCreditInfo({ ...base, showCustomerBalance: false, balance: 120 })).toBe(false);
		expect(showsCreditInfo({ ...base, isReturnMode: true, balance: 120 })).toBe(false);
		expect(showsCreditInfo(base)).toBe(false);
	});
});
