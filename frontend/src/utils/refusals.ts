/**
 * The site's expected refusals (Mule City MuleCity-ra6h).
 *
 * Why: "Short ingredients", a mix with no price, or "address lookup isn't
 * available" are the site's answers to a question the till asks while the cart
 * is built. Every refused call went into the error log and lit its badge, so
 * the badge filled with answers and a real error was lost among them. A caller
 * that expects a refusal says so (``call(..., { answers })``): the refusal is
 * still thrown, for the caller to show inline, but kept out of the error log.
 *
 * Kept apart from services/api so modules that mock the API (tests) still get
 * these.
 */

/** What a refusal looked like, for a caller deciding whether it is an answer. */
export interface RefusalInfo {
	status: number;
	excType?: string;
	message: string;
}

export interface CallOptions {
	/** True for a refusal the caller shows as an answer (not logged as an error). */
	answers?: (refusal: RefusalInfo) => boolean;
}

/** A refusal the site raised on purpose (``frappe.throw``: ValidationError, HTTP 417). */
export function isValidationRefusal(refusal: RefusalInfo): boolean {
	return refusal.status === 417;
}

/** The address lookup's refusals: it can't look up (417) or too many lookups (429). */
export function isLookupRefusal(refusal: RefusalInfo): boolean {
	return refusal.status === 417 || refusal.status === 429 || refusal.excType === "AddressLookupUnavailable";
}
