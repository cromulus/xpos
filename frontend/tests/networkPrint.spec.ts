/**
 * @vitest-environment jsdom
 *
 * User stories (MuleCity-g100, Bill 2026-09-29): "XPOS should print through ERPNext,
 * unless the internet is down, and then it prints locally."
 *
 * - Online, and the site has a network printer: Save & Print / reprint ask ERPNext to
 *   print the ticket on that printer (print_by_server), in the POS Profile's print format.
 * - Offline: the ticket prints here through the browser, as before; the server is not asked.
 * - ERPNext cannot print (internet dropped, printer or print server error): the cashier
 *   sees a short notice and the ticket prints here instead.
 * - The site has no network printer: the ticket prints here, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { call, showError, showInfo, posStore } = vi.hoisted(() => ({
	call: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
	posStore: {
		profileName: "Mule City Counter",
		defaultPrintFormat: "Mule City Ticket",
		printSettings: null as { letter_head?: string } | null,
	},
}));

vi.mock("@/services/api", () => ({ call, showError, showInfo }));
vi.mock("@/services/dbBridge", () => ({ getCachedReceiptContext: vi.fn() }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => posStore }));

import { usePrintInvoice } from "@/composables/usePrintInvoice";

const PRINTER = "Mule City Ricoh";

function setOnline(online: boolean) {
	Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
}

function setBoot(boot: Record<string, unknown>) {
	(window as any).xpos = { boot: { currencies: [], countries: [], ...boot } };
}

function serverPrintCalls() {
	return call.mock.calls.filter(([method]) => method === "frappe.utils.print_format.print_by_server");
}

let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	call.mockResolvedValue(undefined);
	open = vi.fn(() => ({}) as Window);
	window.open = open as unknown as typeof window.open;
	setOnline(true);
	setBoot({ mule_default_network_printer: PRINTER });
});

afterEach(() => {
	setOnline(true);
});

describe("printing a saved sale", () => {
	it("online with a network printer: ERPNext prints the ticket on it, nothing opens here", async () => {
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0001");

		expect(serverPrintCalls()).toEqual([
			[
				"frappe.utils.print_format.print_by_server",
				{
					doctype: "Sales Invoice",
					name: "SINV-0001",
					printer_setting: PRINTER,
					print_format: "Mule City Ticket",
					no_letterhead: 1,
				},
			],
		]);
		expect(call).toHaveBeenCalledWith("xpos.api.print_formats.mark_invoice_printed", {
			doctype: "Sales Invoice",
			name: "SINV-0001",
		});
		expect(open).not.toHaveBeenCalled();
		expect(showInfo).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("uses the POS Invoice doctype and an explicit format when asked", async () => {
		setBoot({ mule_default_network_printer: PRINTER, pos_settings: { invoice_type: "POS Invoice" } });
		const { printInvoice } = usePrintInvoice();
		await printInvoice("POS-0009", { format: "Mule City Order" });

		expect(serverPrintCalls()[0][1]).toMatchObject({
			doctype: "POS Invoice",
			name: "POS-0009",
			print_format: "Mule City Order",
		});
	});

	it("offline: prints here through the browser and never asks the server", async () => {
		setOnline(false);
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0002");

		expect(serverPrintCalls()).toHaveLength(0);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0][0]).toContain("/printview?doctype=Sales%20Invoice&name=SINV-0002");
		expect(open.mock.calls[0][0]).toContain("format=Mule%20City%20Ticket");
	});

	it("ERPNext cannot print: a short notice, then the ticket prints here", async () => {
		call.mockImplementation(async (method: string) => {
			if (method === "frappe.utils.print_format.print_by_server") throw new Error("Printing failed");
		});
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0003");

		expect(serverPrintCalls()).toHaveLength(1);
		expect(showInfo).toHaveBeenCalledWith(`Could not print on ${PRINTER}; printing here instead.`);
		expect(showError).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0][0]).toContain("name=SINV-0003");
	});

	it("internet drops mid-call: the ticket still prints here", async () => {
		call.mockRejectedValue(new Error("__offline__"));
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0004");

		expect(showInfo).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("no network printer in boot: prints here as before", async () => {
		setBoot({});
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0005");

		expect(serverPrintCalls()).toHaveLength(0);
		expect(showInfo).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});
});
