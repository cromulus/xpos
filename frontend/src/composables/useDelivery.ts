/**
 * Where "Add delivery" gets its inputs (MuleCity-6nb1): online from the site
 * (xpos.api.delivery), offline from what the till cached (the policy in sync
 * meta, the customer's delivery details on their cached row, item weights in
 * the item cache). The pricing itself is services/delivery.ts.
 */
import { call } from "@/services/api";
import { getCustomer, getItem, getSyncMeta, setSyncMeta } from "@/services/dbBridge";
import {
	cartWeight,
	quoteOffline,
	type CustomerDelivery,
	type DeliveryAddress,
	type DeliveryPolicy,
	type DeliveryQuote,
} from "@/services/delivery";
import { isNetworkError, isOnline } from "@/utils";
import {
	ADD_ADDRESS_METHOD,
	addAddressArgs,
	cacheCustomerAddress,
	cachedAddress,
	queueAddress,
	type AddedAddress,
	type AddressForm,
} from "@/services/addressQueue";
import { TYPED_OFFLINE, newLocalAddressId } from "@/services/delivery";

const POLICY_KEY = "delivery_policy";

interface CartLine {
	item_code: string;
	qty: number;
	conversion_factor?: number;
}

/** Fetch the site's delivery policy and keep it for offline use; null when the site quotes no delivery. */
export async function refreshDeliveryPolicy(): Promise<DeliveryPolicy | null> {
	const policy = (await call<DeliveryPolicy | null>("xpos.api.delivery.get_delivery_policy")) || null;
	await setSyncMeta(POLICY_KEY, JSON.stringify(policy));
	return policy;
}

/** The policy this till last cached, or null. */
export async function cachedDeliveryPolicy(): Promise<DeliveryPolicy | null> {
	try {
		const raw = await getSyncMeta(POLICY_KEY);
		return raw ? (JSON.parse(String(raw)) as DeliveryPolicy | null) : null;
	} catch {
		return null;
	}
}

/** The site's policy: fresh online, the cached one offline or when the site cannot be reached. */
export async function deliveryPolicy(): Promise<DeliveryPolicy | null> {
	if (!isOnline()) return cachedDeliveryPolicy();
	try {
		return await refreshDeliveryPolicy();
	} catch {
		return cachedDeliveryPolicy();
	}
}

/**
 * A customer's standing charge and addresses. Online it is asked fresh (an
 * address saved in Edit Customer is newer than the search row); offline it is
 * the details cached on their customer row.
 */
export async function customerDelivery(customer: { name: string; xpos_delivery?: CustomerDelivery }): Promise<CustomerDelivery | null> {
	if (isOnline()) {
		try {
			return (await call<CustomerDelivery | null>("xpos.api.delivery.get_customer_delivery", { customer: customer.name })) || null;
		} catch (error) {
			if (!isNetworkError(error)) throw error;
		}
	}
	if (customer.xpos_delivery) return customer.xpos_delivery;
	const cached = (await getCustomer(customer.name).catch(() => null)) as { xpos_delivery?: CustomerDelivery } | null;
	return cached?.xpos_delivery || null;
}

/** The cart's weight from the cached items' weight_per_unit (the delivery line itself weighs nothing). */
export async function cachedCartWeight(lines: CartLine[], deliveryItem?: string): Promise<number> {
	const codes = [...new Set(lines.map((line) => line.item_code))].filter((code) => code !== deliveryItem);
	const weights = new Map<string, number>();
	for (const code of codes) {
		const item = (await getItem(code).catch(() => null)) as { weight_per_unit?: number } | null;
		weights.set(code, Number(item?.weight_per_unit) || 0);
	}
	return cartWeight(lines.filter((line) => weights.has(line.item_code)), (code) => weights.get(code) || 0);
}

/**
 * The delivery charge for this cart to `address`: the site's quote online; the
 * till's own (same precedence, same policy) offline, for a new address typed
 * offline, or when the site cannot be reached.
 */
export async function quoteDelivery(
	policy: DeliveryPolicy,
	customer: string,
	details: CustomerDelivery | null,
	address: DeliveryAddress,
	lines: CartLine[],
): Promise<DeliveryQuote> {
	if (isOnline() && address.name) {
		try {
			return await call<DeliveryQuote>("xpos.api.delivery.quote_delivery", {
				customer,
				address: address.name,
				items: JSON.stringify(lines),
			});
		} catch (error) {
			if (!isNetworkError(error)) throw error;
		}
	}
	return quoteOffline(policy, details, address, await cachedCartWeight(lines, policy.item_code));
}

/**
 * Add a delivery address for the customer at the till (Bill 2026-10-01 22:52,
 * MuleCity-qajl). Online the site makes it (xpos.api.customers.add_delivery_address:
 * Google's miles, else the typed ones flagged "manual") and answers with its
 * miles and a quote. Offline, or when the site cannot be reached, the add is
 * queued (services/addressQueue.ts) under a local id and the typed miles are
 * flagged as typed offline; the sync makes it before the sale that ships there.
 * Either way the customer's cached row gets the address, so the picker shows it.
 */
export async function addDeliveryAddress(
	customer: string,
	form: AddressForm,
	opts: { first?: boolean } = {},
): Promise<AddedAddress & { queued?: boolean }> {
	if (isOnline()) {
		try {
			const added = await call<AddedAddress>(ADD_ADDRESS_METHOD, addAddressArgs(customer, form, { miles_source: "manual" }));
			await cacheCustomerAddress(customer, cachedAddress(added)).catch(() => undefined);
			return added;
		} catch (error) {
			if (!isNetworkError(error)) throw error;
		}
	}
	const miles = form.miles && form.miles > 0 ? form.miles : null;
	const local: AddedAddress = {
		name: newLocalAddressId(),
		title: form.title || null,
		address_type: "Shipping",
		address_line1: form.address_line1,
		address_line2: form.address_line2 || null,
		city: form.city,
		state: form.state,
		pincode: form.pincode,
		miles,
		miles_source: miles ? TYPED_OFFLINE : null,
		is_primary_address: !!opts.first,
		is_shipping_address: !!opts.first,
		miles_pending: !miles,
		latitude: null,
		longitude: null,
		geolocation_pending: true,
	};
	await queueAddress({ ...form, miles, local_id: local.name, customer, queued_at: new Date().toISOString() });
	await cacheCustomerAddress(customer, cachedAddress(local)).catch(() => undefined);
	return { ...local, queued: true };
}
