/**
 * Why a customer row matches what the cashier typed (Mule City, MuleCity-1ptj).
 *
 * A farm is found by its own name, code or numbers, or by a person on the account:
 * a linked Contact's name, email or phone. Phones compare digits only, so
 * "(919) 555-1234", "919-555-1234", "9195551234" and the last four "1234" all
 * find the same number. One implementation serves the offline cache's filter
 * and ranking and the "via Jane Sharp" line shown online and offline, mirroring
 * xpos.api.customers.get_customers.
 */
import { siteValue } from "@/services/siteExtensions";
import type { Customer } from "@/types/pos.types";

/** 0 exact name/code, 1 the customer's own fields, 2 found only through a contact. */
export type MatchTier = 0 | 1 | 2;

export interface CustomerMatch {
	tier: MatchTier;
	/** What matched when it is not the farm's own name or code, e.g. "Jane Sharp · 919-555-1234". */
	via: string | null;
}

/** The server compares phones on 4+ digits; fewer would match nearly everyone. */
export const MIN_PHONE_DIGITS = 4;

const digitsOf = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

/**
 * The customer's other codes as one string: the site's codes field (xpos_site
 * `customer_codes_field`, server xpos_customer_fields "codes"), or "".
 */
export function customerCodes(customer: Record<string, unknown>): string {
	const field = siteValue("customer_codes_field");
	return typeof field === "string" && field ? text(customer[field]) : "";
}

function aliasCodes(customer: Customer): string[] {
	return customerCodes(customer as unknown as Record<string, unknown>)
		.split(/[,;\s]+/)
		.map((code) => code.trim())
		.filter(Boolean);
}

export function matchCustomer(customer: Customer, rawTerm: string): CustomerMatch | null {
	const term = rawTerm.trim().toLowerCase();
	if (!term) return { tier: 1, via: null };
	const digits = digitsOf(term);
	const phoneHit = (phone: unknown) => digits.length >= MIN_PHONE_DIGITS && digitsOf(phone).includes(digits);
	const has = (value: unknown) => text(value).toLowerCase().includes(term);

	const codes = aliasCodes(customer);
	const exact = [customer.name, customer.customer_name, ...codes].some((v) => text(v).toLowerCase() === term);
	const ownName =
		exact ||
		[customer.name, customer.customer_name, customerCodes(customer as unknown as Record<string, unknown>), customer.xpos_search_description, customer.tax_id].some(has);
	const contacts = customer.xpos_contacts || [];

	// A matching number is named, with the contact it belongs to, so the cashier sees which one.
	if (digits.length >= MIN_PHONE_DIGITS && !ownName) {
		const ownTier: MatchTier = phoneHit(customer.mobile_no) ? 1 : 2;
		for (const contact of contacts) {
			const phone = contact.phones.find(phoneHit);
			if (phone) return { tier: ownTier, via: `${contact.full_name} · ${phone}` };
		}
		const own = [customer.mobile_no, ...(customer.xpos_phone_numbers || [])].find(phoneHit);
		if (own) return { tier: ownTier, via: text(own) };
	}
	if (ownName) return { tier: exact ? 0 : 1, via: null };
	// ERPNext copies the primary contact's email and mobile onto the Customer: name that person.
	const own = [customer.mobile_no, customer.email_id].find(has);
	if (own) {
		const person = contacts.find((c) => has(c.full_name)) || contacts.find((c) => [...c.emails, ...c.phones].includes(text(own)));
		return { tier: 1, via: person ? (has(person.full_name) ? person.full_name : `${person.full_name} · ${text(own)}`) : text(own) };
	}

	for (const contact of contacts) {
		if (has(contact.full_name)) return { tier: 2, via: contact.full_name };
		const email = contact.emails.find(has);
		if (email) return { tier: 2, via: `${contact.full_name} · ${email}` };
	}
	return null;
}

/** The cached customers matching ``term``: exact first, then their own fields, then via a contact. */
export function rankCustomerMatches(customers: Customer[], term: string, limit = 20): Customer[] {
	if (!term.trim()) return customers.slice(0, limit);
	return customers
		.map((customer, index) => ({ customer, index, match: matchCustomer(customer, term) }))
		.filter((row): row is { customer: Customer; index: number; match: CustomerMatch } => row.match !== null)
		.sort(
			(a, b) =>
				a.match.tier - b.match.tier ||
				(a.customer.xpos_cache_rank ?? a.index) - (b.customer.xpos_cache_rank ?? b.index) ||
				a.index - b.index,
		)
		.slice(0, limit)
		.map((row) => row.customer);
}
