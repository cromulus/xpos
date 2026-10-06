/**
 * XPOS's own receipt: what prints for a sale saved on this device (printReceiptOffline in the
 * browser, printInvoiceLocal in the desktop app), when ERPNext's print view cannot be reached.
 *
 * Mule City (MuleCity-mon6): it mirrors the online Mule City Ticket (mulecity_erpnext
 * print format, restyled in MuleCity-kht3): the compact letterhead, then Customer, Delivery,
 * Notes, Items and "Totals & payment", and "Thank you for your business!". One copy, the
 * customer's, laid out as the top half of a Letter sheet like the Ticket's copies.
 *
 * Self-contained: all CSS is inline (RECEIPT_CSS), the logo is a data URI cached online
 * (services/printBrand.ts) and dates and money use the site's formats cached from the boot
 * (utils/siteLocale.ts), so it prints the same online, offline and in the desktop app.
 * Before mc40 it took its CSS from the POS profile's print format's CSS field, which the
 * Ticket leaves empty (its CSS lives in its template), so it printed unstyled.
 */
import { formatFor, formatWithSymbol } from "@/composables/useCurrency";
import type { PrintBrand, ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";
import { formatQty } from "@/utils/numberFormat";
import { formatLocalDate } from "@/utils/localDate";
import { formatSiteDate, formatSiteTime, normalizeSiteLocale, siteLocale, type SiteLocale } from "@/utils/siteLocale";
import { encodeScanPayload, offlineScanPayload, scanCodeBlockHtml } from "@/services/scanCode";

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * The Ticket's CSS (mule_city_ticket.json's <style>) and the compact letterhead's rules from
 * mulecity_erpnext's print_style.css (MuleCity-kht3), plus the few rules the offline receipt
 * needs that the Ticket does not (payment and change lines, a foreign tender's rate). Inline:
 * no stylesheet, no web font, nothing fetched.
 */
export const RECEIPT_CSS = `
@page { size: letter; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.mule-half { min-height: 5.5in; box-sizing: border-box; padding: 0.3in 0.45in 0.2in; page-break-inside: avoid; break-inside: avoid; }
.mule-ticket { font-family: Helvetica, Arial, "Liberation Sans", sans-serif; font-size: 11px; color: #000; line-height: 1.3; }
.mule-ticket table { width: 100%; border-collapse: collapse; }
.mule-ticket td, .mule-ticket th { padding: 1px 4px; vertical-align: top; text-align: left; }
.mule-ticket .right { text-align: right; }
.mule-ticket .mule-copy { font-size: 12px; font-weight: bold; }
.mule-head { border-bottom: 1pt solid #000; }
.mule-head > tbody > tr > td, .mule-head > tr > td { padding-bottom: 2px; vertical-align: bottom; }
.mule-head .mule-head-doc { white-space: nowrap; }
.mule-head .mule-head-code { width: 1%; padding-left: 8px; }
.mule-ticket .mule-lh { width: 100%; border-collapse: collapse; border-bottom: none; margin: 0; color: #000; }
.mule-ticket .mule-lh td { padding: 0; border: none; vertical-align: bottom; }
.mule-ticket .mule-lh .mule-lh-logo { float: left; height: 0.45in; margin: 0 6pt 0 0; }
.mule-ticket .mule-lh .mule-lh-name { font-size: 11.5pt; font-weight: bold; letter-spacing: 0.3pt; line-height: 1.1; }
.mule-ticket .mule-lh .mule-lh-contact { font-size: 8.5pt; line-height: 1.2; }
.mule-ticket .mule-delivery { line-height: 1.15; }
.mule-ticket .mule-heading { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
.mule-ticket .mule-section { font-size: 12px; font-weight: bold; border-bottom: 1px solid #000; padding: 0 4px 1px; margin: 8px 0 3px; }
.mule-customer { padding: 0 4px; }
.mule-lines thead th { font-weight: normal; font-style: italic; }
.mule-lines .description { font-weight: bold; }
.mule-lines .mule-off { font-size: 9px; }
.mule-foot .mule-rate { font-size: 9px; padding-left: 12px; }
.mule-thanks { text-align: center; margin-top: 6px; }
.mule-footer { font-size: 8.5pt; text-align: center; border-top: 0.5pt solid #bbb; margin-top: 8pt; padding-top: 3pt; }
`;

const DEFAULT_ACCENT = "#000";
/** A colour value safe to put in a style attribute: #rgb..#rrggbbaa or a colour name. */
const SAFE_COLOUR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;

function fmtMoney(amount: number, currency: string, precision?: number): string {
	return formatWithSymbol(currency, Number(amount || 0), precision);
}

function fmtNative(amount: number, currency: string): string {
	return `${currency} ${formatFor(currency, amount)}`;
}

/** The site's locale for this receipt: the live/saved one, else the receipt context's. */
function receiptLocale(ctx: ReceiptContext): SiteLocale | null {
	const live = siteLocale();
	if (live?.date_format) return live;
	return normalizeSiteLocale(ctx.locale);
}

/**
 * The delivery's miles as the Mule City Ticket prints them (mulecity_erpnext
 * print_delivery.miles_label): "12 mi", "12 mi, typed" when the clerk typed them,
 * or "miles not known".
 */
export function deliveryMilesLabel(miles: number | null | undefined, source?: string | null): string {
	const value = Number(miles) || 0;
	if (!value) return "miles not known";
	const label = `${Number(value.toPrecision(6))} mi`;
	return source === "manual" ? `${label}, typed` : label;
}

/**
 * The delivery day in the prints' long style, "Monday, October 5, 2026"
 * (print_delivery.day_label). Read as a local date: `new Date("2026-10-05")` is
 * UTC midnight, the day before in US time zones.
 */
export function deliveryDayLabel(date: string | null | undefined): string {
	const prefix = String(date || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(prefix)) return "";
	return formatLocalDate(prefix, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, "en-US");
}

/**
 * The Delivery section, worded like the Mule City Ticket's (MuleCity-qajl.5) so an
 * offline print matches the online one. The DEL line still prints with the items;
 * a pickup sale (no delivery on the snapshot) prints no section.
 */
function deliverySectionHtml(delivery: ReceiptSnapshot["delivery"]): string {
	if (!delivery) return "";
	const address = delivery.address ? esc(delivery.address) : "Address not recorded";
	return `<h4 class="mule-section">Delivery</h4>
	<div class="mule-customer mule-delivery">${address}<br>Miles: <b>${esc(
		deliveryMilesLabel(delivery.miles, delivery.miles_source),
	)}</b> &middot; Day: <b>${esc(deliveryDayLabel(delivery.date) || "not set")}</b></div>`;
}

/** Characters of the local id the offline caption keeps. */
export const OFFLINE_CAPTION_TAIL = 8;

/**
 * What the receipt's scan code says (MuleCity-gt9l): the submitted invoice when the
 * snapshot names it, else the offline queue's local id; null when it knows neither.
 * `label` is the short caption printed beside the code (MuleCity-mon6): the invoice's
 * name, or "Offline sale · …" and the local id's last 8 characters. The QR carries the
 * full payload.
 */
export function receiptScanCode(snapshot: ReceiptSnapshot): { payload: string; label: string } | null {
	const doc = snapshot.scan_doc;
	if (doc?.doctype && doc?.name) {
		return { payload: encodeScanPayload(doc.doctype, doc.name), label: doc.name.trim() };
	}
	const localId = String(snapshot.xpos_local_id || "").trim();
	if (localId) {
		const tail = localId.length > OFFLINE_CAPTION_TAIL ? `…${localId.slice(-OFFLINE_CAPTION_TAIL)}` : localId;
		return { payload: offlineScanPayload(localId), label: `Offline sale · ${tail}` };
	}
	return null;
}

/** The letterhead's facts: Mule City's print brand, else the receipt context's company. */
function letterhead(ctx: ReceiptContext): { name: string; contact: string; logo: string; footer: string; accent: string } {
	const brand: PrintBrand | undefined = ctx.brand?.company_name ? ctx.brand : undefined;
	const website = (brand ? brand.website : ctx.company_website || "")
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/$/, "");
	const contact = brand
		? [brand.address_line, brand.phone, website]
		: [ctx.company_address, ctx.company_phone, website];
	const accent = brand?.accent_color && SAFE_COLOUR.test(brand.accent_color) ? brand.accent_color : DEFAULT_ACCENT;
	// Only a cached data URI prints: a URL would not load offline. No logo: the name in type.
	const logo = brand?.logo_data_uri && /^data:image\//.test(brand.logo_data_uri) ? brand.logo_data_uri : "";
	return {
		name: brand?.company_name || ctx.company_name,
		contact: contact.filter((part) => !!String(part || "").trim()).join(" · "),
		logo,
		footer: brand?.footer_text || "",
		accent,
	};
}

