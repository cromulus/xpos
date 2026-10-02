import { shallowRef } from "vue";

/**
 * Whether the till's offline database (IndexedDB, xpos_offline_v3) could be opened.
 *
 * Kept apart from idbService so stores can read it without pulling Dexie into their chunk.
 */

/** How long opening the offline database may take before the till gives up and runs online only. */
export const DB_OPEN_TIMEOUT_MS = 8000;

/** Fired on window (detail: the OfflineDbUnavailableError) when the offline database becomes unusable. */
export const OFFLINE_DB_UNAVAILABLE_EVENT = "xpos:offline-db-unavailable";

export type OfflineDbUnavailableReason = "blocked" | "timeout";

const ONLINE_ONLY = "The till keeps working online; offline sales are off until then.";

export const OFFLINE_DB_UNAVAILABLE_MESSAGES: Record<OfflineDbUnavailableReason, string> = {
	blocked:
		"Offline data is locked by another X POS tab or window. Close the other X POS tabs, then reload this page. " +
		ONLINE_ONLY,
	timeout:
		`Offline data did not open within ${DB_OPEN_TIMEOUT_MS / 1000} seconds. Close any other X POS tabs or windows, then reload this page. ` +
		ONLINE_ONLY +
		" If it keeps happening, clear this site's data in the browser settings (offline sales not yet synced from this device would be lost).",
};

export class OfflineDbUnavailableError extends Error {
	readonly reason: OfflineDbUnavailableReason;
	/** What to show the cashier. */
	readonly userMessage: string;

	constructor(reason: OfflineDbUnavailableReason) {
		super(
			reason === "blocked"
				? "Opening the offline database was blocked by another connection"
				: `Opening the offline database took longer than ${DB_OPEN_TIMEOUT_MS} ms`,
		);
		this.name = "OfflineDbUnavailableError";
		this.reason = reason;
		this.userMessage = OFFLINE_DB_UNAVAILABLE_MESSAGES[reason];
	}
}

/** Set while the offline database cannot be used; offline features stay off until it clears. */
export const offlineDbUnavailable = shallowRef<OfflineDbUnavailableError | null>(null);

export function markOfflineDbUnavailable(error: OfflineDbUnavailableError): void {
	const first = !offlineDbUnavailable.value;
	offlineDbUnavailable.value = error;
	if (first && typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent(OFFLINE_DB_UNAVAILABLE_EVENT, { detail: error }));
	}
}

export function clearOfflineDbUnavailable(): void {
	offlineDbUnavailable.value = null;
}
