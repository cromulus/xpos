/**
 * The scan code printed on a till receipt (MuleCity-gt9l, part of MuleCity-gytr).
 *
 * Why: Bill 2026-10-06: every printed document that goes out and comes back
 * (signed, returned) carries a QR code so the scanned page files itself onto
 * the record it was printed from. The Mule app's Scan Inbox reads the code.
 *
 * What: the QR's text is the Mule app's `MCDOC1:<doctype>:<name>` (its
 * `mule_documents/scan_code.py` encode_payload; this module must produce the same
 * string). A receipt printed before the sale reached ERPNext has no server name, so it
 * carries `MCDOC1:XPOS:<local_id>`, the id the offline queue sends as `local_id` and the
 * server stores as `xpos_local_id`; the app resolves it to the invoice after sync.
 * No URL and no checksum. The QR is ECC level M, byte mode (UTF-8 bytes, no ECI), with a
 * 4-module quiet zone, drawn 0.8in square including the quiet zone: the store's Ricoh
 * scans at 200 dpi, so it must not print smaller.
 */
import QRCode from "qrcode";

export const SCAN_PREFIX = "MCDOC";
export const SCAN_VERSION = "1";
/** The pseudo-doctype of a receipt printed before its sale has a server name. */
export const OFFLINE_SCAN_DOCTYPE = "XPOS";
export const SCAN_QUIET_ZONE = 4;
export const SCAN_CODE_SIZE = "0.8in";

/** `MCDOC1:<doctype>:<name>`, exactly as the app's encode_payload builds it. */
export function encodeScanPayload(doctype: string, name: string): string {
	const dt = String(doctype ?? "").trim();
	const nm = String(name ?? "").trim();
	if (!dt || !nm) throw new Error("A scan code needs a document type and a name");
	if (dt.includes(":")) throw new Error(`Document type '${dt}' cannot contain ':'`);
	return `${SCAN_PREFIX}${SCAN_VERSION}:${dt}:${nm}`;
}

/** The code of a sale queued offline: `MCDOC1:XPOS:<local_id>`. */
export function offlineScanPayload(localId: string): string {
	return encodeScanPayload(OFFLINE_SCAN_DOCTYPE, localId);
}

/**
 * The QR's dark modules, row by row, without the quiet zone.
 * One byte-mode segment of the payload's UTF-8 bytes, ECC level M, smallest version.
 */
export function scanCodeMatrix(payload: string): boolean[][] {
	const bytes = new TextEncoder().encode(payload);
	const qr = QRCode.create([{ data: new Uint8ClampedArray(bytes), mode: "byte" }], {
		errorCorrectionLevel: "M",
	});
	const size = qr.modules.size;
	const rows: boolean[][] = [];
	for (let r = 0; r < size; r++) {
		const row: boolean[] = [];
		for (let c = 0; c < size; c++) row.push(!!qr.modules.get(r, c));
		rows.push(row);
	}
	return rows;
}

/**
 * The QR as an inline SVG filling its box. The viewBox includes the quiet zone, so
 * a `size` box holds the whole code, quiet zone included.
 */
export function scanCodeSvg(payload: string): string {
	const matrix = scanCodeMatrix(payload);
	const span = matrix.length + 2 * SCAN_QUIET_ZONE;
	let path = "";
	matrix.forEach((row, r) => {
		row.forEach((dark, c) => {
			if (dark) path += `M${c + SCAN_QUIET_ZONE} ${r + SCAN_QUIET_ZONE}h1v1h-1z`;
		});
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="100%" height="100%" ` +
		`shape-rendering="crispEdges" data-quiet-zone="${SCAN_QUIET_ZONE}">` +
		`<rect width="${span}" height="${span}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
	);
}

function esc(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The receipt's scan block: a short caption beside the QR. Inline styles, so the block
 * reads the same wherever it is placed. The caption never wraps (MuleCity-mon6): an
 * offline sale's caption is short ("Offline sale · …k3j2abcd"); the QR carries the full id.
 */
export function scanCodeBlockHtml(payload: string, label: string): string {
	return `<div class="mule-scan-block" data-scan-payload="${esc(payload)}" style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
        <div class="mule-scan-label" style="font-size:10px;font-weight:700;text-align:right;white-space:nowrap;line-height:1.2;">${esc(label)}</div>
        <div class="mule-scan-code" style="width:${SCAN_CODE_SIZE};height:${SCAN_CODE_SIZE};flex:0 0 ${SCAN_CODE_SIZE};">${scanCodeSvg(payload)}</div>
    </div>`;
}
