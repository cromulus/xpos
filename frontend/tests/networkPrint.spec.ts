/**
 * @vitest-environment jsdom
 *
 * User stories (MuleCity-g100). Bill 2026-09-29: "xpos should only launch local print
 * if: print server is down, and ERPNext can't communicate with it, OR xpos itself is
 * offline."
 *
 * - Online, the site has a network printer, ERPNext prints the ticket: nothing opens here.
 * - XPOS offline, or the request never reaches ERPNext: the ticket prints here.
 * - ERPNext answers that it cannot reach the print server: a notice, then it prints here.
 * - Any other failure (no Print permission, a printer error ERPNext did reach): the
 *   cashier sees the error and nothing prints here, so they know to reprint.
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

const ENDPOINT = "xpos.api.printing.print_on_network_printer";

function serverPrintCalls() {
	return call.mock.calls.filter(([method]) => method === ENDPOINT);
}

/** ERPNext answers the print request with `outcome` (a result, or an error to throw). */
function serverPrintAnswers(outcome: { status: string } | Error) {
	call.mockImplementation(async (method: string) => {
		if (method !== ENDPOINT) return undefined;
		if (outcome instanceof Error) throw outcome;
		return outcome;
	});
}

let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	serverPrintAnswers({ status: "printed" });
	open = vi.fn(() => ({}) as Window);
	window.open = open as unknown as typeof window.open;
	setOnline(true);
	setBoot({ mule_default_network_printer: PRINTER });
});

afterEach(() => {
	setOnline(true);
});

describe("printing a saved sale", () => {
	it("online and ERPNext prints it: the ticket goes to the network printer, nothing opens here", async () => {
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0001");

		expect(serverPrintCalls()).toEqual([
			[
				ENDPOINT,
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

	it("XPOS offline: prints here through the browser and never asks the server", async () => {
		setOnline(false);
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0002");

		expect(serverPrintCalls()).toHaveLength(0);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0][0]).toContain("/printview?doctype=Sales%20Invoice&name=SINV-0002");
		expect(open.mock.calls[0][0]).toContain("format=Mule%20City%20Ticket");
	});

	it("the request never reaches ERPNext (network error): prints here", async () => {
		serverPrintAnswers(new Error("__offline__"));
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0003");

		expect(serverPrintCalls()).toHaveLength(1);
		expect(showError).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0][0]).toContain("name=SINV-0003");
	});

	it("ERPNext is down behind the proxy (non-API reply): prints here", async () => {
		serverPrintAnswers(new SyntaxError("Unexpected token '<'"));
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0004");

		expect(showError).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("ERPNext cannot reach the print server: a notice, then the ticket prints here", async () => {
		serverPrintAnswers({ status: "print_server_unreachable" });
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0005");

		expect(showInfo).toHaveBeenCalledWith("Could not reach the print server; printing here instead.");
		expect(showError).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalledWith("xpos.api.print_formats.mark_invoice_printed", expect.anything());
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0][0]).toContain("name=SINV-0005");
	});

	it("no Print permission: the error is shown and nothing prints here", async () => {
		serverPrintAnswers(new Error("Not permitted to print Sales Invoice SINV-0006"));
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0006");

		expect(showError).toHaveBeenCalledWith(
			"SINV-0006 did not print: Not permitted to print Sales Invoice SINV-0006. Use Reprint once this is fixed.",
		);
		expect(open).not.toHaveBeenCalled();
		expect(showInfo).not.toHaveBeenCalled();
	});

	it("a printer error ERPNext did reach: the error is shown and nothing prints here", async () => {
		serverPrintAnswers(new Error("Printing failed"));
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0007");

		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0][0]).toContain("Printing failed");
		expect(open).not.toHaveBeenCalled();
	});

	it("no network printer in boot: prints here as before", async () => {
		setBoot({});
		const { printInvoice } = usePrintInvoice();
		await printInvoice("SINV-0008");

		expect(serverPrintCalls()).toHaveLength(0);
		expect(showInfo).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});
});
