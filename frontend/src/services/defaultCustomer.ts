/**
 * The till's default (walk-in) customer, online and offline (MuleCity-yn4b).
 *
 * The POS Profile names the customer a sale goes to when nobody is chosen. The
 * till puts it on the cart at start, after a sale and after "clear customer".
 * Its full row (tax category, group, territory) comes from the till's customer
 * cache first, so an offline start or clear has it; the server is asked only
 * when online. Before, the start asked the server alone, so an offline cold
 * start left the cart with no customer.
 */
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { getCustomer as getCachedCustomer } from "@/services/dbBridge";
import { getCustomer } from "@/utils";

type Row = Record<string, unknown>;

/** The customer's row from the till's cache, else (online only) the server; null if neither has it. */
export async function defaultCustomerRow(name: string): Promise<Row | null> {
	let row: Row | null = null;
	try {
		row = ((await getCachedCustomer(name)) as Row | null | undefined) ?? null;
	} catch {
		row = null;
	}
	if (!row && navigator.onLine) {
		try {
			row = ((await getCustomer(name)) as Row | null | undefined) ?? null;
		} catch {
			row = null;
		}
	}
	return row;
}

/**
 * Put the profile's default customer on a cart that has none (by ID at once,
 * then its full row). A customer chosen meanwhile is never replaced.
 */
export async function selectDefaultCustomer(): Promise<void> {
	const posStore = usePosStore();
	const cartStore = useCartStore();
	const name = posStore.defaultCustomer ? String(posStore.defaultCustomer) : "";
	if (!name) return;
	if (cartStore.customer && cartStore.customer.name !== name) return;
	if (!cartStore.customer) cartStore.setCustomer({ name, customer_name: name });
	const row = await defaultCustomerRow(name);
	if (row && cartStore.customer?.name === name) cartStore.setCustomer(row as never);
}
