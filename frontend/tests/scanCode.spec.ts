import { describe, expect, it } from "vitest";
import {
	BinaryBitmap,
	HybridBinarizer,
	QRCodeReader,
	ResultMetadataType,
	RGBLuminanceSource,
} from "@zxing/library";
import {
	encodeScanPayload,
	offlineScanPayload,
	scanCodeBlockHtml,
	scanCodeMatrix,
	scanCodeSvg,
} from "@/services/scanCode";
import { buildReceiptHtml, receiptScanCode } from "@/services/receiptTemplate";
import type { ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";

/**
 * The receipt scan code (MuleCity-gt9l). Payloads must equal the Mule app's
 * mule_documents/scan_code.py encode_payload, which the Scan Inbox parses.
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

describe("scan payloads", () => {
	it("names a submitted invoice as the app does", () => {
		expect(encodeScanPayload("Sales Invoice", "ACC-SINV-2026-00042")).toBe(
			"MCDOC1:Sales Invoice:ACC-SINV-2026-00042",
		);
		expect(encodeScanPayload(" Sales Invoice ", " ACC-SINV-2026-00042 ")).toBe(
			"MCDOC1:Sales Invoice:ACC-SINV-2026-00042",
		);
	});

	it("names an offline sale by the local id it syncs with", () => {
		expect(offlineScanPayload("inv_1759760000000_k3j2abcde")).toBe("MCDOC1:XPOS:inv_1759760000000_k3j2abcde");
	});

	it("refuses what the app refuses", () => {
		expect(() => encodeScanPayload("", "X")).toThrow();
		expect(() => encodeScanPayload("Sales Invoice", " ")).toThrow();
		expect(() => encodeScanPayload("A:B", "X")).toThrow();
	});
});

describe("scan QR", () => {
	it.each([
		"MCDOC1:Sales Invoice:ACC-SINV-2026-00042",
		"MCDOC1:XPOS:inv_1759760000000_k3j2abcde",
	])("decodes back to %s, byte mode, ECC M", (payload) => {
		const result = decodeSvg(scanCodeSvg(payload));
		expect(result.getText()).toBe(payload);
		expect(result.getResultMetadata().get(ResultMetadataType.ERROR_CORRECTION_LEVEL)).toBe("M");
		// A byte-mode segment carries exactly the payload's bytes.
		expect(byteSegments(result)).toEqual(utf8(payload));
	});

	it("encodes a non-ASCII name as UTF-8 bytes", () => {
		const payload = encodeScanPayload("Sales Invoice", "Café-1");
		expect(byteSegments(decodeSvg(scanCodeSvg(payload)))).toEqual(utf8(payload));
	});

	it("draws a 4-module quiet zone inside its viewBox", () => {
		const payload = offlineScanPayload("inv_1");
		const size = scanCodeMatrix(payload).length;
		const svg = scanCodeSvg(payload);
		expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`);
		const coords = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].flatMap(([, x, y]) => [Number(x), Number(y)]);
		expect(Math.min(...coords)).toBe(4);
		expect(Math.max(...coords)).toBe(size + 3);
	});

	it("is 0.8in square, quiet zone included", () => {
		const html = scanCodeBlockHtml("MCDOC1:XPOS:inv_1", "inv_1");
		expect(html).toContain('class="mule-scan-code" style="width:0.8in;height:0.8in;');
		expect(html).toContain('width="100%" height="100%"');
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

describe("receipt scan block", () => {
	it("prints the offline code top-right of the receipt, with a short caption that does not wrap", () => {
		const html = buildReceiptHtml({ ...snapshot, xpos_local_id: "inv_1759760000000_k3j2abcde" }, context);
		const doc = new DOMParser().parseFromString(html, "text/html");
		// The head's right-hand slot, as on the Mule City Ticket (MuleCity-mon6).
		const cell = doc.querySelector(".mule-head .mule-head-code")!;
		const block = cell.firstElementChild as HTMLElement;
		expect(block.className).toBe("mule-scan-block");
		expect(block.dataset.scanPayload).toBe("MCDOC1:XPOS:inv_1759760000000_k3j2abcde");
		const label = block.querySelector(".mule-scan-label") as HTMLElement;
		expect(label.textContent).toBe("Offline sale \u00b7 \u20263j2abcde");
		expect(label.style.whiteSpace).toBe("nowrap");
		expect(block.querySelector(".mule-scan-code svg")).not.toBeNull();
		// It is the receipt's only scan code (one copy per receipt).
		expect(doc.querySelectorAll(".mule-scan-block")).toHaveLength(1);
		// The QR still carries the whole local id.
		expect(decodeSvg(block.querySelector(".mule-scan-code")!.innerHTML).getText()).toBe(
			"MCDOC1:XPOS:inv_1759760000000_k3j2abcde",
		);
	});

	it("keeps a short local id whole", () => {
		expect(receiptScanCode({ ...snapshot, xpos_local_id: "inv_1" })!.label).toBe("Offline sale \u00b7 inv_1");
	});

	it("names the invoice once the receipt knows it", () => {
		const scan = receiptScanCode({
			...snapshot,
			xpos_local_id: "inv_1",
			scan_doc: { doctype: "Sales Invoice", name: "ACC-SINV-2026-00042" },
		});
		expect(scan).toEqual({ payload: "MCDOC1:Sales Invoice:ACC-SINV-2026-00042", label: "ACC-SINV-2026-00042" });
	});

	it("prints no code when the receipt knows neither", () => {
		expect(receiptScanCode(snapshot)).toBeNull();
		expect(buildReceiptHtml(snapshot, context)).not.toContain("mule-scan");
	});
});
