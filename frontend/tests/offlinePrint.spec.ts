/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";

const { getCachedReceiptContext, showError, posStore } = vi.hoisted(() => ({
	getCachedReceiptContext: vi.fn(),
	showError: vi.fn(),
	posStore: { profileName: "Shop Floor", defaultPrintFormat: "", printSettings: null },
}));

vi.mock("@/services/dbBridge", () => ({
	getCachedReceiptContext,
	getCachedCurrencyMeta: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/api", () => ({ call: vi.fn(), showError, showInfo: vi.fn() }));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => posStore }));

import { printHtml, usePrintInvoice } from "@/composables/usePrintInvoice";
import { resetCurrencyCache } from "@/composables/useCurrency";

const context: ReceiptContext = {
	company_name: "Acme Store",
	company_phone: "",
	company_email: "",
	company_website: "",
	company_address: "",
	company_tax_id: "",
	company_logo: "",
	receipt_header: "",
	receipt_footer: "Thank you",
	currency: "USD",
	print_discount_amount: 0,
	print_format: "XPOS Thermal Receipt",
	css: "",
};

const snapshot: ReceiptSnapshot = {
	name: "OFFLINE-7",
	posting_date: "2026-09-17",
	posting_time: "10:15:00",
	is_return: false,
	cashier: "David",
	customer_name: "Walk-in Customer",
	items: [{ item_code: "SKU1", item_name: "Paracetamol", qty: 2, rate: 5, amount: 10 }],
	taxes: [],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
	subtotal: 10,
	total_discount: 0,
	net_total: 10,
	grand_total: 10,
	total_qty: 2,
	change: 0,
};

function lastFrame(): HTMLIFrameElement | null {
	const frames = document.querySelectorAll("iframe");
	return frames.length ? frames[frames.length - 1] : null;
}

/** Stand in for the browser: the frame loads, and print() is observable. */
function loadFrame(frame: HTMLIFrameElement) {
	const print = vi.fn();
	const win = frame.contentWindow!;
	win.print = print;
	win.focus = vi.fn();
	frame.onload!(new Event("load"));
	return { print, win };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	document.body.innerHTML = "";
	(window as any).xpos = {
		boot: { currencies: [{ name: "USD", symbol: "$", number_format: "#,###.##" }] },
	};
	resetCurrencyCache();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("printHtml", () => {
	it("prints the document from a hidden iframe, without opening a window", () => {
		const open = vi.spyOn(window, "open");
		const frame = printHtml("<p>receipt</p>");

		expect(frame.isConnected).toBe(true);
		expect(frame.srcdoc).toBe("<p>receipt</p>");
		expect(frame.style.width).toBe("0px");
		expect(frame.getAttribute("aria-hidden")).toBe("true");

		const { print } = loadFrame(frame);
		expect(print).not.toHaveBeenCalled(); // waits for images first
		vi.advanceTimersByTime(250);
		expect(print).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
	});

	it("removes the iframe once printing is done", () => {
		const frame = printHtml("<p>receipt</p>");
		const { win } = loadFrame(frame);
		vi.advanceTimersByTime(250);

		win.onafterprint!(new Event("afterprint"));
		vi.runAllTimers();
		expect(frame.isConnected).toBe(false);
	});
});

describe("printReceiptOffline", () => {
	it("prints the sale from its snapshot and the cached layout for the current profile", async () => {
		getCachedReceiptContext.mockResolvedValue(context);
		const { printReceiptOffline } = usePrintInvoice();

		await expect(printReceiptOffline(snapshot)).resolves.toBe(true);

		expect(getCachedReceiptContext).toHaveBeenCalledWith("Shop Floor");
		const frame = lastFrame();
		expect(frame).not.toBeNull();
		expect(frame!.srcdoc).toContain("OFFLINE-7");
		expect(frame!.srcdoc).toContain("Paracetamol");
		expect(frame!.srcdoc).toContain("Acme Store");
		expect(frame!.srcdoc).toContain("Thank you");
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not touch the network", async () => {
		getCachedReceiptContext.mockResolvedValue(context);
		const fetchSpy = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
		vi.stubGlobal("fetch", fetchSpy);
		const open = vi.spyOn(window, "open");

		const { printReceiptOffline } = usePrintInvoice();
		await expect(printReceiptOffline(snapshot)).resolves.toBe(true);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("explains, rather than printing a blank page, when no layout is cached", async () => {
		getCachedReceiptContext.mockResolvedValue(null);
		const { printReceiptOffline } = usePrintInvoice();

		await expect(printReceiptOffline(snapshot)).resolves.toBe(false);

		expect(lastFrame()).toBeNull();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("not available offline"));
	});

	it("reports a failure to read the cache instead of throwing", async () => {
		getCachedReceiptContext.mockRejectedValue(new Error("IndexedDB unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { printReceiptOffline } = usePrintInvoice();

		await expect(printReceiptOffline(snapshot)).resolves.toBe(false);
		expect(showError).toHaveBeenCalledWith("Failed to print invoice");
	});
});

/**
 * The receipt's scan code (MuleCity-gt9l; URL form MuleCity-dykb): the site's URL for the
 * sale, from the print brand cached online. Before sync it names the local id the sale
 * syncs with; once the desktop app's queue row has the server's name, the invoice.
 */
describe("offline receipt scan code", () => {
	const SITE = "https://erp.mulecity.com";
	const branded: ReceiptContext = {
		...context,
		brand: {
			company_name: "Acme Store",
			address_line: "",
			phone: "",
			website: "",
			logo_url: "",
			footer_text: "",
			accent_color: "",
			scan_base_url: SITE,
		},
	};

	afterEach(() => {
		delete (window as any).electronAPI;
		delete (window as any).xpos;
	});

	it("prints the queued sale's local id as its scan URL", async () => {
		getCachedReceiptContext.mockResolvedValue(branded);
		const { printReceiptOffline } = usePrintInvoice();

		await printReceiptOffline({ ...snapshot, xpos_local_id: "inv_7_abc" });

		expect(lastFrame()!.srcdoc).toContain(`data-scan-url="${SITE}/s/XPOS/inv_7_abc"`);
	});

	function desktopQueueRow(row: Record<string, unknown>) {
		const printReport = vi.fn().mockResolvedValue({ success: true });
		(window as any).electronAPI = {
			db: {
				getPendingInvoice: vi.fn().mockResolvedValue({
					id: 9,
					local_id: "inv_9_xyz",
					data: { receipt: { ...snapshot, name: "" } },
					...row,
				}),
			},
			print: { printReport },
		};
		return printReport;
	}

	it("the desktop app's local print reads the local id from the queue row", async () => {
		getCachedReceiptContext.mockResolvedValue(branded);
		const printReport = desktopQueueRow({ status: "pending", server_name: null });
		const { printInvoiceLocal } = usePrintInvoice();
		await printInvoiceLocal(9);
		const html = printReport.mock.calls[0][0] as string;
		expect(html).toContain("LOCAL-9");
		expect(html).toContain(`data-scan-url="${SITE}/s/XPOS/inv_9_xyz"`);
	});

	it("the desktop app's local print of a synced sale names its Sales Invoice", async () => {
		getCachedReceiptContext.mockResolvedValue(branded);
		(window as any).xpos = { boot: { pos_settings: { invoice_type: "Sales Invoice" } } };
		const printReport = desktopQueueRow({ status: "synced", server_name: "ACC-SINV-49041" });
		const { printInvoiceLocal } = usePrintInvoice();
		await printInvoiceLocal(9);
		const html = printReport.mock.calls[0][0] as string;
		expect(html).toContain(`data-scan-url="${SITE}/s/SI/ACC-SINV-49041"`);
		expect(html).toContain("width:0.8in");
	});

	it("a site that makes POS Invoices keeps the local id (the router resolves it)", async () => {
		getCachedReceiptContext.mockResolvedValue(branded);
		(window as any).xpos = { boot: { pos_settings: { invoice_type: "POS Invoice" } } };
		const printReport = desktopQueueRow({ status: "synced", server_name: "ACC-PSINV-1" });
		const { printInvoiceLocal } = usePrintInvoice();
		await printInvoiceLocal(9);
		expect(printReport.mock.calls[0][0] as string).toContain(`data-scan-url="${SITE}/s/XPOS/inv_9_xyz"`);
	});

	it("prints the receipt without a code when the cached brand has no https site URL", async () => {
		getCachedReceiptContext.mockResolvedValue(context);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { printReceiptOffline } = usePrintInvoice();
		try {
			await expect(printReceiptOffline({ ...snapshot, xpos_local_id: "inv_7_abc" })).resolves.toBe(true);
			expect(lastFrame()!.srcdoc).not.toContain("mule-scan");
		} finally {
			warn.mockRestore();
		}
	});
});
