/**
 * Google address typeahead for the till's add-address form (Mule City,
 * MuleCity-p644; the site side is MuleCity-gvxs).
 *
 * Why: Bill 2026-10-01: type the address, pick Google's suggestion, and street,
 * town, state, ZIP and county fill in, with the miles, validated. The Google key
 * stays on the site; XPOS keeps one API surface, as for add_delivery_address:
 * `xpos.api.customers.address_autocomplete` / `address_resolve` call the site's
 * hooks (Mule City: address_lookup.autocomplete / resolve, login-only and
 * rate-limited per user).
 *
 * What: suggestions from 4 characters, one UUID session token per address
 * (Google bills the suggestions and the pick of one session as one), and a
 * cooldown: when the site cannot look up (no key, Google refused (its 403 comes
 * back as AddressLookupUnavailable), too many lookups, no hook) the till stops
 * asking for a while and the clerk types the address as before. Offline it never
 * asks.
 */
import { call } from "@/services/api";
import { isNetworkError } from "@/utils";
import { isLookupRefusal } from "@/utils/refusals";

export const AUTOCOMPLETE_METHOD = "xpos.api.customers.address_autocomplete";
export const RESOLVE_METHOD = "xpos.api.customers.address_resolve";
/** The site asks Google only from 4 characters (address_lookup.MIN_TEXT). */
export const MIN_LOOKUP_TEXT = 4;
/** One lookup per pause in typing. */
export const LOOKUP_DEBOUNCE_MS = 300;
/** After the site says it cannot look up, the till does not ask again for this long. */
export const LOOKUP_COOLDOWN_MS = 5 * 60 * 1000;

export interface AddressSuggestion {
	place_id: string;
	description: string;
}

/** A picked suggestion as the site resolves it. */
export interface ResolvedAddress {
	address_line1: string;
	address_line2?: string | null;
	city: string;
	county?: string | null;
	state: string;
	pincode: string;
	country?: string | null;
	latitude?: number | null;
	longitude?: number | null;
	/** Google knows it as one door (street number on a named road, town, state and ZIP). */
	validated?: boolean;
	formatted_address?: string;
	place_id?: string;
	/** Google Routes one-way miles from HQ (null when Routes did not answer). */
	delivery_miles?: number | null;
}

/** Why the till stopped asking: the site cannot look up (the clerk types the address). */
export class LookupUnavailable extends Error {}

let downUntil = 0;

/** The site said it cannot look up a moment ago: do not ask again yet. */
export function lookupResting(now = Date.now()): boolean {
	return now < downUntil;
}

/** Forget the cooldown (tests). */
export function resetLookupCooldown(): void {
	downUntil = 0;
}

/** A fresh session token: one per address the clerk adds. */
export function newSessionToken(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
	return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/**
 * Ask the site; a refusal (anything but the network) starts the cooldown and
 * becomes LookupUnavailable. A network failure is rethrown as is: the till is
 * offline, the clerk types the address.
 */
async function ask<T>(method: string, args: Record<string, unknown>): Promise<T> {
	if (lookupResting()) throw new LookupUnavailable("resting");
	try {
		// "Lookup isn't available" is an answer (the clerk types), not an error to log (MuleCity-ra6h).
		return await call<T>(method, args, undefined, { answers: isLookupRefusal });
	} catch (error) {
		if (isNetworkError(error)) throw error;
		downUntil = Date.now() + LOOKUP_COOLDOWN_MS;
		throw new LookupUnavailable(error instanceof Error ? error.message : String(error));
	}
}

/** Google's suggestions for what the clerk typed ([] under 4 characters, without asking). */
export async function suggestAddresses(text: string, sessionToken: string): Promise<AddressSuggestion[]> {
	const typed = text.split(/\s+/).filter(Boolean).join(" ");
	if (typed.length < MIN_LOOKUP_TEXT) return [];
	return (await ask<AddressSuggestion[]>(AUTOCOMPLETE_METHOD, { text: typed, session_token: sessionToken })) || [];
}

/** The picked suggestion's fields, point and miles. */
export function resolveAddress(placeId: string, sessionToken: string): Promise<ResolvedAddress> {
	return ask<ResolvedAddress>(RESOLVE_METHOD, { place_id: placeId, session_token: sessionToken });
}
