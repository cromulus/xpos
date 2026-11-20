/**
 * User story (Bill 2026-11-19, MuleCity-zegl): "we should be recording the check number, and
 * the customer (can't take a check for a walk in customer)". A check at the till needs the
 * number printed on it (digits only) and a named customer; the refund check written for a
 * return needs its number too.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/translate", () => ({ default: (text: string) => text }));

import { checkCustomerProblem, checkNumberProblem, cleanCheckNumber, WALK_IN_CHECK_MESSAGE } from "@/utils/checkTender";
import { withCheckNumber } from "@/utils/refundMethod";
import { isWalkInCustomer } from "@/services/delivery";

describe("a check taken at the till", () => {
	it("takes the number printed on the check, spaces dropped", () => {
		expect(cleanCheckNumber(" 10 452 ")).toBe("10452");
		expect(checkNumberProblem("10452")).toBeNull();
		expect(withCheckNumber([{ mode_of_payment: "Check" }, { mode_of_payment: "Cash" }], " 10 452")).toEqual([
			{ mode_of_payment: "Check", reference_no: "10452" },
			{ mode_of_payment: "Cash" },
		]);
	});

	it("negative: refuses no number or one that is not digits", () => {
		expect(checkNumberProblem("")).toMatch(/Type the check number/);
		expect(checkNumberProblem("  ", true)).toMatch(/refund check/);
		expect(checkNumberProblem("12A")).toMatch(/digits only/);
	});

	it("negative: refuses a check from the walk-in account, takes one from a named customer", () => {
		const policy = { walk_in_customers: ["Walk-In Customer", "CASH 338"] };
		expect(checkCustomerProblem(isWalkInCustomer("CASH 338", policy, "Walk-In Customer"))).toBe(WALK_IN_CHECK_MESSAGE);
		expect(checkCustomerProblem(isWalkInCustomer("Walk-In Customer", null, "Walk-In Customer"))).toBe(WALK_IN_CHECK_MESSAGE);
		expect(checkCustomerProblem(isWalkInCustomer("C-1044", policy, "Walk-In Customer"))).toBeNull();
	});
});
