# Copyright (c) 2026, Ali Raxa and Contributors
# For license information, please see license.txt

"""Stock tax resolution for the till: the buyer's taxes as ERPNext resolves them.

These are the defaults behind the ``tax_context`` / ``tax_contexts`` keys of the
boot ``xpos_site`` map and the ``xpos_apply_taxes`` hook (``site_hooks``). A
site with its own rules (wording for an exemption, an order's own tax rows on
a pickup) registers its own methods; XPOS never calls a site app directly.

Resolution is ERPNext's: ``erpnext.accounts.party.get_party_details`` (the
customer's Tax Category and the matching Tax Rule), and with no match the POS
Profile's own Sales Taxes and Charges Template. A site with no Tax Rules
therefore taxes exactly as before: by the profile's template.
"""

from __future__ import annotations

import frappe
from frappe.utils import nowdate

from xpos.api.profiles import resolve_pos_profile


def _context(template, tax_category, tax_exempt_reason=None) -> dict:
	"""The context the till taxes a cart with: category, template and its rows."""
	from erpnext.controllers.accounts_controller import get_taxes_and_charges

	return {
		"tax_category": tax_category,
		"tax_exempt_reason": tax_exempt_reason,
		"taxes_and_charges": template,
		"taxes": get_taxes_and_charges("Sales Taxes and Charges Template", template) if template else [],
	}


def _party_template(profile, customer, posting_date) -> tuple[str | None, str | None]:
	"""(template, tax category) ERPNext resolves for this buyer at this register."""
	from erpnext.accounts.doctype.tax_rule.tax_rule import get_tax_template
	from erpnext.accounts.party import get_party_details

	if not customer:
		template = get_tax_template(
			posting_date or nowdate(), {"tax_category": "", "company": profile.company, "tax_type": "Sales"}
		)
		return template or profile.taxes_and_charges, None
	party = get_party_details(
		party=customer,
		party_type="Customer",
		company=profile.company,
		posting_date=posting_date or nowdate(),
		doctype="Sales Invoice",
		price_list=profile.selling_price_list,
		currency=profile.currency,
		pos_profile=profile.name,
	)
	return party.get("taxes_and_charges") or profile.taxes_and_charges, party.get("tax_category")


@frappe.whitelist()
def tax_context(customer: str | None = None, pos_profile: str | None = None, posting_date: str | None = None):
	"""The buyer's taxes at this register (no customer: the register's default customer's)."""
	profile = resolve_pos_profile(pos_profile)
	customer = customer or profile.customer
	if customer:
		# The same gate as the till's customer reads: the profile's groups (its
		# walk-ins included) and the caller's User Permissions.
		from xpos.api.customers import require_customer_access

		require_customer_access(customer, "read", profile.name)
	template, category = _party_template(profile, customer, posting_date)
	return _context(template, category)


@frappe.whitelist()
def tax_contexts(pos_profile: str, posting_date: str | None = None):
	"""Every Tax Category's context at this register, kept by the till for offline use.

	Keyed by category name; "" is a customer with none. Exact when the site's
	Tax Rules depend on the category only; a rule naming a customer or group is
	resolved online by ``tax_context``.
	"""
	from erpnext.accounts.doctype.tax_rule.tax_rule import get_tax_template

	profile = resolve_pos_profile(pos_profile)
	filters = {"disabled": 0} if frappe.get_meta("Tax Category").has_field("disabled") else {}
	categories = ["", *frappe.get_all("Tax Category", filters=filters, pluck="name", order_by="name")]
	contexts = {}
	for category in categories:
		template = get_tax_template(
			posting_date or nowdate(),
			{"tax_category": category, "company": profile.company, "tax_type": "Sales"},
		)
		contexts[category] = _context(template or profile.taxes_and_charges, category or None)
	return contexts


def apply_party_taxes(doc) -> None:
	"""Tax an invoice the till is building as ERPNext would tax this buyer.

	Returns keep what the cart built (ERPNext's return validation holds them to
	the original). A sale whose buyer resolves to a different template than the
	profile's gets that template's rows, plus any Item Tax Template rows.
	"""
	if not doc.get("pos_profile") or not doc.get("customer") or doc.get("is_return"):
		return
	profile = frappe.get_cached_doc("POS Profile", doc.pos_profile)
	template, category = _party_template(profile, doc.customer, doc.get("posting_date"))
	if category is not None:
		doc.tax_category = category
	if not template or (template == doc.get("taxes_and_charges") and doc.get("taxes")):
		return
	from xpos.x_pos.api.utilities import add_taxes_from_tax_template

	context = _context(template, category)
	doc.taxes_and_charges = template
	doc.set("taxes", context["taxes"])
	for row in doc.items:
		if row.get("item_tax_template"):
			add_taxes_from_tax_template({"item_tax_template": row.item_tax_template}, doc)
