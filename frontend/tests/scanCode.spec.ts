import { describe, expect, it, vi } from "vitest";
import {
	BinaryBitmap,
	HybridBinarizer,
	QRCodeReader,
	ResultMetadataType,
	RGBLuminanceSource,
} from "@zxing/library";
import {
	OFFLINE_SCAN_ALIAS,
	quoteScanName,
	scanAlias,
	scanBaseUrl,
	scanCodeBlockHtml,
	scanCodeMatrix,
	scanCodeSize,
	scanCodeSvg,
	scanUrl,
} from "@/services/scanCode";
import { buildReceiptHtml, receiptScanCode } from "@/services/receiptTemplate";
import type { ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";
import fixtures from "./fixtures/scan_urls.json";

/**
 * The receipt scan code (MuleCity-gt9l, URL form MuleCity-dykb). The QR holds an https URL
 * to the document on the site's own domain, `<base>/s/<ALIAS>/<name>`, exactly the strings
 * the Mule app's test_scan_url pins (tests/fixtures/scan_urls.json, shared).
 */

/** Read the printed SVG back into a bitmap (4 px per module) and decode it with ZXing. */
function decodeSvg(svg: string) {
	const span = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)![1]);
	const scale = 4;
	const width = span * scale;
	const pixels = new Uint8ClampedArray(width * width).fill(255);
	for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
		for (let dy = 0; dy < scale; dy++) {
			for (let dx = 0; dx < scale; dx++) {
				pixels[(Number(y) * scale + dy) * width + Number(x) * scale + dx] = 0;
			}
		}
	}
	const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, width)));
	return new QRCodeReader().decode(bitmap);
}

/** The decoded byte-mode segments' bytes (plain numbers: jsdom and Node typed arrays differ). */
function byteSegments(result: ReturnType<typeof decodeSvg>): number[] {
	const segments = result.getResultMetadata().get(ResultMetadataType.BYTE_SEGMENTS) as Uint8Array[];
	return segments.flatMap((segment) => Array.from(segment));
}

function utf8(text: string): number[] {
	return Array.from(new TextEncoder().encode(text));
}

const PROD = "https://erp.mulecity.com";
const LONG_LOCAL_ID = "inv_ae237dd89957a8ef76859669d512b6b1";

describe("scan URLs (shared with the app's test_scan_url)", () => {
	it.each(fixtures.urls)("$url", ({ base, alias, name, url, size }) => {
		expect(scanUrl(base, alias, name)).toBe(url);
		expect(scanCodeSize(url)).toBe(size);
	});

	it.each(fixtures.refused_bases)("refuses the base %j: no code rather than a wrong one", (base) => {
		expect(scanBaseUrl(base)).toBeNull();
		expect(() => scanUrl(base, "SI", "ACC-SINV-1")).toThrow();
	});

	it("takes the site's origin, with or without a trailing slash", () => {
		expect(scanBaseUrl("https://erp.mulecity.com/")).toBe(PROD);
		expect(scanBaseUrl(" https://ERP.mulecity.com ")).toBe(PROD);
		expect(scanBaseUrl("https://erp.mulecity.com:8443")).toBe("https://erp.mulecity.com:8443");
	});

	it("quotes a name like frappe.utils.quoted", () => {
		// safe=b"~@#$&()*!+=:;,.?/'" plus Python's always-safe letters, digits and _.-~
		expect(quoteScanName("A-Z_a.z~0@#$&()*!+=:;,?/'")).toBe("A-Z_a.z~0@#$&()*!+=:;,?/'");
		expect(quoteScanName("a b%c\"d<é")).toBe("a%20b%25c%22d%3C%C3%A9");
		expect(scanUrl(PROD, "SI", "  ACC-SINV-1  ")).toBe(`${PROD}/s/SI/ACC-SINV-1`);
	});

	it("refuses an unknown or lowercase alias and an empty name", () => {
		expect(() => scanUrl(PROD, "si", "X")).toThrow();
		expect(() => scanUrl(PROD, "S I", "X")).toThrow();
		expect(() => scanUrl(PROD, "SI", " ")).toThrow();
	});

	it("knows the aliases XPOS prints", () => {
		expect(scanAlias("Sales Invoice")).toBe("SI");
		expect(scanAlias("POS Invoice")).toBeNull();
		expect(OFFLINE_SCAN_ALIAS).toBe("XPOS");
	});

	it("never prints the retired MCDOC1 form", async () => {
		const mod = await import("@/services/scanCode");
		expect(Object.keys(mod)).not.toContain("encodeScanPayload");
		expect(Object.keys(mod)).not.toContain("offlineScanPayload");
	});
});

