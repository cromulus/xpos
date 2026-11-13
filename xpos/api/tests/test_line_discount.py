# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""A money line discount charges what the cart showed.

The cashier types a money discount on a cart line as money off the whole line: $10 off
4 units at $10 shows -$10 and a $30.00 line. ``create_invoice`` takes a line's
``discount_amount`` per unit (``rate = price_list_rate - discount_amount``), so the cart
sends the typed amount divided by the quantity, to the cent
(``frontend/src/utils/lineDiscount.ts``). These tests post the payloads the cart builds
for such lines and check the rate each line gets, and that ``rate x qty`` is the line
total the cart showed. Where the division does not come out even ($5 over 3 units) the
posted line can differ from the shown total by less than ``qty`` x half a cent.
"""

import unittest
from unittest.mock import MagicMock, patch

from frappe.utils import flt

from xpos.api import invoices
from xpos.api.tests.test_invoices import tender_legs_from_payments

# (qty, price list rate, line discount the cashier typed, per-unit discount the cart
# posts, line total the cart shows). The per-unit figures are perUnitDiscount(...).
EVEN_LINES = [
	(1, 23.47, 3.00, 3.0, 20.47),
	(4, 10.00, 10.00, 2.5, 30.00),
	(4, 10.00, 6.60, 1.65, 33.40),
	(12.5, 0.6, 2.50, 0.2, 5.00),
]
UNEVEN_LINES = [
	(3, 10.00, 5.00, 1.67, 25.00),
	(4, 10.00, 6.66, 1.67, 33.34),
]


class TestALineDiscountChargesWhatTheCartShowed(unittest.TestCase):
	def setUp(self):
		self.stub("build_tender_legs", side_effect=tender_legs_from_payments)
		self.stub("build_change_legs", return_value=([], 0.0))
		self.stub("invoice_currency_of", return_value="USD")
		self.stub("get_currency_precision", return_value=2)
		self.stub(
			"resolve_pos_profile",
			side_effect=lambda name: invoices.frappe.get_cached_doc("POS Profile", name),
		)
		self.stub("repricing_changes", return_value=None)
		self.stub("validate_sale_discounts")
		self.stub("check_zero_payable")
		# The cashier may change prices, so each line keeps the rate the cart sent.
		patcher = patch("xpos.api.auth.user_has_pos_permission", return_value=True)
		patcher.start()
		self.addCleanup(patcher.stop)

	def stub(self, name, **kwargs):
		"""Patch ``name`` in the xpos.api.invoices namespace for the current test."""
		patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _post(self, mock_frappe, lines):
		"""Run create_invoice on the cart's payload; return the invoice rows it appended."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"
		mock_frappe.db.get_default.return_value = "3"

		rows = []

		def append(table, data):
			if table != "items":
				return MagicMock()
			row = MagicMock()
			rows.append(row)
			return row

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-LD"
		mock_invoice.as_dict.return_value = {"name": "INV-LD"}
		mock_invoice.append.side_effect = append
		mock_frappe.new_doc.return_value = mock_invoice

		items = [
			{
				"item_code": f"ITEM-{index}",
				"qty": qty,
				"rate": rate,
				"price_list_rate": rate,
				"uom": "Nos",
				"discount_percentage": 0,
				"discount_amount": per_unit,
			}
			for index, (qty, rate, _typed, per_unit, _shown) in enumerate(lines)
		]
		total = sum(shown for *_rest, shown in lines)
		invoices.create_invoice(
			{
				"pos_profile": "POS-PROFILE-1",
				"customer": "Customer A",
				"items": items,
				"payments": [{"mode_of_payment": "Cash", "amount": total}],
			}
		)
		self.assertEqual(len(rows), len(lines))
		return rows

	@patch("xpos.api.invoices.frappe")
	def test_an_even_split_posts_the_line_total_the_cart_showed(self, mock_frappe):
		"""$10 off 4 units at $10 posts $2.50 a unit and charges $30.00, not $0."""
		rows = self._post(mock_frappe, EVEN_LINES)
		for row, (qty, rate, typed, per_unit, shown) in zip(rows, EVEN_LINES):
			self.assertEqual(row.price_list_rate, rate)
			self.assertEqual(row.discount_amount, per_unit)
			self.assertEqual(row.rate, flt(rate - per_unit, 3))
			self.assertEqual(flt(qty * row.rate, 2), shown)
			self.assertEqual(flt(qty * rate - qty * row.rate, 2), typed)

	@patch("xpos.api.invoices.frappe")
	def test_an_uneven_split_comes_within_half_a_cent_a_unit(self, mock_frappe):
		"""$5 off 3 units at $10 posts $1.67 a unit: $24.99 against the $25.00 shown."""
		rows = self._post(mock_frappe, UNEVEN_LINES)
		for row, (qty, rate, _typed, per_unit, shown) in zip(rows, UNEVEN_LINES):
			self.assertEqual(row.discount_amount, per_unit)
			self.assertLessEqual(abs(flt(qty * row.rate, 2) - shown), qty * 0.005 + 1e-9)

	@patch("xpos.api.invoices.frappe")
	def test_the_line_total_sent_as_discount_amount_comes_off_every_unit(self, mock_frappe):
		"""Why the cart divides: the server reads discount_amount per unit, so sending the
		line's $10 on 4 units at $10 took $40 off and charged nothing."""
		rows = self._post(mock_frappe, [(4, 10.0, 10.0, 10.0, 0.0)])
		self.assertEqual(rows[0].discount_amount, 10.0)
		self.assertEqual(flt(4 * rows[0].rate, 2), 0.0)
