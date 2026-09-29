/**
 * Bill (2026-09-29, MuleCity-nfxn.8): Edit Customer opens with the customer's
 * phone and email filled in; saving sends only what Leslie changed.
 */
import { describe, expect, it } from "vitest";
import { changedFields } from "@/utils/customerEdit";

const loaded = { customer_name: "Sharp Farms", mobile_no: "919-555-0199", email_id: "a@b.com", gender: "" };

describe("Edit Customer saves what changed", () => {
	it("sends nothing when nothing changed, even the prefilled phone and email", () => {
		expect(changedFields({ ...loaded }, loaded)).toEqual({});
	});

	it("sends only the field Leslie edited", () => {
		expect(changedFields({ ...loaded, mobile_no: "919-555-0100" }, loaded)).toEqual({ mobile_no: "919-555-0100" });
	});

	it("does not send a field she cleared", () => {
		expect(changedFields({ ...loaded, email_id: "" }, loaded)).toEqual({});
	});
});
