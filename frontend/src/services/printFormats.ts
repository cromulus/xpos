/**
 * Print formats the till names for documents that are not the sale itself. A
 * site's own format names come from its map (boot `xpos_site`); with none, the
 * doctype's standard or default format prints. XPOS names no site format.
 */
import { siteValue } from "@/services/siteExtensions";

/** A Payment Entry receipt from Pay balance: the pay-balance settings, else the site's, else Standard. */
export function payBalanceReceiptFormat(settingsFormat?: string | null): string {
	return settingsFormat || String(siteValue("print_formats.payment_receipt") || "") || "Standard";
}

/**
 * The print view of a mix order (Sales Order) the till just placed: the site's
 * order format (xpos_site `mix.order_print_format`), else the doctype's default.
 */
export function mixOrderPrintUrl(salesOrder: string): string {
	const format = String(siteValue("mix.order_print_format") || "");
	const url = `/printview?doctype=Sales%20Order&name=${encodeURIComponent(salesOrder)}`;
	return format ? `${url}&format=${encodeURIComponent(format)}` : url;
}
