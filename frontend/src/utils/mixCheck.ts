import __ from "@/lib/translate";

/**
 * The cart's line about its custom mix orders (MuleCity-zstm.20): whether the
 * mill has the ingredients and what the orders cost, from the site's read-only
 * ``counter_check`` (MuleCity-ynb9; Pay still asks ``counter_quote``), before Pay. Short ingredients are the site's own refusal (MuleCity-mxwy.16),
 * so they read as an answer (amber, as under Pay: MuleCity-ra6h); a check that
 * failed for any other reason reads as a problem (red); everything else is information.
 */
export interface MixCheckInput {
	online: boolean;
	pickupDate: string;
	pending: boolean;
	error: string;
	/** The error is the site's answer (a 417 refusal: short ingredients, no price). */
	errorAnswered?: boolean;
	ordersTotal: number | null;
	/**
	 * The site's non-blocking notes on the orders, e.g. under the 500 lb
	 * custom-mix minimum (Bill 2026-10-14, MuleCity-erqg.16: "warn, don't
	 * block"). Shown in amber beside the price; the order still goes through.
	 */
	warnings?: string[];
}

export function mixCheckStatus(
	input: MixCheckInput,
	money: (amount: number) => string,
): { text: string; tone: "info" | "answer" | "bad" } {
	if (!input.online) {
		return { text: __("Custom mixes can't be ordered offline. Go online, or take the order at the desk."), tone: "bad" };
	}
	if (!input.pickupDate) {
		return { text: __("Choose a pickup date to check the mix's ingredients and price the order."), tone: "info" };
	}
	if (input.pending) return { text: __("Checking the mix's ingredients…"), tone: "info" };
	if (input.error) {
		return { text: __("Can't order yet: {0}", [input.error]), tone: input.errorAnswered ? "answer" : "bad" };
	}
	if (input.ordersTotal != null) {
		const text = __("Ingredients on hand. Mix order {0}.", [money(input.ordersTotal)]);
		const warnings = (input.warnings || []).filter(Boolean);
		return warnings.length ? { text: [text, ...warnings].join(" "), tone: "answer" } : { text, tone: "info" };
	}
	return { text: "", tone: "info" };
}
