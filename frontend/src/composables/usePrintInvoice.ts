import { usePosStore } from "@/stores/posStore";
import { call, showError, showInfo } from "@/services/api";
import { getCachedReceiptContext } from "@/services/dbBridge";
import { buildReceiptHtml } from "@/services/receiptTemplate";
import type { ReceiptSnapshot } from "@/types/pos.types";
import { __ } from "@/lib/translate";
import { isOnline } from "@/utils";

export interface PrintInvoiceOptions {
	format?: string;
	doctype?: "Sales Invoice" | "POS Invoice";
}

/**
 * Print an HTML document from a hidden iframe. Unlike window.open, this is not caught by
 * popup blockers after an await, and needs no network.
 */
export function printHtml(html: string): HTMLIFrameElement {
	const frame = document.createElement("iframe");
	frame.setAttribute("aria-hidden", "true");
	Object.assign(frame.style, {
		position: "fixed",
		right: "0",
		bottom: "0",
		width: "0",
		height: "0",
		border: "0",
	});
	frame.onload = () => {
		const win = frame.contentWindow;
		if (!win) return;
		win.onafterprint = () => setTimeout(() => frame.remove(), 0);
		// Give the logo a moment to load before the print dialog snapshots the page.
		setTimeout(() => {
			win.focus();
			win.print();
		}, 250);
	};
	frame.srcdoc = html;
	document.body.appendChild(frame);
	return frame;
}

/**
 * Shared invoice printing helpers used by the payment dialog (genuine receipt),
 * the terminal backup receipt, and the cashier settlement screen.
 */
export function usePrintInvoice() {
	const posStore = usePosStore();

	function resolveDoctype(): "Sales Invoice" | "POS Invoice" {
		return xpos.boot?.pos_settings?.invoice_type === "POS Invoice" ? "POS Invoice" : "Sales Invoice";
	}

	/**
	 * The network printer ERPNext prints to (a "Network Printer Settings" name), or "" when
	 * the site has none. Mule City's boot_session puts it in boot as
	 * `mule_default_network_printer`; XPOS boot is Frappe's session boot, so it arrives here.
	 */
	function networkPrinter(): string {
		return xpos.boot?.mule_default_network_printer || "";
	}

	/** Count this print, so later prints of the same receipt show as reprints. Best-effort. */
	function markPrinted(doctype: string, name: string) {
		call("xpos.api.print_formats.mark_invoice_printed", { doctype, name }).catch(() => {
			/* non-fatal: reprint control is best-effort */
		});
	}

	/** Open Frappe's print view in a new window and print it on this computer's printer. */
	function printInBrowser(doctype: string, name: string, printFormat: string, noLetterhead: number) {
		const baseUrl = window.location.origin;
		const printUrl = `${baseUrl}/printview?doctype=${encodeURIComponent(doctype)}&name=${encodeURIComponent(
			name,
		)}&format=${encodeURIComponent(printFormat)}&no_letterhead=${noLetterhead}`;
		const printWindow = window.open(printUrl, "_blank");

		if (printWindow) {
			printWindow.onload = () => {
				printWindow.onafterprint = () => {
					printWindow.close();
				};
				setTimeout(() => {
					printWindow.print();
				}, 500);
				markPrinted(doctype, name);
			};
		} else {
			window.open(printUrl, "_blank");
		}
	}

	/**
	 * Print a server-side invoice (Save & Print, reprints, backup receipts).
	 *
	 * Mule City routing (MuleCity-g100): when online and the site has a network printer,
	 * ERPNext renders the print format to PDF and sends it to that printer itself
	 * (frappe.utils.print_format.print_by_server), so every till prints the same way
	 * regardless of the browser. If that fails (internet down, printer or print server
	 * error), or there is no network printer, or we are offline, it prints here through
	 * the browser as before. Sales saved offline never reach this function; they print
	 * XPOS's own offline receipt (printReceiptOffline).
	 */
	async function printInvoice(invoiceName: string, options: PrintInvoiceOptions = {}) {
		try {
			const printFormat = options.format || posStore?.defaultPrintFormat || "XPOS Thermal Receipt";
			const letterHead = posStore.printSettings?.letter_head || "";
			const noLetterhead = letterHead ? 0 : 1;
			const doctype = options.doctype || resolveDoctype();

			const printer = networkPrinter();
			if (printer && isOnline()) {
				try {
					await call("frappe.utils.print_format.print_by_server", {
						doctype,
						name: invoiceName,
						printer_setting: printer,
						print_format: printFormat,
						no_letterhead: noLetterhead,
					});
					markPrinted(doctype, invoiceName);
					return;
				} catch (error) {
					console.warn("Network print failed; printing locally:", error);
					showInfo(__("Could not print on {0}; printing here instead.", [printer]));
				}
			}

			printInBrowser(doctype, invoiceName, printFormat, noLetterhead);
		} catch (error) {
			console.error("Print error:", error);
			showError(__("Failed to print invoice"));
		}
	}

	async function printInvoiceLocal(localId: number) {
		try {
			if (!window.electronAPI?.db || !window.electronAPI?.print) {
				showError(__("Print not available"));
				return;
			}

			const invoice = await window.electronAPI.db.getPendingInvoice(localId);
			if (!invoice) {
				showError(__("Invoice not found for printing"));
				return;
			}
			const snapshot = (invoice.data as Record<string, unknown>)?.receipt as
				| ReceiptSnapshot
				| undefined;
			const context = await getCachedReceiptContext(posStore.profileName);

			if (snapshot && context) {
				if (!snapshot.name) snapshot.name = `LOCAL-${localId}`;
				const html = buildReceiptHtml(snapshot, context);
				const result = await window.electronAPI.print.printReport(html);
				if (!result?.success) {
					showError(__("Failed to print invoice locally"));
				}
				return;
			}

			await window.electronAPI.print.printInvoice({
				localId,
				data: invoice.data,
				customerName: invoice.customer_name || "",
				grandTotal: invoice.grand_total,
				isReturn: invoice.is_return,
				printFormat: posStore.printSettings?.print_format || "POS Invoice",
				letterHead: posStore.printSettings?.letter_head || "",
				companyName: posStore.posProfile?.company || "",
			});
		} catch (error) {
			console.error("Local print error:", error);
			showError(__("Failed to print invoice locally"));
		}
	}

	/**
	 * Print a sale that exists only on this device. The server's print view is unreachable
	 * offline, so the receipt is built from the sale's snapshot and the cached receipt layout.
	 */
	async function printReceiptOffline(snapshot: ReceiptSnapshot): Promise<boolean> {
		try {
			const context = await getCachedReceiptContext(posStore.profileName);
			if (!context) {
				showError(
					__(
						"The receipt layout is not available offline. Reprint this sale from Order History once back online.",
					),
				);
				return false;
			}
			printHtml(buildReceiptHtml(snapshot, context));
			return true;
		} catch (error) {
			console.error("Offline print error:", error);
			showError(__("Failed to print invoice"));
			return false;
		}
	}

	return { printInvoice, printInvoiceLocal, printReceiptOffline };
}
