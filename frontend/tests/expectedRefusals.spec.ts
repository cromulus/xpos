/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-ra6h, mc26 walk 2026-10-02): the till's error
 * badge filled with the site's expected refusals: the cart's mix check
 * answering "Short ingredients" (417) and the address lookup saying it isn't
 * available. Those are answers the cart and the form show inline; the badge
 * is for real errors, so a refusal the caller expects is still thrown (with its
 * message) but not logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/composables/useToast", () => ({ showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/utils", () => ({ isOnline: () => true, isNetworkError: () => false }));
vi.mock("@/services/electronBridge", () => ({
	isElectron: () => false,
	getApiBaseUrlSync: () => "",
	getApiCredentialsSync: () => ({}),
}));
vi.mock("@/services/idbService", () => ({ getMeta: vi.fn() }));
vi.mock("@/composables/useCurrency", () => ({ formatWithSymbol: vi.fn() }));

import { call } from "@/services/api";
import { clearErrors, entries, unseenCount } from "@/services/errorLog";
import { isLookupRefusal, isValidationRefusal } from "@/utils/refusals";
import { resetLookupCooldown, suggestAddresses, LookupUnavailable } from "@/services/addressLookup";

function refusal(status: number, message: string, excType = "ValidationError") {
	return new Response(
		JSON.stringify({ exc_type: excType, exc: "[]", _server_messages: JSON.stringify([JSON.stringify({ message })]) }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(window as any).xpos = { csrf_token: "t" };
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	clearErrors();
	resetLookupCooldown();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const CHECK = "mulecity_erpnext.counter_mix_orders.counter_check";
const SHORT = "Short ingredients: MC-CORN: 6,171,890 lb at Stores - MCSF";

describe("an expected refusal is an answer, not an error", () => {
	it("the mix check's 'Short ingredients' is thrown with its message but not counted in the badge", async () => {
		fetchMock.mockResolvedValueOnce(refusal(417, SHORT));
		const error = await call(CHECK, { data: "{}" }, undefined, { answers: isValidationRefusal }).catch((e) => e);
		expect(error.message).toBe(SHORT);
		expect(error.answered).toBe(true);
		expect(unseenCount.value).toBe(0);
		expect(entries.value).toHaveLength(0);
	});

	it("negative: the same refusal from a caller that doesn't expect it still lights the badge", async () => {
		fetchMock.mockResolvedValueOnce(refusal(417, SHORT));
		await call(CHECK, { data: "{}" }).catch(() => undefined);
		expect(unseenCount.value).toBe(1);
		expect(entries.value[0].title).toBe(`417 ${CHECK}`);
	});

	it("negative: a server crash on an answering call is still an error", async () => {
		fetchMock.mockResolvedValueOnce(refusal(500, "Internal Server Error", "OperationalError"));
		await call(CHECK, { data: "{}" }, undefined, { answers: isValidationRefusal }).catch(() => undefined);
		expect(unseenCount.value).toBe(1);
	});

	it("the address lookup saying it isn't available is the form's answer: no badge", async () => {
		fetchMock.mockResolvedValueOnce(refusal(417, "Address lookup isn't available", "AddressLookupUnavailable"));
		await expect(suggestAddresses("200 Main", "token")).rejects.toBeInstanceOf(LookupUnavailable);
		expect(unseenCount.value).toBe(0);
	});

	it("too many lookups (429) is an answer too", () => {
		expect(isLookupRefusal({ status: 429, message: "Too many" })).toBe(true);
		expect(isLookupRefusal({ status: 500, message: "boom" })).toBe(false);
		expect(isValidationRefusal({ status: 403, message: "no" })).toBe(false);
	});
});
