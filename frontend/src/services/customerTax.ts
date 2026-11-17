/**
 * Mule City: a customer's tax exemption is set on the desk's Customer form.
 *
 * Front desk may set a customer's Tax Category directly; the Customer's change
 * history records who did (mulecity-full a473f290). The counter opens that
 * form in a new tab at its Tax Category field, through Frappe's own
 * ``scroll_to`` route option (form.js scroll_to_element): it opens the field's
 * tab and section and scrolls to it. Not the URL hash: the desk redirects
 * /desk/customer/<name> to /desk/selling/customer/<name> and drops the hash, so
 * the form opened on Details with no tax field in sight ("tax stuff didn't
 * load", Bill 2026-11-17, MuleCity-embd).
 */
import __ from "@/lib/translate";
import { showError } from "@/services/api";

export function customerTaxUrl(customer: string): string {
	return "/desk/customer/" + encodeURIComponent(customer) + "?scroll_to=tax_category";
}

/** Open the customer's tax section on the desk; say so if the browser blocked the tab. */
export function openCustomerTaxSection(customer: string): void {
	if (!window.open(customerTaxUrl(customer), "_blank")) {
		showError(__("Allow pop-ups to open the customer on the desk, or open it there and set the Tax Category."));
	}
}
