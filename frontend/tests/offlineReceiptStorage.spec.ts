/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { InvoiceData, ReceiptSnapshot } from "@/types/pos.types";

const { bridge, call, online } = vi.hoisted(() => ({
	bridge: {
		addPendingInvoice: vi.fn(),
		getAllPendingInvoices: vi.fn(),
		updatePendingInvoice: vi.fn(),
		deletePendingInvoice: vi.fn(),
		countPendingInvoices: vi.fn(),
		countDeadLetters: vi.fn(),
		retryDeadLetter: vi.fn(),
		adjustCachedStock: vi.fn(),
		cachePOSData: vi.fn(),
		getCachedPOSData: vi.fn(),
		cacheReceiptContext: vi.fn(),
		getCachedReceiptContext: vi.fn(),
		cacheTaxContexts: vi.fn(),
		setSyncMeta: vi.fn(),
		getSyncMeta: vi.fn(),
	},
	call: vi.fn(),
	online: { value: true },
}));

vi.mock("@/services/dbBridge", () => bridge);
vi.mock("@/services/api", () => ({
	call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/utils", () => ({
	isOnline: () => online.value,
	isNetworkError: () => false,
}));
vi.mock("@/stores/settingsStore", () => ({
	useSettingsStore: () => ({ fetchSettings: vi.fn().mockResolvedValue(undefined), reset: vi.fn() }),
}));
vi.mock("@/stores/itemStore", () => ({
	useItemStore: () => ({ cacheAllItems: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/stores/customerStore", () => ({
	useCustomerStore: () => ({ cacheAllCustomers: vi.fn().mockResolvedValue(undefined) }),
}));

import { useOfflineStore } from "@/stores/offlineStore";
import { usePosStore } from "@/stores/posStore";

const invoiceData = { customer: "Walk-in Customer", items: [] } as unknown as InvoiceData;
const receipt = { name: "", grand_total: 10, items: [] } as unknown as ReceiptSnapshot;
const receiptContext: Record<string, unknown> = { company_name: "Acme Store", css: "" };
/** What mulecity_erpnext.printouts.print_brand answers (MuleCity-kht3.2); null: an older app without it. */
let printBrand: Record<string, string> | null = null;

/** Wait for the fire-and-forget work openShift/checkShift start. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function mockServer(profile: Record<string, unknown>) {
	call.mockImplementation(async (method: string) => {
		switch (method) {
			case "xpos.api.shifts.open_shift":
			case "xpos.api.shifts.check_open_shift":
				return {
					pos_opening_shift: { name: "POS-OPE-0001" },
					pos_profile: { name: "Shop Floor", ...profile },
					company: "Acme",
					print_settings: { print_format: "XPOS Thermal Receipt" },
				};
			case "xpos.api.print_formats.get_receipt_context":
				return { ...receiptContext };
			case "mulecity_erpnext.printouts.print_brand":
				if (!printBrand) throw new Error("Failed to get method for command mulecity_erpnext.printouts.print_brand");
				return printBrand;
			default:
				return [];
		}
	});
}

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	printBrand = null;
	bridge.getCachedReceiptContext.mockResolvedValue(null);
	online.value = true;
	globalThis.__ = ((text: string) => text) as any;
	bridge.addPendingInvoice.mockResolvedValue({ id: 7, local_id: "inv_7" });
	bridge.getAllPendingInvoices.mockResolvedValue([]);
	bridge.countPendingInvoices.mockResolvedValue(0);
	bridge.countDeadLetters.mockResolvedValue(0);
});

describe("offline invoice queue", () => {
	it("stores the receipt with the queued invoice", async () => {
		const store = useOfflineStore();

		const result = await store.saveOffline(invoiceData, "Walk-in Customer", 10, [], receipt);

		// xposLocalId: the id the sale syncs with, for the receipt scan code (MuleCity-gt9l).
		expect(result).toEqual({ success: true, localId: 7, xposLocalId: "inv_7" });
		expect(bridge.addPendingInvoice).toHaveBeenCalledWith({
			data: invoiceData,
			customer_name: "Walk-in Customer",
			grand_total: 10,
			receipt,
		});
	});

	it("sends only the invoice to the server when it syncs, never the receipt", async () => {
		bridge.getAllPendingInvoices.mockResolvedValue([
			{ id: 7, local_id: "inv_7", data: invoiceData, receipt, status: "pending", retry_count: 0 },
		]);
		call.mockResolvedValue({ name: "ACC-SINV-0001" });
		const store = useOfflineStore();
		store.isOnline = true as any;

		await store.syncPendingInvoices();

		const syncCall = call.mock.calls.find(([method]) => method === "xpos.api.invoices.create_invoice");
		expect(syncCall).toBeDefined();
		expect(syncCall![1]).toEqual({ data: JSON.stringify(invoiceData), local_id: "inv_7" });
		expect(syncCall![1].data).not.toContain("receipt");
		expect(bridge.deletePendingInvoice).toHaveBeenCalledWith(7);
	});
});

describe("receipt layout cache (browser)", () => {
	it("is filled when a shift opens on an offline-mode profile", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();

		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();

		expect(call).toHaveBeenCalledWith("xpos.api.print_formats.get_receipt_context", {
			pos_profile: "Shop Floor",
			print_format: expect.any(String),
		});
		expect(bridge.cacheReceiptContext).toHaveBeenCalledWith("Shop Floor", receiptContext);
	});

	it("is filled when an already-open shift is resumed on an offline-mode profile", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();

		await posStore.checkExistingShift();
		await settle();

		expect(bridge.cacheReceiptContext).toHaveBeenCalledWith("Shop Floor", receiptContext);
	});

	it("is left alone when the profile does not use offline mode", async () => {
		mockServer({ use_offline_mode: 0 });
		const posStore = usePosStore();

		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();

		expect(call).not.toHaveBeenCalledWith(
			"xpos.api.print_formats.get_receipt_context",
			expect.anything(),
		);
		expect(bridge.cacheReceiptContext).not.toHaveBeenCalled();
	});

	it("is not refreshed while offline", async () => {
		mockServer({ use_offline_mode: 1 });
		const posStore = usePosStore();
		await posStore.openShift("Shop Floor", "Acme", []);
		await settle();
		vi.clearAllMocks();

		online.value = false;
		posStore.posProfile = { name: "Shop Floor", use_offline_mode: 1 } as any;
		await posStore.openShift("Shop Floor", "Acme", []).catch(() => {});
		await settle();

		expect(bridge.cacheReceiptContext).not.toHaveBeenCalled();
	});
});

/**
 * MuleCity-mon6: each online start caches Mule City's print brand with the receipt layout,
 * and its logo as a data URI, so a receipt printed after an offline cold start shows it.
 */
describe("print brand cache (Mule City, MuleCity-mon6)", () => {
	const BRAND = {
		company_name: "Mule City Specialty Feeds",
		address_line: "1202 N Wall St, Benson, NC 27504",
		phone: "919-894-3626",
		website: "mulecity.com",
		logo_url: "",
		footer_text: "",
		accent_color: "",
		// The site's own URL, for the receipt's scan code (MuleCity-dykb).
		scan_base_url: "https://erp.mulecity.com",
	};
	const cachedContext = () => bridge.cacheReceiptContext.mock.calls.at(-1)?.[1] as Record<string, any>;

	it("caches the brand with the receipt layout", async () => {
		printBrand = { ...BRAND };
		mockServer({ use_offline_mode: 1 });
		await usePosStore().openShift("Shop Floor", "Acme", []);
		await settle();

		expect(call).toHaveBeenCalledWith("mulecity_erpnext.printouts.print_brand", {}, undefined, expect.any(Object));
		expect(cachedContext().brand).toEqual(BRAND);
	});

	it("caches an empty scan_base_url from an app that does not send it (MuleCity-dykb)", async () => {
		const { scan_base_url: _omit, ...older } = BRAND;
		printBrand = { ...older };
		mockServer({ use_offline_mode: 1 });
		await usePosStore().openShift("Shop Floor", "Acme", []);
		await settle();

		expect(cachedContext().brand).toEqual({ ...BRAND, scan_base_url: "" });
	});

	it("fetches a set logo once and keeps it as a data URI", async () => {
		printBrand = { ...BRAND, logo_url: "https://erp.example.test/files/print-logo.png" };
		const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
		// jsdom's Blob does not survive Node's Response, so answer with the blob directly.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue({ ok: true, blob: async () => png } as unknown as Response);
		try {
			mockServer({ use_offline_mode: 1 });
			await usePosStore().openShift("Shop Floor", "Acme", []);
			await settle();
			await settle();

			expect(fetchSpy).toHaveBeenCalledWith("https://erp.example.test/files/print-logo.png", expect.any(Object));
			expect(cachedContext().brand.logo_data_uri).toMatch(/^data:image\/png;base64,/);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("keeps the brand cached last time when print_brand cannot answer", async () => {
		const previous = { ...BRAND, logo_url: "https://x.test/l.png", logo_data_uri: "data:image/png;base64,AAAA" };
		bridge.getCachedReceiptContext.mockResolvedValue({ company_name: "Acme Store", brand: previous });
		printBrand = null;
		mockServer({ use_offline_mode: 1 });
		await usePosStore().openShift("Shop Floor", "Acme", []);
		await settle();

		expect(cachedContext().brand).toEqual(previous);
	});

	it("caches no brand on a site without print_brand (the receipt prints the name in type)", async () => {
		printBrand = null;
		mockServer({ use_offline_mode: 1 });
		await usePosStore().openShift("Shop Floor", "Acme", []);
		await settle();

		expect(cachedContext()).toEqual(receiptContext);
		expect(cachedContext().brand).toBeUndefined();
	});
});

describe("offline tax cache (Mule City, MuleCity-ispl)", () => {
	// Found on erp2: the periodic sync only starts caching taxes five minutes after
	// the till opens, so a till that went offline sooner had none. Opening or
	// resuming a shift now caches each tax category's taxes with items and customers.
	it.each([
		["opens", (pos: ReturnType<typeof usePosStore>) => pos.openShift("Shop Floor", "Acme", [])],
		["is resumed", (pos: ReturnType<typeof usePosStore>) => pos.checkExistingShift()],
	])("is filled when a shift %s on an offline-mode profile", async (_when, start) => {
		mockServer({ use_offline_mode: 1 });
		await start(usePosStore());
		await settle();
		await settle();

		expect(call).toHaveBeenCalledWith("mulecity_erpnext.pos_workspace.tax_contexts", { pos_profile: "Shop Floor" });
	});
});

vi.mock("@/services/vfdOffline", () => ({ attachOfflineCoverage: vi.fn(), refreshVfdContext: vi.fn(), queuedInvoiceMethod: () => "xpos.api.invoices.create_invoice" }));
