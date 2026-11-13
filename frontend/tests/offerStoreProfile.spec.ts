/**
 * Coupon lookups name the till's POS Profile.
 *
 * The server checks the customer on a coupon or gift card through the till's
 * own profile, and looks the coupon up in that profile's company, so the till
 * sends its profile with the lookup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const state = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/services/api", () => ({ call: state.call, isNetworkError: () => false }));
vi.mock("@/services/dbBridge", () => ({ cacheOffers: vi.fn(), getCachedOffers: vi.fn(async () => []) }));

import { useOfferStore } from "@/stores/offerStore";

describe("coupon lookups send the till's profile", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		state.call.mockReset();
	});

	it("a coupon is checked through the till's profile", async () => {
		state.call.mockResolvedValue({ coupon: null, msg: "Sorry" });
		await useOfferStore().fetchCoupon("GIFT100", "Jane Doe", "Example Co", "Front Counter");
		expect(state.call).toHaveBeenCalledWith("xpos.api.offers.get_pos_coupon", {
			coupon: "GIFT100",
			customer: "Jane Doe",
			company: "Example Co",
			pos_profile: "Front Counter",
		});
	});

	it("gift cards are listed through the till's profile", async () => {
		state.call.mockResolvedValue([]);
		await useOfferStore().fetchGiftCoupons("Jane Doe", "Front Counter");
		expect(state.call).toHaveBeenCalledWith("xpos.api.offers.get_active_gift_coupons", {
			customer: "Jane Doe",
			pos_profile: "Front Counter",
		});
	});
});
