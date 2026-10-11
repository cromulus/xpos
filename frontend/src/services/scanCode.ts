/**
 * The scan code printed on a till receipt (MuleCity-gt9l; URL form MuleCity-dykb).
 *
 * Why: Bill 2026-10-06: every printed document that goes out and comes back
 * (signed, returned) carries a QR code so the scanned page files itself onto
 * the record it was printed from. Bill 2026-10-11: the code is a URL to that document
 * on the site's own domain, so a phone opens it too (the app's `/s/` router sends
 * staff to the desk record, a customer to the portal copy, anyone else to log in
 * and back), and the app's Scan Inbox decodes the same URL offline.
 *
 * What: the QR's text is exactly `<base>/s/<ALIAS>/<name>` (docs/erpnext/
 * scan-redesign-design.md A1 and E): https, the site's origin, no query, no
 * checksum, no version prefix (the `/s/` route is the version). `<name>` is quoted
 * like frappe.utils.quoted. A receipt whose sale has its ERPNext name prints
 * `/s/SI/<invoice name>`; one printed before the sale reached ERPNext prints
 * `/s/XPOS/<xpos_local_id>`, the id the offline queue sends as `local_id` and the
 * server stores as `xpos_local_id`; the router resolves it after sync.
 * `<base>` is the site URL cached with Mule City's print brand (`scan_base_url`); a
 * base that is not a plain https origin (http, localhost, an IP such as the ZeroTier
 * address, a path) is refused: no code rather than a wrong one.
 * The QR is ECC level M, byte mode (UTF-8 bytes, no ECI), with a 4-module quiet
 * zone. The box (quiet zone included) is the smallest of 0.8in, 0.9in, ... whose
 * modules are at least 0.49 mm: 0.8in for an invoice URL (version 4), 0.9in for the
 * long offline URL (version 5). The store's Ricoh scans at 200 dpi.
 * The MCDOC1 text form (mc39) is retired: nothing was ever printed with it.
 */
import QRCode from "qrcode";

/** The app's alias for each doctype a receipt can name (mule_documents/scan_code.py ALIASES). */
export const SCAN_ALIASES: Readonly<Record<string, string>> = Object.freeze({ "Sales Invoice": "SI" });
/** The alias of a receipt printed before its sale has a server name. */
export const OFFLINE_SCAN_ALIAS = "XPOS";
export const SCAN_QUIET_ZONE = 4;
/** The smallest printed box, and the step it grows by. */
export const SCAN_CODE_MIN_IN = 0.8;
const SCAN_CODE_STEP_IN = 0.1;
/** The smallest module the scanner reads reliably (design A5). */
export const SCAN_MIN_MODULE_MM = 0.49;

/** The alias the app routes `doctype` by, or null when it has none. */
export function scanAlias(doctype: string): string | null {
	return SCAN_ALIASES[String(doctype ?? "").trim()] ?? null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The site origin a scan URL starts with, or null when `base` is not a plain https
 * origin: http, no scheme, credentials, a path, query or fragment, localhost or an IP
 * address. A trailing slash is fine.
 */
export function scanBaseUrl(base: unknown): string | null {
	const text = typeof base === "string" ? base.trim() : "";
	if (!/^https:\/\//i.test(text)) return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	if (url.pathname !== "/" || url.search || url.hash) return null;
	const host = url.hostname.toLowerCase();
	if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
	if (IPV4.test(host) || host.startsWith("[")) return null;
	return url.origin;
}

/** frappe.utils.quoted's safe set, plus what Python's quote never escapes. */
const QUOTE_SAFE = /^[A-Za-z0-9_.\-~@#$&()*!+=:;,?/']$/;

/** `name` URL-quoted exactly as the app's frappe.utils.quoted does it (UTF-8, upper-case hex). */
export function quoteScanName(name: string): string {
	let out = "";
	for (const ch of String(name)) {
		if (QUOTE_SAFE.test(ch)) {
			out += ch;
			continue;
		}
		for (const byte of new TextEncoder().encode(ch)) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/**
 * `<base>/s/<alias>/<name>`, exactly as the app's scan_url builds it. Throws when the
 * base is refused (scanBaseUrl), the alias is not upper-case letters or the name is empty.
 */
export function scanUrl(base: string, alias: string, name: string): string {
	const origin = scanBaseUrl(base);
	if (!origin) throw new Error(`A scan code needs the site's https address, not '${base}'`);
	if (!/^[A-Z]+$/.test(alias)) throw new Error(`'${alias}' is not a scan alias`);
	const nm = String(name ?? "").trim();
	if (!nm) throw new Error("A scan code needs a document name");
	return `${origin}/s/${alias}/${quoteScanName(nm)}`;
}

/**
 * The printed box for `url`'s QR, quiet zone included: the smallest of 0.8in, 0.9in, ...
 * whose modules are at least SCAN_MIN_MODULE_MM.
 */
export function scanCodeSize(url: string): string {
	const span = scanCodeMatrix(url).length + 2 * SCAN_QUIET_ZONE;
	let tenths = Math.round(SCAN_CODE_MIN_IN * 10);
	while (((tenths / 10) * 25.4) / span < SCAN_MIN_MODULE_MM) tenths += Math.round(SCAN_CODE_STEP_IN * 10);
	return `${tenths / 10}in`;
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
 * offline sale's caption is short ("Offline sale · …k3j2abcd"); the QR carries the full URL.
 */
export function scanCodeBlockHtml(url: string, label: string): string {
	const size = scanCodeSize(url);
	return `<div class="mule-scan-block" data-scan-url="${esc(url)}" style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
        <div class="mule-scan-label" style="font-size:10px;font-weight:700;text-align:right;white-space:nowrap;line-height:1.2;">${esc(label)}</div>
        <div class="mule-scan-code" style="width:${size};height:${size};flex:0 0 ${size};">${scanCodeSvg(url)}</div>
    </div>`;
}
