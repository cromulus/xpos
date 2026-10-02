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
	/** Customers a delivery never goes to: the profile defaults and the site's walk-in accounts (MuleCity-qajl). */
	walk_in_customers?: string[];
}

export interface DeliveryAddress {
	/** Empty for an address typed at the till while offline (made when the sale syncs). */
	name: string;
	address_line1: string;
	city: string;
	miles: number | null;
	/** The Address's own source (the site's lookup "routes", "manual", or TYPED_OFFLINE). */
	miles_source: string | null;
	// Cached for the offline picker (MuleCity-qajl.4); older cached rows lack them.
	title?: string | null;
	address_line2?: string | null;
	state?: string | null;
	pincode?: string | null;
	is_primary_address?: boolean;
	is_shipping_address?: boolean;
	/** "Shipping" or "Billing": a customer's only Shipping address is used without asking (MuleCity-qajl). */
	address_type?: string | null;
	/** Where it is on a map (MuleCity-gvxs fills them later); null until then. */
	latitude?: number | null;
	longitude?: number | null;
}

/** Where a sale's delivery miles came from at the till: the Address's, or typed by the clerk. */
export type DeliveryMilesSource = "address" | "manual";

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

/** "Street, line 2, Town, State ZIP": the whole address, for the picker and the receipt. */
export function fullAddress(
	address: Pick<DeliveryAddress, "address_line1" | "city"> & Partial<Pick<DeliveryAddress, "address_line2" | "state" | "pincode">>,
): string {
	const region = [address.state, address.pincode].filter(Boolean).join(" ");
	return [address.address_line1, address.address_line2, address.city, region].filter(Boolean).join(", ");
}

/**
 * The address the picker starts on (Bill 2026-10-01, MuleCity-qajl.3): the
 * customer's shipping address (primary shipping first), else their primary
 * address, else the first listed (the site lists shipping, then primary, first).
 */
export function defaultDeliveryAddress<T extends DeliveryAddress>(addresses: T[]): T | null {
	return (
		addresses.find((a) => a.is_shipping_address && a.is_primary_address) ||
		addresses.find((a) => a.is_shipping_address) ||
		addresses.find((a) => a.is_primary_address) ||
		addresses[0] ||
		null
	);
}

/** Addresses whose title, street, town, state or ZIP contain every word typed. */
export function searchAddresses<T extends DeliveryAddress>(addresses: T[], term: string): T[] {
	const words = term.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return addresses;
	return addresses.filter((a) => {
		const text = [a.title, a.address_line1, a.address_line2, a.city, a.state, a.pincode].filter(Boolean).join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

/**
 * A delivery needs a real customer (Bill 2026-10-01 22:52, MuleCity-qajl): none
 * for no customer, the POS Profile's default (walk-in) customer, or the site's
 * own walk-in accounts (Mule City: Walk-In Customer and FilePro's CASH 338),
 * which ride on the cached policy. The server refuses them too.
 */
export function isWalkInCustomer(
	customer: string | null | undefined,
	policy: Pick<DeliveryPolicy, "walk_in_customers"> | null | undefined,
	defaultCustomer?: string | null,
): boolean {
	if (!customer) return true;
	if (defaultCustomer && customer === defaultCustomer) return true;
	return !!policy?.walk_in_customers?.includes(customer);
}

/**
 * "Add delivery" is offered for a named, non-walk-in customer on a sale (not a
 * return) when the site quotes delivery, online or offline. Whether the customer
 * has an address does not matter: with none, the button opens the add-address form.
 */
export function deliveryOffered(opts: {
	policy: DeliveryPolicy | null | undefined;
	customer: string | null | undefined;
	defaultCustomer?: string | null;
	isReturnMode?: boolean;
}): boolean {
	if (!opts.policy?.item || opts.isReturnMode) return false;
	return !isWalkInCustomer(opts.customer, opts.policy, opts.defaultCustomer);
}

/** A Shipping-type address (a till- or desk-added delivery place; FilePro's are Billing). */
export function isShippingAddress(address: Pick<DeliveryAddress, "address_type">): boolean {
	return address.address_type === "Shipping";
}

/**
 * The address used without asking (Bill 2026-10-01 22:52): the customer's only
 * address; else their only Shipping address; else none (the clerk picks from
 * the list or adds one).
 */
export function autoDeliveryAddress<T extends DeliveryAddress>(addresses: T[]): T | null {
	if (addresses.length === 1) return addresses[0];
	const shipping = addresses.filter(isShippingAddress);
	return shipping.length === 1 ? shipping[0] : null;
}

/** An address added at the till while offline: its name is a local id until the sync makes it. */
export const LOCAL_ADDRESS_PREFIX = "LOCAL-ADDR-";

export function isLocalAddress(name: string | null | undefined): boolean {
	return !!name && name.startsWith(LOCAL_ADDRESS_PREFIX);
}

export function newLocalAddressId(): string {
	const random =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return `${LOCAL_ADDRESS_PREFIX}${random}`;
}