describe("scan QR", () => {
	it.each([`${PROD}/s/SI/ACC-SINV-49041`, `${PROD}/s/XPOS/${LONG_LOCAL_ID}`])(
		"decodes back to %s, byte mode, ECC M",
		(url) => {
			const result = decodeSvg(scanCodeSvg(url));
			expect(result.getText()).toBe(url);
			expect(result.getResultMetadata().get(ResultMetadataType.ERROR_CORRECTION_LEVEL)).toBe("M");
			// A byte-mode segment carries exactly the URL's bytes.
			expect(byteSegments(result)).toEqual(utf8(url));
		},
	);

	it("is version 4 for an invoice URL and version 5 for the long offline URL", () => {
		// Version v is 17 + 4v modules wide (design A5).
		expect(scanCodeMatrix(`https://erp.nmc-atelier.com/s/SI/ACC-SINV-43575-1`)).toHaveLength(33);
		expect(scanCodeMatrix(`https://erp.nmc-atelier.com/s/XPOS/${LONG_LOCAL_ID}`)).toHaveLength(37);
	});

	it("draws a 4-module quiet zone inside its viewBox", () => {
		const url = scanUrl(PROD, "XPOS", "inv_1");
		const size = scanCodeMatrix(url).length;
		const svg = scanCodeSvg(url);
		expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`);
		const coords = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].flatMap(([, x, y]) => [Number(x), Number(y)]);
		expect(Math.min(...coords)).toBe(4);
		expect(Math.max(...coords)).toBe(size + 3);
	});

	it("is 0.8in square for an invoice and 0.9in for the long offline URL, quiet zone included", () => {
		const si = scanCodeBlockHtml(`${PROD}/s/SI/ACC-SINV-49041`, "ACC-SINV-49041");
		expect(si).toContain('class="mule-scan-code" style="width:0.8in;height:0.8in;');
		expect(si).toContain('width="100%" height="100%"');
		const xpos = scanCodeBlockHtml(`${PROD}/s/XPOS/${LONG_LOCAL_ID}`, "Offline sale");
		expect(xpos).toContain('class="mule-scan-code" style="width:0.9in;height:0.9in;');
	});
});

const context: ReceiptContext = {
	company_name: "Mule City",
	company_phone: "",
	company_email: "",
	company_website: "",
	company_address: "",
	company_tax_id: "",
	company_logo: "",
	receipt_header: "",
	receipt_footer: "",
	currency: "USD",
	print_discount_amount: 0,
	print_format: "Mule City Ticket",
	css: "",
};

const snapshot: ReceiptSnapshot = {
	name: "OFFLINE-7",
	posting_date: "2026-10-06",
	posting_time: "09:15:00",
	is_return: false,
	cashier: "LE",
	customer_name: "Walk-in Customer",
	items: [{ item_code: "CORN", item_name: "Cracked Corn", qty: 1, rate: 12, amount: 12 }],
	taxes: [],
	payments: [{ mode_of_payment: "Cash", amount: 12 }],
	subtotal: 12,
	total_discount: 0,
	net_total: 12,
	grand_total: 12,
	total_qty: 1,
	change: 0,
};

/** The receipt context as cached online: Mule City's print brand carries the site's URL. */
const branded: ReceiptContext = {
	...context,
	brand: {
		company_name: "Mule City",
		address_line: "",
		phone: "",
		website: "mulecity.com",
		logo_url: "",
		footer_text: "",
		accent_color: "",
		scan_base_url: PROD,
	},
};

describe("receipt scan block", () => {
	it("prints the offline code top-right of the receipt, with a short caption that does not wrap", () => {
		const html = buildReceiptHtml({ ...snapshot, xpos_local_id: LONG_LOCAL_ID }, branded);
		const doc = new DOMParser().parseFromString(html, "text/html");
		// The head's right-hand slot, as on the Mule City Ticket (MuleCity-mon6).
		const cell = doc.querySelector(".mule-head .mule-head-code")!;
		const block = cell.firstElementChild as HTMLElement;
		expect(block.className).toBe("mule-scan-block");
		expect(block.dataset.scanUrl).toBe(`${PROD}/s/XPOS/${LONG_LOCAL_ID}`);
		const label = block.querySelector(".mule-scan-label") as HTMLElement;
		expect(label.textContent).toBe("Offline sale \u00b7 \u2026d512b6b1");
		expect(label.style.whiteSpace).toBe("nowrap");
		const code = block.querySelector(".mule-scan-code") as HTMLElement;
		expect(code.style.width).toBe("0.9in");
		expect(code.querySelector("svg")).not.toBeNull();
		// It is the receipt's only scan code (one copy per receipt).
		expect(doc.querySelectorAll(".mule-scan-block")).toHaveLength(1);
		// The QR carries the whole URL, local id included.
		expect(decodeSvg(code.innerHTML).getText()).toBe(`${PROD}/s/XPOS/${LONG_LOCAL_ID}`);
		expect(html).not.toContain("MCDOC");
	});

	it("keeps a short local id whole", () => {
		expect(receiptScanCode({ ...snapshot, xpos_local_id: "inv_1" }, PROD)!.label).toBe("Offline sale \u00b7 inv_1");
	});

	it("names the invoice once the receipt knows it: /s/SI/, 0.8in", () => {
		const named = {
			...snapshot,
			xpos_local_id: "inv_1",
			scan_doc: { doctype: "Sales Invoice", name: "ACC-SINV-49041" },
		};
		expect(receiptScanCode(named, PROD)).toEqual({
			url: `${PROD}/s/SI/ACC-SINV-49041`,
			label: "ACC-SINV-49041",
		});
		const doc = new DOMParser().parseFromString(buildReceiptHtml(named, branded), "text/html");
		const code = doc.querySelector(".mule-scan-code") as HTMLElement;
		expect(code.style.width).toBe("0.8in");
		expect(decodeSvg(code.innerHTML).getText()).toBe(`${PROD}/s/SI/ACC-SINV-49041`);
	});

	it("falls back to the local id when the invoice's doctype has no alias", () => {
		const scan = receiptScanCode(
			{ ...snapshot, xpos_local_id: "inv_1", scan_doc: { doctype: "POS Invoice", name: "ACC-PSINV-1" } },
			PROD,
		);
		expect(scan!.url).toBe(`${PROD}/s/XPOS/inv_1`);
	});

	it("prints no code when the receipt knows neither", () => {
		expect(receiptScanCode(snapshot, PROD)).toBeNull();
		expect(buildReceiptHtml(snapshot, branded)).not.toContain("mule-scan");
	});

	it.each([
		["no brand (an older app)", context],
		["no scan_base_url", { ...branded, brand: { ...branded.brand!, scan_base_url: "" } }],
		["an http base", { ...branded, brand: { ...branded.brand!, scan_base_url: "http://erp.mulecity.com" } }],
		["a ZeroTier IP", { ...branded, brand: { ...branded.brand!, scan_base_url: "https://10.147.17.5" } }],
	])("prints no code, and says so, with %s", (_why, ctx) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// jsdom's own origin (http://localhost:3000) is not https either, so it is refused too.
			const html = buildReceiptHtml({ ...snapshot, xpos_local_id: "inv_1" }, ctx as ReceiptContext);
			expect(html).not.toContain("mule-scan");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("scan code"));
		} finally {
			warn.mockRestore();
		}
	});
});
