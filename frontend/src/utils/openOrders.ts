/**
 * Orders in flight at the till (Mule City, Bill 2026-09-30/10-01, MuleCity-zstm.23, mxwy.10).
 *
 * The Mule app's `pos_workspace.find_orders` lists submitted Sales Orders the
 * counter's pickup can still close, each with a `readiness` key and `progress`
 * words taken from its Work Orders. These helpers are the till-side rules: who
 * the list is for, client search over a cached list, and the indicator's counts.
 *
 * Offline the till shows the last list it fetched, with its time, or nothing:
 * never "no orders" it does not know.
 */

export interface OpenOrder {
	name: string;
	customer: string;
	customer_name?: string;
	transaction_date?: string;
	delivery_date?: string;
	grand_total?: number;
	advance_paid?: number;
	currency?: string;
	status?: string;
	per_billed?: number;
	per_delivered?: number;
	/** draft | delivered | ready | in_production | partly_picked_up | open */
	readiness?: string;
	progress?: string;
	/** Submitted Delivery Notes against it (readiness "delivered"). */
	delivery_notes?: string[];
}

export interface OrdersResult {
	rows: OpenOrder[];
	/** When the server gave this list (ms since epoch). */
	fetchedAt: number;
	/** False when this is the last known list, read from the till's cache. */
	live: boolean;
	/** The server's page was full: there may be more orders than these. */
	truncated: boolean;
}

/** Orders the server sends at most; a full page means "there may be more". */
export const ORDERS_LIMIT = 50;

/** The customer whose orders to show: "" (everyone) for none or the register's walk-in customer. */
export function orderScope(customer: string | null | undefined, defaultCustomer: string | null | undefined): string {
	if (!customer) return "";
	return customer === (defaultCustomer || "") ? "" : customer;
}

/** Search a list the till already holds, as the server does: order number, customer code, customer name. */
export function searchOrders(rows: OpenOrder[], term: string | null | undefined): OpenOrder[] {
	const words = (term ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return rows;
	return rows.filter((row) => {
		const text = [row.name, row.customer, row.customer_name].filter(Boolean).join(" ").toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

/** The rows of one customer from the everyone list, only if that list was complete. */
export function customerRowsFromAll(all: OrdersResult | null, customer: string): OrdersResult | null {
	if (!all || all.truncated) return null;
	return { ...all, rows: all.rows.filter((row) => row.customer === customer), live: false };
}

export interface OrdersSummary {
	inFlight: number;
	/** Ready for pickup only: a delivered order is never "ready" (it is billed at the desk). */
	ready: number;
	delivered: number;
}

export function summarizeOrders(rows: OpenOrder[]): OrdersSummary {
	const count = (key: string) => rows.filter((row) => row.readiness === key).length;
	return { inFlight: rows.length, ready: count("ready"), delivered: count("delivered") };
}

/**
 * Why the till cannot load this order for payment, or "" when it can. A delivered
 * order (all or part, on a Delivery Note) is billed from the note at the desk: the
 * till's pickup invoice moves stock and would move it twice (MuleCity-x4kb).
 */
export function pickupBlockedReason(row: OpenOrder): string {
	if (row.readiness !== "delivered") return "";
	const notes = (row.delivery_notes ?? []).join(", ");
	return notes
		? `Already delivered on ${notes}; bill it from the Delivery Note at the desk.`
		: "Already delivered; bill it from the Delivery Note at the desk.";
}

/** "Ready for pickup" stands out; the rest say how far along they are. */
export function readinessLabel(readiness: string | undefined): string {
	switch (readiness) {
		case "ready":
			return "Ready for pickup";
		case "delivered":
			return "Delivered — not billed";
		case "in_production":
			return "With the mill";
		case "partly_picked_up":
			return "Partly picked up";
		case "draft":
			return "Draft";
		default:
			return "Waiting";
	}
}

/** "2:41 PM" today, else "Sep 30, 2:41 PM". */
export function fetchedAtText(at: number, now: number = Date.now()): string {
	const when = new Date(at);
	const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const today = new Date(now).toDateString() === when.toDateString();
	return today ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
