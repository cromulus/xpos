import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildReceiptHtml, deliveryDayLabel, deliveryMilesLabel, RECEIPT_CSS } from "@/services/receiptTemplate";
import { setSiteLocale } from "@/utils/siteLocale";
import { resetCurrencyCache } from "@/composables/useCurrency";
import type { ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";

vi.mock("@/services/dbBridge", () => ({
	getCachedCurrencyMeta: vi.fn().mockResolvedValue([]),
}));

/** LBP is quoted in whole units, USD in cents. The mixed-currency cases rest on that asymmetry. */
beforeEach(() => {
	(window as any).xpos = {
		boot: {
			currencies: [
				{ name: "LBP", symbol: "L£", number_format: "#,###" },
				{ name: "USD", symbol: "$", number_format: "#,###.##" },
			],
			// Mule City's site format (MuleCity-mon6): month first.
			sysdefaults: { date_format: "mm-dd-yyyy", time_format: "HH:mm:ss", currency: "USD" },
		},
	};
	setSiteLocale(null);
	resetCurrencyCache();
});

const context: ReceiptContext = {
	company_name: "Acme <Store>",
	company_phone: "123-456",
	company_email: "hi@acme.test",
	company_website: "acme.test",
	company_address: "1 Main St, Town",
	company_tax_id: "TAX-99",
	company_logo: "",
	receipt_header: "<b>Welcome</b>",
	receipt_footer: "<i>See you again</i>",
	currency: "USD",
	print_discount_amount: 0,
	print_format: "XPOS Thermal Receipt",
	css: ".receipt-container{width:100%}",
};

const snapshot: ReceiptSnapshot = {
	name: "LOCAL-42",
	posting_date: "2026-07-07",
	posting_time: "14:05:30",
	is_return: false,
	cashier: "Jane Cashier",
	customer_name: "Walk-in Customer",
	items: [
		{
			item_code: "SKU1",
			item_name: "Coffee & Cream",
			qty: 2,
			rate: 3.5,
			amount: 7,
			uom: "Nos",
			discount_percentage: 10,
			discount_amount: 0.7,
		},
	],
	taxes: [{ description: "VAT", rate: 15, amount: 0.95, included_in_print_rate: false }],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
	subtotal: 6.3,
	total_discount: 0.7,
	net_total: 6.3,
	grand_total: 7.25,
	total_qty: 2,
	change: 2.75,
	notes: "gift wrap",
};

describe("buildReceiptHtml", () => {
	it("renders its own inline CSS and the core receipt fields", () => {
		const html = buildReceiptHtml(snapshot, context);
		expect(html).toContain(`<style>${RECEIPT_CSS}</style>`);
		// The print format's CSS field is no longer what styles it (MuleCity-mon6).
		expect(html).not.toContain(context.css);
		expect(html).toContain("LOCAL-42");
		expect(html).toContain("07-07-2026 14:05:30");
		expect(html).toContain("Coffee &amp; Cream"); // HTML-escaped
		expect(html).toContain("Acme &lt;Store&gt;"); // company name escaped
		expect(html).toContain("Cash");
		expect(html).toContain("Change");
		expect(html).toContain("Thank you for your business!");
	});

	it("shows the return heading and the refund total for returns", () => {
		const html = buildReceiptHtml({ ...snapshot, is_return: true, change: 0 }, context);
		expect(html).toContain("Return / refund");
		expect(html).toContain("Transaction type: <b>Return</b>");
		expect(html).toContain("<b>Refund: $7.25</b>");
		expect(html).not.toContain("Change");
	});

	it("falls back to the currency code as its own symbol when no Currency row is cached", () => {
		const html = buildReceiptHtml(snapshot, { ...context, currency: "Rs" });
		expect(html).toContain("Rs7.25");
	});
});

/**
 * The client's own receipt: invoice 5,892,300 LBP, tender $100 at 90,000, change 3,107,700 LBP
 * handed back as $30 plus 407,700 LBP.
 */
const LBP_CONTEXT: ReceiptContext = { ...context, currency: "LBP" };

const MIXED_SNAPSHOT: ReceiptSnapshot = {
	...snapshot,
	currency: "LBP",
	items: [{ item_code: "NUT-1", item_name: "Mixed Nuts", qty: 1, rate: 5892300, amount: 5892300 }],
	taxes: [],
	subtotal: 5892300,
	total_discount: 0,
	net_total: 5892300,
	grand_total: 5892300,
	total_qty: 1,
	payments: [
		{
			mode_of_payment: "Cash USD",
			amount: 9000000,
			currency: "USD",
			native_amount: 100,
			exchange_rate: 90000,
			rate_date: "2026-08-17",
		},
	],
	change: 3107700,
	change_legs: [
		{
			mode_of_payment: "Cash USD",
			currency: "USD",
			amount: 30,
			base_amount: 2700000,
			exchange_rate: 90000,
		},
		{
			mode_of_payment: "Cash LBP",
			currency: "LBP",
			amount: 407700,
			base_amount: 407700,
			exchange_rate: 1,
		},
	],
};

describe("buildReceiptHtml - mixed-currency tender", () => {
	it("prints a foreign leg in its own currency at its own precision", () => {
		const html = buildReceiptHtml(MIXED_SNAPSHOT, LBP_CONTEXT);

		// The notes handed over were 100 dollars, not 9,000,000 pounds.
		expect(html).toContain("USD 100.00");
	});

	it("shows the rate and its date so the conversion can be checked", () => {
		const html = buildReceiptHtml(MIXED_SNAPSHOT, LBP_CONTEXT);

		// The rate is quoted in LBP, which is a zero-decimal currency, so no phantom cents.
		expect(html).toContain("@ 90,000");
		expect(html).toContain("(08-17-2026)");
		expect(html).toMatch(/@ 90,000 \(08-17-2026\) = [^<]*9,000,000/);
	});

	it("lists one change line per currency plus a total", () => {
		const html = buildReceiptHtml(MIXED_SNAPSHOT, LBP_CONTEXT);

		expect(html).toContain("USD 30.00");
		// A leg already in the invoice currency prints with the Currency doctype symbol, the
		// same way the server-side print format renders it through fmt_money.
		expect(html).toContain("L£407,700");
		expect(html).toContain("Total Change");
		// The legs must still reconcile to the single figure ERPNext computed.
		expect(html).toMatch(/Total Change: <b>[^<]*3,107,700/);
	});

	it("omits the rate line for a leg already in the invoice currency", () => {
		const html = buildReceiptHtml(
			{
				...MIXED_SNAPSHOT,
				payments: [{ mode_of_payment: "Cash LBP", amount: 5892300 }],
				change: 0,
				change_legs: undefined,
			},
			LBP_CONTEXT,
		);

		expect(html).not.toContain("payment-rate-line");
		expect(html).not.toContain("Total Change");
	});

	it("prints a single-currency receipt's change on one line", () => {
		// No change legs and no tagged payment rows: the one-line form.
		const html = buildReceiptHtml(snapshot, context);

		expect(html).toContain("Change: <b>$2.75</b>");
		expect(html).not.toContain("Total Change");
		expect(html).not.toContain("change-leg-row");
		expect(html).not.toContain("payment-rate-line");
	});
});

/**
 * Bill (2026-09-29, MuleCity-nfxn.11): "tax should be simpler: 'Sales Tax 6.75%'!"
 * The offline receipt prints the rate beside the label, with no parentheses and
 * no trailing zeros; a row with no rate prints its label alone.
 */
describe("the tax line", () => {
	it("reads 'Sales Tax 6.75%'", () => {
		const html = buildReceiptHtml(
			{ ...snapshot, taxes: [{ description: "Sales Tax", rate: 6.75, amount: 1.1, included_in_print_rate: false }] },
			context,
		);
		expect(html).toContain("Sales Tax 6.75%");
		expect(html).not.toContain("(6.75%)");
	});

	it("drops trailing zeros and leaves a rate-less row alone", () => {
		const html = buildReceiptHtml(
			{
				...snapshot,
				taxes: [
					{ description: "Sales Tax", rate: 7.0, amount: 1, included_in_print_rate: false },
					{ description: "Captured tax", rate: 0, amount: 2, included_in_print_rate: false },
				],
			},
			context,
		);
		expect(html).toContain("Sales Tax 7%");
		expect(html).not.toContain("Captured tax 0%");
	});
});

/**
 * Bill (2026-10-01, MuleCity-qajl.5): "delivery should both be a line item on the
 * printed receipt, but also a section on the receipt." The offline receipt prints
 * the same Delivery section as the Mule City Ticket: the address, the miles used
 * at sale time ("miles not known" when none) and the day in the prints' long style.
 */
describe("the Delivery section", () => {
	const delLine = {
		item_code: "DEL",
		item_name: "Delivery",
		qty: 1,
		rate: 25,
		amount: 25,
	};
	const delivery = {
		address_name: "Smith Farm-Shipping",
		address: "1202 N Wall St, Benson, NC 27504",
		miles: 12,
		miles_source: "address" as const,
		date: "2026-10-05",
	};
	const section = (html: string) =>
		html.match(/<h4 class="mule-section">Delivery<\/h4>\s*<div class="mule-customer mule-delivery">[\s\S]*?<\/div>/)?.[0] || "";

	it("prints the address, the miles and the day, and keeps the DEL line", () => {
		const html = buildReceiptHtml({ ...snapshot, items: [...snapshot.items, delLine], delivery }, context);
		const text = section(html);
		expect(text).toContain("Delivery");
		expect(text).toContain("1202 N Wall St, Benson, NC 27504");
		expect(text).toContain("Miles: <b>12 mi</b>");
		expect(text).toContain("Day: <b>Monday, October 5, 2026</b>");
		// The DEL item line still prints with the items, after the section.
		const items = html.indexOf('<h4 class="mule-section">Items</h4>');
		expect(html.indexOf('class="mule-customer mule-delivery"')).toBeLessThan(items);
		expect(html.slice(items)).toContain("<td>Delivery</td>");
	});

	it("says 'miles not known' when the address has no miles, and marks typed miles", () => {
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, miles: null, miles_source: null } }, context))).toContain(
			"Miles: <b>miles not known</b>",
		);
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, miles: 7.5, miles_source: "manual" } }, context))).toContain(
			"Miles: <b>7.5 mi, typed</b>",
		);
	});

	it("prints no section for a pickup sale", () => {
		const html = buildReceiptHtml({ ...snapshot, delivery: undefined }, context);
		expect(html).not.toContain('class="mule-customer mule-delivery"');
		expect(html).not.toContain("Miles:");
	});

	it("escapes the address, and says so when none was recorded", () => {
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, address: "<b>Barn</b>" } }, context))).toContain(
			"&lt;b&gt;Barn&lt;/b&gt;",
		);
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, address: "" } }, context))).toContain(
			"Address not recorded",
		);
	});

	it("reads the day as a local date, like the ticket's day_label", () => {
		expect(deliveryDayLabel("2026-10-05")).toBe("Monday, October 5, 2026");
		expect(deliveryDayLabel("2026-01-01")).toBe("Thursday, January 1, 2026");
		expect(deliveryDayLabel("")).toBe("");
		expect(deliveryMilesLabel(12)).toBe("12 mi");
		expect(deliveryMilesLabel(0)).toBe("miles not known");
	});
});

