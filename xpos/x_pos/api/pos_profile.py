# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""POS Profile hooks (Mule City, MuleCity-fb00.2)."""

import frappe
from frappe import _

from xpos.api.invoices import normalize_initials


def validate(doc, method=None):
	validate_cashier_initials(doc)


def validate_cashier_initials(doc):
	"""Each cashier's initials must be unique on the profile.

	Pay matches typed initials to this list, so two rows with the same
	initials would make the sale's cashier ambiguous.
	"""
	seen = set()
	for row in doc.get("xpos_cashiers") or []:
		initials = normalize_initials(row.initials)
		if initials in seen:
			frappe.throw(
				_("Cashier initials {0} appear more than once on POS Profile {1}.").format(initials, doc.name)
			)
		seen.add(initials)
		row.initials = initials
