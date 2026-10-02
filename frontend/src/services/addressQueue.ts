/**
 * Delivery addresses added at the till while offline (Mule City, MuleCity-qajl,
 * Bill 2026-10-01 22:52).
 *
 * Why: a named customer with no address (or not this one) can get a delivery
 * offline too. The clerk adds the address at the till; the site makes it only
 * when the till is back online, so the sale that ships there must wait for it.
 *
 * What: each add is queued (sync meta, so the browser and the Electron till keep
 * it alike) under a local id (`LOCAL-ADDR-...`), which the cart uses as the
 * address's name. At sync, before the queued sales, every queued add is replayed
 * through `xpos.api.customers.add_delivery_address` with its typed miles flagged
 * `manual_offline`; the local id -> Address name pair goes to the sync id map, as
 * offline shifts do for the sales that need them. A queued sale names its address
 * by local id in `xpos_new_shipping_address.local_id`; `resolveQueuedAddress`
 * swaps in the real name before the sale is sent. If an add could not be
 * replayed, the sale still carries the whole address and the server makes it
 * the same way (xpos.api.delivery.resolve_new_shipping_address).
 */
import { call } from "@/services/api";
import { addSyncId, getCustomer, getServerName, getSyncMeta, setSyncMeta, upsertCustomers } from "@/services/dbBridge";
import { TYPED_OFFLINE, type CustomerDelivery, type DeliveryAddress, type DeliveryQuote } from "@/services/delivery";
import { isNetworkError } from "@/utils";

const QUEUE_KEY = "pending_delivery_addresses";
export const ADD_ADDRESS_METHOD = "xpos.api.customers.add_delivery_address";

/** An address typed at the till, as add_delivery_address takes it. */
export interface AddressForm {
	address_line1: string;
	address_line2?: string | null;
	city: string;
	state: string;
	pincode: string;
	title?: string | null;
	/** One-way miles the clerk typed (optional). */
	miles?: number | null;
	/** From a typeahead pick (MuleCity-p644): the county and Google's point, kept on the Address. */
	county?: string | null;
	latitude?: number | null;
	longitude?: number | null;
}

export interface QueuedAddress extends AddressForm {
	local_id: string;
	customer: string;
	queued_at: string;
	/** The server refused it (not a network failure): kept for review, not retried. */
	refused?: string;
}

/** What add_delivery_address answers: the cached address shape, plus its quote. */
export interface AddedAddress extends DeliveryAddress {
	address_display?: string;
	miles_pending?: boolean;
	geolocation_pending?: boolean;
	local_id?: string | null;
	/** The site's quote to it with no cart (the till re-quotes with the cart's weight). */
	quote?: DeliveryQuote;
}

export interface AddressQueueDeps {
	load(): Promise<QueuedAddress[]>;
	save(queue: QueuedAddress[]): Promise<void>;
	add(queued: QueuedAddress): Promise<AddedAddress>;
	remember(localId: string, serverName: string): Promise<void>;
	serverName(localId: string): Promise<string | null>;
	isNetworkError(error: unknown): boolean;
	/** The site made it: swap the local entry on the cached customer row for the real one. */
	replaced?(queued: QueuedAddress, added: AddedAddress): Promise<void>;
}

/** The add, as XPOS's one API surface takes it. */
export function addAddressArgs(customer: string, form: AddressForm, extra: Record<string, unknown> = {}) {
	return {
		customer,
		address_line1: form.address_line1,
		address_line2: form.address_line2 || null,
		city: form.city,
		state: form.state,
		pincode: form.pincode,
		title: form.title || null,
		delivery_miles: form.miles && form.miles > 0 ? form.miles : null,
		// Only a picked address has these; a typed one sends what it always did.
		...(form.county ? { county: form.county } : {}),
		...(form.latitude != null && form.longitude != null ? { latitude: form.latitude, longitude: form.longitude } : {}),
		...extra,
	};
}

export const defaultAddressQueueDeps: AddressQueueDeps = {
	async load() {
		try {
			const raw = await getSyncMeta(QUEUE_KEY);
			return raw ? (JSON.parse(String(raw)) as QueuedAddress[]) : [];
		} catch {
			return [];
		}
	},
	async save(queue) {
		await setSyncMeta(QUEUE_KEY, JSON.stringify(queue));
	},
	add(queued) {
		return call<AddedAddress>(
			ADD_ADDRESS_METHOD,
			addAddressArgs(queued.customer, queued, { miles_source: TYPED_OFFLINE, local_id: queued.local_id }),
		);
	},
	async remember(localId, serverName) {
		await addSyncId(localId, serverName, "Address");
	},
	async serverName(localId) {
		return ((await getServerName(localId)) as string | null) || null;
	},
	isNetworkError: (error) => isNetworkError(error),
	async replaced(queued, added) {
		await replaceCachedAddress(queued.customer, queued.local_id, added);
	},
};

