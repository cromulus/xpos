/**
 * Mule City's print brand for the offline receipt (MuleCity-mon6).
 *
 * Each online start asks mulecity_erpnext.printouts.print_brand (MuleCity-kht3.2) for the
 * look the Mule City Ticket prints with: name, address line, phone, website, and the
 * optional logo, footer and accent colour (empty strings when unset), and the site URL the
 * receipt's scan code starts with (scan_base_url, MuleCity-dykb). When a logo is set it
 * is fetched once and kept as a data URI with the cached receipt context, so a receipt
 * printed after an offline cold start still shows it; no service-worker precache, because
 * the logo is a site setting, not a build asset, and the desktop app has no service worker.
 *
 * A site without print_brand (an older mulecity_erpnext) answers with an error: nothing is
 * logged and the receipt prints the company name in type, from the receipt context. A
 * failed refresh keeps the brand cached last time.
 */
import { call } from "@/services/api";
import type { PrintBrand } from "@/types/pos.types";

export const PRINT_BRAND_METHOD = "mulecity_erpnext.printouts.print_brand";
/** A logo bigger than this is not cached (a print logo is a few KB). */
export const MAX_LOGO_BYTES = 512 * 1024;

const FIELDS = [
	"company_name",
	"address_line",
	"phone",
	"website",
	"logo_url",
	"footer_text",
	"accent_color",
	// The site's own URL, the base of the receipt's scan code (MuleCity-dykb).
	"scan_base_url",
] as const;

function normalize(raw: unknown): PrintBrand | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const brand = {} as PrintBrand;
	for (const key of FIELDS) brand[key] = typeof r[key] === "string" ? (r[key] as string).trim() : "";
	return brand.company_name ? brand : null;
}

function blobToDataUri(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** The logo at `url` as a data URI, or "" when it cannot be fetched or is not an image. */
export async function fetchLogoDataUri(url: string): Promise<string> {
	if (!url) return "";
	try {
		const response = await fetch(url, { credentials: "include", cache: "no-store" });
		if (!response.ok) return "";
		const blob = await response.blob();
		if (!blob.type.startsWith("image/") || blob.size > MAX_LOGO_BYTES) return "";
		const uri = await blobToDataUri(blob);
		return uri.startsWith("data:image/") ? uri : "";
	} catch {
		return "";
	}
}

/**
 * The brand to cache now: the server's, with its logo as a data URI. `previous` (the brand
 * cached last time) is kept when the server cannot answer, and its logo is reused when the
 * logo URL is unchanged but could not be fetched this time. Null on a site without
 * print_brand and nothing cached.
 */
export async function refreshPrintBrand(previous?: PrintBrand | null): Promise<PrintBrand | null> {
	let brand: PrintBrand | null;
	try {
		// Best-effort: any answer (including "no such method" on an older app) is handled here.
		brand = normalize(await call<unknown>(PRINT_BRAND_METHOD, {}, undefined, { answers: () => true }));
	} catch {
		return previous || null;
	}
	if (!brand) return previous || null;
	if (brand.logo_url) {
		const uri = await fetchLogoDataUri(brand.logo_url);
		if (uri) brand.logo_data_uri = uri;
		else if (previous?.logo_url === brand.logo_url && previous.logo_data_uri) {
			brand.logo_data_uri = previous.logo_data_uri;
		}
	}
	return brand;
}