/**
 * Bill (2026-10-01, MuleCity-qajl.7): "we should be able to add notes to sales,
 * orders, and returns as well." The note prints on the offline receipt for a sale
 * and a return; an empty note prints nothing.
 */
describe("the note", () => {
	it("prints on a sale and on a return, line breaks kept", () => {
		expect(buildReceiptHtml({ ...snapshot, notes: "Call Steve first" }, context)).toMatch(
			/<h4 class="mule-section">Notes<\/h4>\s*<div class="mule-customer mule-notes">Call Steve first<\/div>/,
		);
		const html = buildReceiptHtml({ ...snapshot, is_return: true, change: 0, notes: "Torn bag\nrefund cash" }, context);
		expect(html).toContain("Return / refund");
		expect(html).toContain('mule-notes">Torn bag<br>refund cash');
	});

	it("prints nothing for an empty note", () => {
		expect(buildReceiptHtml({ ...snapshot, notes: undefined }, context)).not.toContain(">Notes<");
		expect(buildReceiptHtml({ ...snapshot, notes: "" }, context)).not.toContain(">Notes<");
	});
});

/**
 * MuleCity-mon6 (mc39 staging walk): the offline receipt printed unstyled (its CSS came from
 * the print format's CSS field, which the Mule City Ticket leaves empty), with a broken
 * logo and a day-month date. It now carries its own CSS, prints the logo only from a cached
 * data URI, and dates in the site's format, and reads like the Ticket.
 */
