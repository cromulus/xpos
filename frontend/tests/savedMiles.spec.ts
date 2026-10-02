/**
 * User story (Mule City MuleCity-ra6h; mc26 walk on MuleCity-p644): the clerk
 * typed 3 mi for a new delivery address; the site's Google Routes lookup saved
 * 0.8 mi (by design Google wins) and nothing said so. After the save the clerk
 * now reads "Saved: 0.8 mi (Google route), you typed 3 mi". The typed miles
 * stand only when the site couldn't find any, and then there is nothing to say.
 */
import { describe, expect, it } from "vitest";

import { savedMilesNote } from "@/utils/savedMiles";

describe("the saved miles are told back to the clerk", () => {
	it("Google's route replaced the typed miles: say both", () => {
		expect(savedMilesNote(3, { miles: 0.8, miles_source: "routes" })).toBe(
			"Saved: 0.8 mi (Google route), you typed 3 mi",
		);
		// The site's answer may name them delivery_miles.
		expect(savedMilesNote(3, { delivery_miles: 0.8, miles_source: "routes" })).toBe(
			"Saved: 0.8 mi (Google route), you typed 3 mi",
		);
	});

	it("negative: the site couldn't get miles, so the typed ones were kept: nothing to say", () => {
		expect(savedMilesNote(3, { miles: 3, miles_source: "manual" })).toBe("");
		expect(savedMilesNote(3, { miles: null, miles_source: null })).toBe("");
	});

	it("negative: nothing typed, or Google agrees: nothing to say", () => {
		expect(savedMilesNote(null, { miles: 0.8, miles_source: "routes" })).toBe("");
		expect(savedMilesNote(3, { miles: 3, miles_source: "routes" })).toBe("");
		expect(savedMilesNote(3, null)).toBe("");
	});
});
