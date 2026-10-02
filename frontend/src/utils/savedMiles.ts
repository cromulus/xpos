import __ from "@/lib/translate";

/**
 * What the site saved for a new address's miles, told back to the clerk
 * (Mule City MuleCity-ra6h; mc26 walk on MuleCity-p644).
 *
 * Why: by design the site's Google Routes lookup wins over miles the clerk
 * typed (the typed value is kept only when Google gives none). On the walk the
 * clerk typed 3 mi, the site saved 0.8 mi, and nothing on the screen said so.
 * Now the form's save says "Saved: 0.8 mi (Google route), you typed 3 mi".
 *
 * ``saved`` is ``add_customer_address``'s answer (``miles``, ``miles_source``;
 * ``delivery_miles`` is read too). Empty when nothing was typed, when the
 * typed miles stood (the site found none), or when Google agrees with them.
 */
export function savedMilesNote(
	typed: number | null | undefined,
	saved: { miles?: number | null; delivery_miles?: number | null; miles_source?: string | null } | null | undefined,
): string {
	const typedMiles = Number(typed);
	if (!(typedMiles > 0) || !saved) return "";
	const miles = Number(saved.miles ?? saved.delivery_miles);
	if (!(miles > 0) || saved.miles_source !== "routes") return "";
	if (Math.abs(miles - typedMiles) < 0.05) return "";
	return __("Saved: {0} mi (Google route), you typed {1} mi", [String(miles), String(typedMiles)]);
}
