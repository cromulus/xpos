"""User stories: a counter discount stops at the POS Profile's cap (MuleCity-mxwy.2).

Mule City lets the counter take at most 25% off a ticket; changing an item's
price is for the owners' POS Role. Before this check only a line's discount
percentage was capped, so a line discount amount or the additional discount
could take off any sum. ``check_discount_cap`` counts them together against
the lines' price list rates. The live story (as a counter login, through
create_invoice) is in mulecity_erpnext's test_xpos_counter_settings.
"""

import unittest

import frappe
from frappe.utils import flt

from xpos.api.invoices import check_discount_cap


def ticket(*lines, additional_discount_percentage=0, discount_amount=0):
	"""An unsaved invoice as _build_invoice_doc leaves it: (qty, list rate, rate[, free])."""
	return frappe._dict(
		items=[
			frappe._dict(qty=qty, price_list_rate=plr, rate=rate, is_free_item=(rest or [0])[0])
			for qty, plr, rate, *rest in lines
		],
		additional_discount_percentage=additional_discount_percentage,
		discount_amount=discount_amount,
	)


class TestDiscountCap(unittest.TestCase):
	def assertRefused(self, doc, cap=25):
		with self.assertRaisesRegex(frappe.ValidationError, "at most 25.0% is allowed"):
			check_discount_cap(doc, cap)

	def test_a_quarter_off_is_allowed(self):
		"""25% off one line, or as the additional discount, posts."""
		check_discount_cap(ticket((2, 10.37, flt(10.37 * 0.75, 3))), 25)
		check_discount_cap(ticket((2, 10.37, 10.37), additional_discount_percentage=25), 25)

	def test_more_than_the_cap_is_refused_however_it_is_given(self):
		"""30% as the additional discount, $5 off a $10.37 line (48%), or a
		$5 header discount on a $10.37 ticket: each is refused."""
		self.assertRefused(ticket((1, 10.37, 10.37), additional_discount_percentage=30))
		self.assertRefused(ticket((1, 10.37, 5.37)))
		self.assertRefused(ticket((1, 10.37, 10.37), discount_amount=5))

	def test_line_and_additional_discounts_count_together(self):
		"""20% off the line and 20% more off the ticket is 36% off: refused."""
		self.assertRefused(ticket((1, 100, 80), additional_discount_percentage=20))

	def test_the_cap_is_on_the_whole_ticket(self):
		"""A bigger discount on one cheap line is fine when the ticket is within
		the cap: $5 off a $10 line on a $100 ticket is 5% off."""
		check_discount_cap(ticket((1, 10, 5), (1, 90, 90)), 25)

	def test_free_items_and_no_cap_are_left_alone(self):
		"""A free item has no price to discount; a profile without a cap (0) checks nothing."""
		check_discount_cap(ticket((1, 10, 10), (1, 5, 0, 1)), 25)
		check_discount_cap(ticket((1, 10, 1), additional_discount_percentage=90), 0)
