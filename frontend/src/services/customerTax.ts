/**
 * Mule City: a customer's tax exemption is set on the desk's Customer form.
 *
 * Front desk may set a customer's Tax Category directly; the Customer's change
 * history records who did (mulecity-full a473f290). The counter opens that
 * form in a new tab at its Tax Category field: Frappe scrolls a form to the
 * field named in the URL hash, opening its tab and section.
 */
import __ from "@/lib/translate";
import { showError } from "@/services/api";

export function customerTaxUrl(customer: string): string {
	return "/desk/customer/" + encodeURIComponent(customer) + "#tax_category";
}

/** Open the customer's tax section on the desk; say so if the browser blocked the tab. */
export function openCustomerTaxSection(customer: string): void {
	if (!window.open(customerTaxUrl(customer), "_blank")) {
		showError(__("Allow pop-ups to open the customer on the desk, or open it there and set the Tax Category."));
	}
}
