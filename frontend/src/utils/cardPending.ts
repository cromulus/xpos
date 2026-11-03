/**
 * The card reader payment this browser is collecting (Mule City, MuleCity-bjjv.3),
 * kept across a reload so the till resumes watching it instead of charging again,
 * and so Close Shift waits for it. No imports: Close Shift reads it without stores.
 */

/** The payment this till is collecting, kept across a reload. */
export interface PendingCardPayment {
	profile: string;
	doctype: string;
	invoice: string;
	modified?: string;
	localId?: string;
	terminal?: string;
	attempt?: string;
	amount?: number;
	/** Cash taken beside the card: confirmed again before each start. */
	cash?: number;
	customer?: string;
	withPrint?: boolean;
	startedAt: string;
}

const PENDING_KEY = "xpos:card-payment";

export function loadPendingCard(): PendingCardPayment | null {
	try {
		const raw = window.localStorage.getItem(PENDING_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as PendingCardPayment;
		return value && value.invoice && value.doctype ? value : null;
	} catch {
		return null;
	}
}

export function savePendingCard(value: PendingCardPayment): void {
	try {
		window.localStorage.setItem(PENDING_KEY, JSON.stringify(value));
	} catch {
		/* private window or storage full: the server-side draft still blocks a second charge */
	}
}

export function clearPendingCard(): void {
	try {
		window.localStorage.removeItem(PENDING_KEY);
	} catch {
		/* nothing kept */
	}
}
