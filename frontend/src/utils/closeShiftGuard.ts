/**
 * Close Shift guard (MuleCity-86ea): the offline queue lives only in this
 * browser, so the server cannot see a sale that never synced. On staging
 * (2026-10-01) a queued sale was refused at sync ("1 need attention") and
 * Close Shift closed anyway, leaving that sale's cash out of the closing.
 *
 * Every queued sale for this till's profile counts, whatever shift it was
 * rung on: a stuck sale from an earlier shift on this device is still money
 * the books do not have. Held drafts are carts, not sales, and do not count.
 */
import type { PendingInvoice } from "@/services/idbService";

export interface QueueBlocker {
	id?: number;
	customer: string;
	amount: number;
	error: string;
	status: PendingInvoice["status"];
}

export interface CloseShiftQueue {
	/** Still waiting to sync (pending, syncing, or failed and retrying). */
	pending: QueueBlocker[];
	/** Refused by the server or out of retries: a person must act. */
	attention: QueueBlocker[];
}

function belongsToProfile(row: PendingInvoice, profile?: string | null): boolean {
	const rowProfile = (row.data as { pos_profile?: string } | undefined)?.pos_profile;
	return !profile || !rowProfile || rowProfile === profile;
}

export function classifyQueue(rows: PendingInvoice[], profile?: string | null): CloseShiftQueue {
	const queue: CloseShiftQueue = { pending: [], attention: [] };
	for (const row of rows) {
		const data = row.data as { is_draft?: unknown; customer?: string; grand_total?: number } | undefined;
		if (data?.is_draft) continue;
		if (!belongsToProfile(row, profile)) continue;
		const blocker: QueueBlocker = {
			id: row.id,
			customer: row.customer_name || data?.customer || "",
			amount: Number(row.grand_total ?? data?.grand_total ?? 0),
			error: row.error || "",
			status: row.status,
		};
		(row.status === "dead_letter" ? queue.attention : queue.pending).push(blocker);
	}
	return queue;
}

export function queueBlocksClose(queue: CloseShiftQueue): boolean {
	return queue.pending.length > 0 || queue.attention.length > 0;
}