/** Keep an address added offline until the till syncs. */
export async function queueAddress(queued: QueuedAddress, deps: AddressQueueDeps = defaultAddressQueueDeps): Promise<void> {
	const queue = await deps.load();
	await deps.save([...queue.filter((row) => row.local_id !== queued.local_id), queued]);
}

/** Addresses still waiting for the site (refused ones included, for review). */
export async function queuedAddresses(deps: AddressQueueDeps = defaultAddressQueueDeps): Promise<QueuedAddress[]> {
	return deps.load();
}

/**
 * Replay the queued adds, oldest first, before any queued sale. Stops at the
 * first network failure (the rest wait for the next sync); a refusal is kept,
 * marked, and not retried.
 */
export async function replayQueuedAddresses(
	deps: AddressQueueDeps = defaultAddressQueueDeps,
): Promise<{ added: number; refused: QueuedAddress[]; stopped: boolean }> {
	let queue = await deps.load();
	let added = 0;
	const refused: QueuedAddress[] = [];
	for (const queued of [...queue]) {
		if (queued.refused) continue;
		try {
			const made = await deps.add(queued);
			await deps.remember(queued.local_id, made.name);
			queue = queue.filter((row) => row.local_id !== queued.local_id);
			await deps.save(queue);
			await deps.replaced?.(queued, made).catch(() => undefined);
			added++;
		} catch (error) {
			if (deps.isNetworkError(error)) return { added, refused, stopped: true };
			const message = error instanceof Error ? error.message : String(error);
			queue = queue.map((row) => (row.local_id === queued.local_id ? { ...row, refused: message } : row));
			await deps.save(queue);
			refused.push({ ...queued, refused: message });
		}
	}
	return { added, refused, stopped: false };
}

/**
 * A queued sale ships to the Address its offline add became: swap the local id
 * for the real name. Unreplayed, the sale keeps the whole address for the server.
 */
export async function resolveQueuedAddress<T extends Record<string, unknown>>(
	data: T,
	deps: Pick<AddressQueueDeps, "serverName"> = defaultAddressQueueDeps,
): Promise<T> {
	const typed = data.xpos_new_shipping_address as { local_id?: string } | undefined;
	if (!typed?.local_id || data.shipping_address_name) return data;
	const name = await deps.serverName(typed.local_id);
	if (!name) return data;
	const resolved: Record<string, unknown> = { ...data, shipping_address_name: name };
	delete resolved.xpos_new_shipping_address;
	const quote = resolved.xpos_delivery as { address?: string } | undefined;
	if (quote && (!quote.address || quote.address === typed.local_id)) resolved.xpos_delivery = { ...quote, address: name };
	return resolved as T;
}

type CachedCustomer = Record<string, unknown> & { name: string; xpos_delivery?: CustomerDelivery };

/** The customer's details with `address` added (or put in place of `replacing`). */
export function withAddress(details: CustomerDelivery | null | undefined, address: DeliveryAddress, replacing?: string): CustomerDelivery {
	const current = details || { standing_charge: 0, no_charge: false, addresses: [] };
	const others = current.addresses.filter((row) => row.name !== address.name && row.name !== replacing);
	// A new primary shipping address takes the flag from the others, as the site does.
	const rest = address.is_shipping_address ? others.map((row) => ({ ...row, is_shipping_address: false })) : others;
	return { ...current, addresses: address.is_shipping_address ? [address, ...rest] : [...rest, address] };
}

/** Put `address` on the customer's cached row, so the picker shows it at once (online or offline). */
export async function cacheCustomerAddress(customer: string, address: DeliveryAddress, replacing?: string): Promise<void> {
	const row = (await getCustomer(customer).catch(() => null)) as CachedCustomer | null;
	if (!row) return;
	const details = withAddress(row.xpos_delivery, address, replacing);
	await upsertCustomers([
		{ ...row, xpos_delivery: details, xpos_has_address: true, xpos_address_count: details.addresses.length },
	]);
}

/** The cached shape of what add_delivery_address answered (no display, quote or local id). */
export function cachedAddress(added: AddedAddress): DeliveryAddress {
	return {
		name: added.name,
		title: added.title ?? null,
		address_type: added.address_type ?? null,
		address_line1: added.address_line1,
		address_line2: added.address_line2 ?? null,
		city: added.city,
		state: added.state ?? null,
		pincode: added.pincode ?? null,
		miles: added.miles ?? null,
		miles_source: added.miles_source ?? null,
		is_primary_address: !!added.is_primary_address,
		is_shipping_address: !!added.is_shipping_address,
		latitude: added.latitude ?? null,
		longitude: added.longitude ?? null,
	};
}

async function replaceCachedAddress(customer: string, localId: string, added: AddedAddress): Promise<void> {
	await cacheCustomerAddress(customer, cachedAddress(added), localId);
}
