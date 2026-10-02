import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildReceiptHtml, deliveryDayLabel, deliveryMilesLabel } from "@/services/receiptTemplate";
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
		},
	};
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
	it("renders the cached CSS and core receipt fields", () => {
		const html = buildReceiptHtml(snapshot, context);
		expect(html).toContain(context.css);
		expect(html).toContain("LOCAL-42");
		expect(html).toContain("07-07-2026");
		expect(html).toContain("02:05 PM");
		expect(html).toContain("Coffee &amp; Cream"); // HTML-escaped
		expect(html).toContain("Acme &lt;Store&gt;"); // company name escaped
		expect(html).toContain("<b>Welcome</b>"); // header HTML kept raw
		expect(html).toContain("Cash");
		expect(html).toContain("Change");
		expect(html).toContain("Tax ID: TAX-99");
	});

	it("shows RETURN banner and REFUND label for returns", () => {
		const html = buildReceiptHtml({ ...snapshot, is_return: true, change: 0 }, context);
		expect(html).toContain("RETURN / REFUND");
		expect(html).toContain("REFUND");
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
		expect(html).toContain("(17-08-2026)");
		expect(html).toMatch(/@ 90,000 \(17-08-2026\) = [^<]*9,000,000/);
	});

	it("lists one change line per currency plus a total", () => {
		const html = buildReceiptHtml(MIXED_SNAPSHOT, LBP_CONTEXT);

		expect(html).toContain("USD 30.00");
		// A leg already in the invoice currency prints with the Currency doctype symbol, the
		// same way the server-side print format renders it through fmt_money.
		expect(html).toContain("L£407,700");
		expect(html).toContain("Total Change");
		// The legs must still reconcile to the single figure ERPNext computed.
		expect(html).toMatch(/Total Change<\/span>\s*<span>[^<]*3,107,700/);
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

	it("leaves a legacy single-currency receipt byte for byte unchanged", () => {
		// No change legs and no tagged payment rows: the old one-line form must survive.
		const html = buildReceiptHtml(snapshot, context);

		expect(html).toContain("<span>Change</span>");
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
	const section = (html: string) => html.match(/<div class="customer-section delivery-section">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "";

	it("prints the address, the miles and the day, and keeps the DEL line", () => {
		const html = buildReceiptHtml({ ...snapshot, items: [...snapshot.items, delLine], delivery }, context);
		const text = section(html);
		expect(text).toContain("Delivery");
		expect(text).toContain("1202 N Wall St, Benson, NC 27504");
		expect(text).toContain("Miles: <strong>12 mi</strong>");
		expect(text).toContain("Day: <strong>Monday, October 5, 2026</strong>");
		// The DEL item line still prints with the items, after the section.
		expect(html.indexOf("delivery-section")).toBeLessThan(html.indexOf("items-header"));
		expect(html.slice(html.indexOf("items-header"))).toContain(">Delivery</div>");
	});

	it("says 'miles not known' when the address has no miles, and marks typed miles", () => {
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, miles: null, miles_source: null } }, context))).toContain(
			"Miles: <strong>miles not known</strong>",
		);
		expect(section(buildReceiptHtml({ ...snapshot, delivery: { ...delivery, miles: 7.5, miles_source: "manual" } }, context))).toContain(
			"Miles: <strong>7.5 mi, typed</strong>",
		);
	});

	it("prints no section for a pickup sale", () => {
		const html = buildReceiptHtml({ ...snapshot, delivery: undefined }, context);
		expect(html).not.toContain("delivery-section");
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
		expect(buildReceiptHtml({ ...snapshot, notes: "Call Steve first" }, context)).toContain(
			"<strong>Notes:</strong> Call Steve first",
		);
		const html = buildReceiptHtml({ ...snapshot, is_return: true, change: 0, notes: "Torn bag\nrefund cash" }, context);
		expect(html).toContain("RETURN / REFUND");
		expect(html).toContain("<strong>Notes:</strong> Torn bag<br>refund cash");
	});

	it("prints nothing for an empty note", () => {
		expect(buildReceiptHtml({ ...snapshot, notes: undefined }, context)).not.toContain("Notes:");
		expect(buildReceiptHtml({ ...snapshot, notes: "" }, context)).not.toContain("Notes:");
	});
});
