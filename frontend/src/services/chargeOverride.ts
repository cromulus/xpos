/**
 * Manager override for a refused charge: a site feature (xpos_site ``charge_override``:
 * ``{approvers, sale}`` method names). Off without it.
 *
 * The site refuses a charge sale over the customer's credit limit or past due
 * with ``CreditHoldValidationError``. The Pay dialog shows its message and a
 * "Manager override": a manager picks their name and types their PIN, and the
 * same cart is paid again through the site's ``sale`` method, which checks the PIN and posts the sale under
 * their approval. The PIN goes in that one request only, as ``override_pwd``
 * (the site's and this till's error logs mask any "pwd" argument); it is never
 * part of the cart, so it is never queued or stored on this register.
 */
import { call } from "@/services/api";
import { requireSiteMethod } from "@/services/siteExtensions";
import type { RefusalInfo } from "@/utils/refusals";
import type { InvoiceData } from "@/types/pos.types";

export const CREDIT_HOLD = "CreditHoldValidationError";
export const OVERRIDE_REFUSED = "OverridePinError";

export interface OverrideApprover {
	user: string;
	full_name: string;
	has_pin: boolean;
}

/** The site refused this charge sale, and a manager may override it. */
export function isChargeRefusal(error: unknown): boolean {
	return (error as { excType?: string } | null)?.excType === CREDIT_HOLD;
}

/** Expected answers, shown in the dialog, kept out of the till's error log. */
export function isOverrideAnswer(refusal: RefusalInfo): boolean {
	return refusal.excType === CREDIT_HOLD || refusal.excType === OVERRIDE_REFUSED;
}

export function listApprovers(): Promise<OverrideApprover[]> {
	return call<OverrideApprover[]>(requireSiteMethod("charge_override.approvers"));
}

/** Pay this cart again with a manager's PIN; ``mix`` for a cart holding custom mixes. */
export function payWithOverride<T>(
	invoiceData: InvoiceData,
	approver: string,
	pin: string,
	mix = false,
): Promise<T> {
	return call<T>(
		requireSiteMethod("charge_override.sale"),
		{ data: JSON.stringify(invoiceData), approver, override_pwd: pin, mix: mix ? 1 : 0 },
		undefined,
		{ answers: isOverrideAnswer },
	);
}
