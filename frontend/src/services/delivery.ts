/**
 * Delivery priced at the till (Mule City, MuleCity-6nb1).
 *
 * Why: the site quotes delivery (xpos.api.delivery, backed by its hooks). While
 * the till is offline it cannot ask, so it prices from what it cached: the
 * site's policy and each customer's standing charge and addresses' miles.
 *
 * What: `deliveryCharge` mirrors the site's pure function
 * (mulecity_erpnext/pricing/delivery_charge.py); `quoteOffline` mirrors its
 * precedence (pricing/delivery.py quote_delivery): no charge, then the standing
 * charge, then the address's miles, else the clerk types it. Both are checked
 * against the site's own shared cases (tests/fixtures/delivery_charge_vectors.json).
 * `cartWeight` weighs the load as ERPNext does (weight_per_unit x stock qty).
 */

export interface DeliveryPolicy {
	rate_per_mile: number;
	round_to: number;
	local_miles: number;
	local_charge: number;
	bands: { min_lb: number; pct: number }[];
	/** The delivery line's item (from xpos.api.delivery.get_delivery_policy). */
	item_code?: string;
	item?: { item_code: string; item_name: string; stock_uom: string; item_group?: string };
}

export interface DeliveryAddress {
	/** Empty for an address typed at the till while offline (made when the sale syncs). */
	name: string;
	address_line1: string;
	city: string;
	miles: number | null;
	miles_source: string | null;
}

/** A customer's delivery details (xpos_delivery on the customer row). */
export interface CustomerDelivery {
	standing_charge: number;
	no_charge: boolean;
	addresses: DeliveryAddress[];
}

export type QuoteSource = "exception" | "standing" | "miles" | "none";

export interface DeliveryQuote {
	/** Null when the clerk must type the charge. */
	amount: number | null;
	source: QuoteSource;
	rule: string | null;
	miles: number | null;
	miles_source: string | null;
	band: number | null;
	description: string;
}

/** Miles typed at the till for an address made while offline (the site flags them). */
export const TYPED_OFFLINE = "manual_offline";

/** Nearest multiple of step, halves up (as the site rounds; not banker's rounding). */
function roundTo(amount: number, step: number): number {
	return Math.floor(amount / step + 0.5) * step;
}

/** 1-based weight band: the last band whose minimum the load reaches. */
export function bandOf(policy: DeliveryPolicy, weightLb: number): number {
	let band = 1;
	policy.bands.forEach((b, i) => {
		if (weightLb >= b.min_lb) band = i + 1;
	});
	return band;
}

/** Dollar delivery charge for a load of `weightLb` driven `miles` one way. */
export function deliveryCharge(policy: DeliveryPolicy, miles: number, weightLb: number): number {
	const fullLoad =
		miles < policy.local_miles ? policy.local_charge : roundTo(miles * policy.rate_per_mile, policy.round_to);
	const pct = policy.bands[bandOf(policy, weightLb) - 1].pct;
	return Math.max(roundTo((fullLoad * pct) / 100, policy.round_to), policy.local_charge);
}

/** The site's quote, worked out at the till from cached details (same precedence and wording). */
export function quoteOffline(
	policy: DeliveryPolicy,
	customer: CustomerDelivery | null | undefined,
	address: DeliveryAddress,
	weightLb: number,
): DeliveryQuote {
	const miles = address.miles || null;
	const base = { rule: null, miles, miles_source: address.miles_source || null, band: null };
	if (customer?.no_charge)
		return { ...base, amount: 0, source: "exception", rule: "No delivery charge", description: "No delivery charge (standing exception)" };
	if ((customer?.standing_charge || 0) > 0)
		return { ...base, amount: customer!.standing_charge, source: "standing", rule: "Standing delivery charge", description: "Standing rate" };
	if (miles && miles > 0) {
		const band = bandOf(policy, weightLb);
		const pounds = Math.round(weightLb).toLocaleString("en-US");
		return {
			...base,
			amount: deliveryCharge(policy, miles, weightLb),
			source: "miles",
			rule: "Miles from HQ",
			band,
			description: `${miles} mi, band ${band} (${pounds} lb)`,
		};
	}
	return { ...base, amount: null, source: "none", description: "No miles for this address; type the delivery charge" };
}

/** The load's weight as ERPNext sums it: weight_per_unit x qty x conversion factor, per line. */
export function cartWeight(
	lines: { item_code: string; qty: number; conversion_factor?: number }[],
	weightOf: (itemCode: string) => number,
): number {
	return lines.reduce((sum, line) => sum + (weightOf(line.item_code) || 0) * line.qty * (line.conversion_factor || 1), 0);
}

/** "Street, Town" for the picker. */
export function describeAddress(address: Pick<DeliveryAddress, "address_line1" | "city">): string {
	return [address.address_line1, address.city].filter(Boolean).join(", ");
}