describe("the offline receipt is self-contained and reads like the Mule City Ticket", () => {
	const BRAND = {
		company_name: "Mule City Specialty Feeds",
		address_line: "1202 N Wall St, Benson, NC 27504",
		phone: "919-894-3626",
		website: "mulecity.com",
		logo_url: "",
		footer_text: "",
		accent_color: "",
	};
	const mule: ReceiptContext = { ...context, company_logo: "/files/app-icon.png", css: "", brand: BRAND };
	const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

	it("inlines all its CSS and loads nothing from the network", () => {
		const html = buildReceiptHtml(snapshot, mule);
		const doc = parse(html);
		expect(doc.querySelectorAll("style")).toHaveLength(1);
		expect(doc.querySelector("style")!.textContent).toContain(".mule-ticket");
		expect(html).not.toMatch(/<link\b/i);
		expect(html).not.toMatch(/@import/i);
		expect(html).not.toMatch(/url\(/i);
		expect(html).not.toMatch(/src="(?!data:)/);
		expect(html).not.toMatch(/<script\b/i);
	});

	it("prints US dates mm-dd-yyyy from the site's sysdefaults, never day-month", () => {
		const html = buildReceiptHtml({ ...snapshot, posting_date: "2026-10-06", posting_time: "15:03:00.123" }, mule);
		expect(html).toContain("10-06-2026 15:03:00");
		expect(html).not.toContain("06-10-2026");
	});

	it("follows a day-first site and falls back to the ISO date when no format is known", () => {
		(window as any).xpos.boot.sysdefaults = { date_format: "dd.mm.yyyy" };
		expect(buildReceiptHtml({ ...snapshot, posting_date: "2026-10-06" }, mule)).toContain("06.10.2026");
		delete (window as any).xpos.boot.sysdefaults;
		expect(buildReceiptHtml({ ...snapshot, posting_date: "2026-10-06" }, mule)).toContain("2026-10-06");
	});

	it("uses the receipt context's site locale when there is no boot (the desktop app)", () => {
		delete (window as any).xpos.boot.sysdefaults;
		const locale = {
			date_format: "mm-dd-yyyy",
			time_format: "HH:mm:ss",
			number_format: "#,###.##",
			currency: "USD",
			currency_precision: "",
			float_precision: "",
			time_zone: "America/New_York",
		};
		expect(buildReceiptHtml({ ...snapshot, posting_date: "2026-10-06" }, { ...mule, locale })).toContain("10-06-2026");
	});

	it("prints the Ticket's compact letterhead: name, then address · phone · website", () => {
		const doc = parse(buildReceiptHtml(snapshot, mule));
		expect(doc.querySelector(".mule-lh-name")!.textContent).toBe("Mule City Specialty Feeds");
		expect(doc.querySelector(".mule-lh-contact")!.textContent).toBe(
			"1202 N Wall St, Benson, NC 27504 · 919-894-3626 · mulecity.com",
		);
		expect((doc.querySelector(".mule-lh-name") as HTMLElement).style.color).toBe("rgb(0, 0, 0)");
		expect(doc.querySelector(".mule-footer")).toBeNull();
	});

	it("prints no image when no logo is cached, and never the Company's app icon", () => {
		expect(buildReceiptHtml(snapshot, mule)).not.toContain("<img");
		// A logo URL whose image could not be cached: the name in type, no broken image.
		expect(buildReceiptHtml(snapshot, { ...mule, brand: { ...BRAND, logo_url: "https://x.test/l.png" } })).not.toContain(
			"<img",
		);
		// An older site with no print brand: the receipt context's company, in type.
		const older = parse(buildReceiptHtml(snapshot, { ...context, company_logo: "/files/app-icon.png" }));
		expect(older.querySelector("img")).toBeNull();
		expect(older.querySelector(".mule-lh-name")!.textContent).toBe("Acme <Store>");
		expect(older.querySelector(".mule-lh-contact")!.textContent).toBe("1 Main St, Town · 123-456 · acme.test");
	});

	it("prints a cached logo as a data URI, with the footer and accent colour when set", () => {
		const logo = "data:image/png;base64,iVBORw0KGgo=";
		const doc = parse(
			buildReceiptHtml(snapshot, {
				...mule,
				brand: { ...BRAND, logo_url: "https://x.test/l.png", logo_data_uri: logo, footer_text: "Open Mon-Sat", accent_color: "#b5121b" },
			}),
		);
		expect(doc.querySelector("img.mule-lh-logo")!.getAttribute("src")).toBe(logo);
		expect(doc.querySelector(".mule-footer")!.textContent).toBe("Open Mon-Sat");
		expect((doc.querySelector(".mule-lh-name") as HTMLElement).style.color).toBe("rgb(181, 18, 27)");
		// A colour that is not a colour is not printed into a style attribute.
		const bad = buildReceiptHtml(snapshot, { ...mule, brand: { ...BRAND, accent_color: "red;background:url(x)" } });
		expect(bad).not.toContain("background:url");
	});

	it("has the Ticket's sections, columns and footer", () => {
		const doc = parse(buildReceiptHtml(snapshot, mule));
		const sections = [...doc.querySelectorAll("h4.mule-section")].map((h) => h.textContent);
		expect(sections).toEqual(["Customer", "Notes", "Items", "Totals & payment"]);
		expect([...doc.querySelectorAll(".mule-lines thead th")].map((th) => th.textContent)).toEqual([
			"Quantity",
			"Item or service",
			"Description",
			"Price",
			"Total",
		]);
		expect(doc.querySelector(".mule-copy")!.textContent).toBe("Customer copy");
		expect(doc.querySelector(".mule-head-doc")!.textContent).toContain("Ticket # LOCAL-42");
		expect(doc.querySelector(".mule-head-doc")!.textContent).toContain("Cashier Jane Cashier");
		expect(doc.querySelector(".mule-thanks")!.textContent).toBe("Thank you for your business!");
		expect(doc.body.textContent).not.toContain("Powered by XPOS");
	});

	it("prints a discounted line like the Ticket: list price, the amount off each, the net total", () => {
		const doc = parse(buildReceiptHtml(snapshot, mule));
		const cells = [...doc.querySelectorAll(".mule-lines tbody tr")[0].querySelectorAll("td")].map((td) => td.textContent);
		// 2 at $3.50 list, 10% off: $0.35 off each, $6.30 for the line.
		expect(cells[0]).toBe("2");
		expect(cells[3]).toBe("$3.500−$0.350 ea (10%)");
		expect(cells[4]).toBe("$6.30");
	});

	it("calls a sale not paid in full a charge, and a paid one cash", () => {
		expect(buildReceiptHtml(snapshot, mule)).toContain("Transaction type: <b>Cash</b>");
		expect(buildReceiptHtml({ ...snapshot, payments: [], change: 0 }, mule)).toContain("Transaction type: <b>Charge</b>");
	});
});
