/** Cashier stories (MuleCity-1ptj): find a farm by the person on the account or by a phone number. */
import { describe, expect, it } from "vitest";
import { matchCustomer, rankCustomerMatches } from "@/utils/customerMatch";
import { isCalculation } from "@/utils/commandSearch";
import type { Customer } from "@/types/pos.types";

const sharp: Customer = {
	name: "MC-CUST-1001",
	customer_name: "Sharp Farms Inc",
	mule_filepro_alias_codes: "1001",
	mobile_no: "",
	xpos_cache_rank: 5,
	xpos_contacts: [
		{ name: "C-1", full_name: "Jane Sharp", phones: ["(919) 555-1234"], emails: ["jane@sharpfarms.test"], is_primary_contact: true },
		{ name: "C-2", full_name: "Rob Sharp", phones: ["919.555.8800"], emails: [], is_primary_contact: false },
	],
};
const janeFarm: Customer = { name: "MC-CUST-2002", customer_name: "Jane Hill Farm", xpos_cache_rank: 9 };
const ownMobile: Customer = { name: "MC-CUST-3003", customer_name: "Byrd Acres", mobile_no: "336-555-0042", xpos_cache_rank: 1 };
const exactJane: Customer = { name: "JANE", customer_name: "JANE", xpos_cache_rank: 20 };

describe("matching a customer", () => {
	it("finds the farm by a contact's name and says which contact", () => {
		expect(matchCustomer(sharp, "jane sharp")).toEqual({ tier: 2, via: "Jane Sharp" });
		expect(matchCustomer(sharp, "Rob")).toEqual({ tier: 2, via: "Rob Sharp" });
	});

	it("finds the farm by a contact's email", () => {
		expect(matchCustomer(sharp, "jane@sharp")).toEqual({ tier: 2, via: "Jane Sharp · jane@sharpfarms.test" });
	});

	it("finds a contact's phone however it is typed, digits only", () => {
		for (const typed of ["(919) 555-1234", "919-555-1234", "9195551234", "555-1234", "1234"]) {
			expect(matchCustomer(sharp, typed)).toEqual({ tier: 2, via: "Jane Sharp · (919) 555-1234" });
		}
		expect(matchCustomer(sharp, "8800")?.via).toBe("Rob Sharp · 919.555.8800");
	});

	it("finds the customer's own mobile and names the number", () => {
		expect(matchCustomer(ownMobile, "0042")).toEqual({ tier: 1, via: "336-555-0042" });
		expect(matchCustomer(ownMobile, "(336) 555 0042")).toEqual({ tier: 1, via: "336-555-0042" });
	});

	it("the primary contact's details copied onto the customer still name the contact", () => {
		const copied = { ...sharp, email_id: "jane@sharpfarms.test", mobile_no: "(919) 555-1234" };
		expect(matchCustomer(copied, "jane")).toEqual({ tier: 1, via: "Jane Sharp" });
		expect(matchCustomer(copied, "jane@sharp")).toEqual({ tier: 1, via: "Jane Sharp · jane@sharpfarms.test" });
		expect(matchCustomer(copied, "1234")).toEqual({ tier: 1, via: "Jane Sharp · (919) 555-1234" });
	});

	it("a farm-name match needs no 'via'", () => {
		expect(matchCustomer(sharp, "sharp farms")).toEqual({ tier: 1, via: null });
		expect(matchCustomer(sharp, "1001")).toEqual({ tier: 0, via: null });
	});

	it("negative: three digits are too few to match a phone, and strangers do not match", () => {
		expect(matchCustomer(sharp, "234")).toBeNull();
		expect(matchCustomer(sharp, "Zelda")).toBeNull();
		expect(matchCustomer(ownMobile, "5551234")).toBeNull();
	});
});

describe("ranking the cached customers offline", () => {
	const all = [sharp, janeFarm, ownMobile, exactJane];

	it("exact farm first, then farms by their own name, then farms found through a contact", () => {
		expect(rankCustomerMatches(all, "Jane").map((c) => c.name)).toEqual(["JANE", "MC-CUST-2002", "MC-CUST-1001"]);
	});

	it("a phone finds only its owner", () => {
		expect(rankCustomerMatches(all, "919-555-1234").map((c) => c.name)).toEqual(["MC-CUST-1001"]);
	});

	it("an empty term keeps the cached order and the limit", () => {
		expect(rankCustomerMatches(all, "", 2).map((c) => c.name)).toEqual(["MC-CUST-1001", "MC-CUST-2002"]);
	});
});

describe("command search: a phone number is a search, not a sum", () => {
	it.each(["(919) 555-1234", "919-555-1234", "9195551234", "1234", "555 1234", "919.555.1234"])("%s searches", (term) => {
		expect(isCalculation(term)).toBe(false);
	});
	it.each(["=55-45", "55+45", "12*3", "(2+3)*4", "100/4", "= 2"])("%s calculates", (term) => {
		expect(isCalculation(term)).toBe(true);
	});
});