function letterheadHtml(ctx: ReceiptContext): string {
	const lh = letterhead(ctx);
	const logo = lh.logo ? `<img class="mule-lh-logo" src="${esc(lh.logo)}" alt="${esc(lh.name)}">` : "";
	return `<table class="mule-lh mule-lh-compact"><tr><td class="mule-lh-brand">${logo}<div class="mule-lh-name" style="color: ${lh.accent};">${esc(
		lh.name,
	)}</div><div class="mule-lh-contact">${esc(lh.contact)}</div></td></tr></table>`;
}

export function buildReceiptHtml(snapshot: ReceiptSnapshot, ctx: ReceiptContext): string {
	const currency = ctx.currency;
	const money = (amount: number, precision?: number) => fmtMoney(amount, currency, precision);
	const isReturn = snapshot.is_return;
	const locale = receiptLocale(ctx);
	const date = (value: string) => formatSiteDate(value, locale?.date_format || "");
	const lh = letterhead(ctx);

	const itemsHtml = snapshot.items
		.map((item) => {
			// The Ticket's Description column: what the clerk typed for the line.
			const description = [
				item.pos_notes ? esc(item.pos_notes) : "",
				item.serial_no ? `S/N: ${esc(item.serial_no)}` : "",
				item.batch_no ? `Batch: ${esc(item.batch_no)}` : "",
			]
				.filter(Boolean)
				.join("<br>");
			// Sold under its list price (the Ticket's line_price): the list price, and under it
			// the amount off each. The cart's snapshot keeps the list price as `rate`, the
			// line's gross as `amount` and the line's discount in `discount_amount`.
			const qty = Math.abs(Number(item.qty) || 0);
			const lineDiscount = Math.abs(Number(item.discount_amount) || 0);
			let listPrice = Number(item.rate) || 0;
			let offEach = qty && lineDiscount ? lineDiscount / qty : 0;
			if (!offEach && (Number(item.price_list_rate) || 0) - listPrice > 0.0005) {
				offEach = (Number(item.price_list_rate) || 0) - listPrice;
				listPrice = Number(item.price_list_rate) || 0;
			}
			const lineTotal = (Number(item.amount) || 0) - Math.sign(Number(item.amount) || 1) * lineDiscount;
			const price =
				offEach > 0.0005
					? `${money(listPrice, 3)}<div class="mule-off">&minus;${money(offEach, 3)} ea${
							item.discount_percentage ? ` (${Number(item.discount_percentage)}%)` : ""
						}</div>`
					: money(item.rate, 3);
			return `
			<tr>
				<td class="right">${formatQty(item.qty)}</td>
				<td>${esc(item.item_name || item.item_code)}</td>
				<td class="description">${description}</td>
				<td class="right">${price}</td>
				<td class="right">${money(lineTotal)}</td>
			</tr>`;
		})
		.join("");

	// Totals & payment: the Ticket's two columns. Left, the transaction type and how it was
	// paid; right, subtotal, discount, each tax row by its own name, and the total.
	const paid = snapshot.payments.reduce((sum, p) => sum + Math.abs(Number(p.amount) || 0), 0);
	// As on the Ticket: anything not paid in full at the counter is a charge.
	const transactionType = isReturn ? "Return" : paid + 0.005 >= Math.abs(snapshot.grand_total) ? "Cash" : "Charge";
	const left: string[] = [`Transaction type: <b>${transactionType}</b>`];
	for (const p of snapshot.payments) {
		const isForeign = !!p.currency && p.currency !== currency && p.native_amount !== undefined;
		const headline = isForeign ? fmtNative(Math.abs(p.native_amount!), p.currency!) : money(Math.abs(p.amount));
		left.push(`<span class="mule-pay">${isReturn ? "Refunded" : "Payment"}: ${esc(p.mode_of_payment)} <b>${headline}</b></span>`);
		if (isForeign) {
			left.push(
				`<span class="mule-rate payment-rate-line">@ ${formatFor(currency, p.exchange_rate || 0)}${
					p.rate_date ? ` (${date(p.rate_date)})` : ""
				} = ${money(Math.abs(p.amount))}</span>`,
			);
		}
	}
	const changeLegs = snapshot.change_legs || [];
	if (snapshot.change > 0.01) {
		if (changeLegs.length) {
			for (const leg of changeLegs) {
				const amount = leg.currency && leg.currency !== currency ? fmtNative(leg.amount, leg.currency) : money(leg.amount);
				left.push(`<span class="change-leg-row">Change: ${esc(leg.mode_of_payment)} ${amount}</span>`);
			}
			left.push(`<span class="change-row">Total Change: <b>${money(snapshot.change)}</b></span>`);
		} else {
			left.push(`<span class="change-row">Change: <b>${money(snapshot.change)}</b></span>`);
		}
	}

	// The additional discount on the whole sale (the item discounts are on their lines).
	const itemDiscounts = snapshot.items.reduce((sum, item) => sum + Math.abs(Number(item.discount_amount) || 0), 0);
	const additionalDiscount = Math.abs(snapshot.total_discount || 0) - itemDiscounts;
	const right: string[] = [`Subtotal: ${money(snapshot.subtotal)}`];
	if (additionalDiscount > 0.001) {
		right.push(`Discount: ${isReturn ? "+" : "&minus;"}${money(additionalDiscount)}`);
	}
	for (const tax of snapshot.taxes) {
		right.push(
			`${esc(tax.description || "Tax")}${tax.rate ? ` ${Number(tax.rate)}%` : ""}${
				tax.included_in_print_rate ? " (incl.)" : ""
			}: ${money(tax.amount)}`,
		);
	}
	right.push(`<b>${isReturn ? "Refund" : "Total"}: ${money(Math.abs(snapshot.grand_total))}</b>`);

	const rows = Math.max(left.length, right.length);
	// The total sits on the last row, as on the Ticket; the left column fills from the top.
	const rightPadded = [...Array(rows - right.length).fill(""), ...right];
	const footRows = Array.from(
		{ length: rows },
		(_, i) => `<tr><td>${left[i] || ""}</td><td class="right">${rightPadded[i] || ""}</td></tr>`,
	).join("");

	const scan = receiptScanCode(snapshot);
	// The QR in the head's right-hand slot, like the Ticket's (MuleCity-gt9l, gytr).
	const scanCell = scan ? `<td class="mule-head-code">${scanCodeBlockHtml(scan.payload, scan.label)}</td>` : "";
	const notes = String(snapshot.notes || "").trim();
	const time = formatSiteTime(snapshot.posting_time, locale?.time_format || "");

	const body = `<div class="mule-sheet"><div class="mule-half"><div class="mule-ticket">
	<table class="mule-head" style="border-bottom-color: ${lh.accent};">
		<tr>
			<td>${letterheadHtml(ctx)}</td>
			<td class="right mule-head-doc">${
				isReturn ? '<b class="mule-heading return-banner">Return / refund</b><br>' : ""
			}<span class="mule-copy">Customer copy</span><br>Ticket # <b>${esc(snapshot.name)}</b><br>${esc(
				date(snapshot.posting_date),
			)} ${esc(time)}${snapshot.cashier ? `<br>Cashier <b>${esc(snapshot.cashier)}</b>` : ""}</td>
			${scanCell}
		</tr>
	</table>
	<h4 class="mule-section">Customer</h4>
	<div class="mule-customer"><b>${esc(snapshot.customer_name || "")}</b></div>
	${deliverySectionHtml(snapshot.delivery)}
	${
		notes
			? `<h4 class="mule-section">Notes</h4>
	<div class="mule-customer mule-notes">${esc(notes).replace(/\n/g, "<br>")}</div>`
			: ""
	}
	<h4 class="mule-section">Items</h4>
	<table class="mule-lines">
		<thead>
			<tr><th class="right">Quantity</th><th>Item or service</th><th>Description</th><th class="right">Price</th><th class="right">Total</th></tr>
		</thead>
		<tbody>${itemsHtml}
		</tbody>
	</table>
	<h4 class="mule-section">Totals &amp; payment</h4>
	<table class="mule-foot">${footRows}</table>
	<div class="mule-thanks">${isReturn ? "Refund processed. " : ""}Thank you for your business!</div>
	${lh.footer ? `<div class="mule-footer">${esc(lh.footer)}</div>` : ""}
</div></div></div>`;

	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Ticket ${esc(snapshot.name)}</title>
<style>${RECEIPT_CSS}</style>
</head><body>
${body}
</body></html>`;
}
