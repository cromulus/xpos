/**
 * One status control in the top bar (Bill 2026-10-01, MuleCity-qajl.1): "online
 * and in sync can be combined into one thing". The label joins the connection
 * (Online / Offline / Syncing), sales waiting to post, and the offline cache's
 * state; the tone colours it. The detail panel behind it is CacheSyncStatus's.
 */

export interface StatusInput {
	online: boolean;
	syncing: boolean;
	pending: number;
	deadLetters: number;
	/** The profile caches for offline (Use Offline Mode). Without it there is no cache to report. */
	offlineMode: boolean;
	cacheLoading: boolean;
	/** Every cache kind complete, fresh and without error. */
	cacheReady: boolean;
}

export type StatusTone = "ok" | "busy" | "warn" | "bad";

export interface StatusSummary {
	label: string;
	tone: StatusTone;
}

type Translate = (text: string, args?: (string | number)[]) => string;

const plain: Translate = (text, args = []) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));

export function statusSummary(s: StatusInput, __: Translate = plain): StatusSummary {
	const parts: string[] = [];
	let tone: StatusTone = "ok";
	if (s.syncing) {
		parts.push(__("Syncing…"));
		tone = "busy";
	} else parts.push(s.online ? __("Online") : __("Offline"));
	if (!s.online) tone = "bad";
	if (s.deadLetters > 0) {
		parts.push(__("{0} need attention", [s.deadLetters]));
		tone = "bad";
	}
	if (s.pending > 0) {
		parts.push(__("{0} pending", [s.pending]));
		if (tone === "ok") tone = "warn";
	}
	if (s.offlineMode) {
		if (!s.online) parts.push(__("saved data"));
		else if (s.cacheLoading) {
			parts.push(__("refreshing data"));
			if (tone === "ok") tone = "busy";
		} else if (s.cacheReady) parts.push(__("in sync"));
		else {
			parts.push(__("check data sync"));
			if (tone === "ok") tone = "warn";
		}
	}
	return { label: parts.join(" · "), tone };
}

export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
	ok: "text-emerald-600",
	busy: "text-blue-500",
	warn: "text-amber-600",
	bad: "text-red-500",
};
