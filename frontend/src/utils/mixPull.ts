import __ from "@/lib/translate";

/**
 * A custom mix's pull list as the site planned it (Mule City MuleCity-erqg.11/.17):
 * the pounds asked for, the pounds the mixer pulls (and bills) and the loads.
 */
export interface MixPull {
	asked_lb?: number | null;
	pulled_lb?: number | null;
	loads?: number | null;
	status?: string;
	blocked?: boolean;
	exact?: boolean;
}

/** One way to make a size work when no pull list passes, worked out by the site's rounder. */
export interface PullFix {
	kind: "size" | "loads" | "pull" | "band" | "exact";
	label: string;
	consequence: string;
	owner_only?: boolean;
	value?: number;
	apply: Record<string, unknown>;
}

const lb = (value: number) => Math.round(value).toLocaleString();

/** "2,000 lb asked → 2,040 lb pulled, 4 loads", or "" when there is nothing to say. */
export function pullSummary(pull: MixPull | null | undefined): string {
	if (!pull || pull.asked_lb == null) return "";
	if (pull.blocked) return __("{0} lb asked: no practical pull list. Choose a fix below.", [lb(pull.asked_lb)]);
	const loads = pull.loads ? __(", {0} {1}", [pull.loads, pull.loads === 1 ? __("load") : __("loads")]) : "";
	if (pull.pulled_lb == null || Math.abs(pull.pulled_lb - pull.asked_lb) < 0.5) {
		return __("{0} lb{1}", [lb(pull.asked_lb), loads]);
	}
	return __("{0} lb asked → {1} lb pulled{2}", [lb(pull.asked_lb), lb(pull.pulled_lb), loads]);
}

/** The cart quantity a size fix means, in the line's own unit. */
export function qtyForSize(qty: number, askedLb: number, sizeLb: number): number {
	if (!askedLb) return qty;
	return Math.round((qty * sizeLb) / askedLb * 1000) / 1000;
}
