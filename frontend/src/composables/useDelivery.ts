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
