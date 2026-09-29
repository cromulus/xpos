"""A line billed from a Sales Order keeps the order's price (MuleCity-jfdy).

The live story (as a counter login, through create_invoice) is in
mulecity_erpnext's test_xpos_counter_settings (TestPickupKeepsTheOrderPrice).
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api import invoices


def order_row(**values):
	base = dict(parent="SO-1", item_code="FEED", rate=9.0, price_list_rate=9.0,
		discount_percentage=0, discount_amount=0, docstatus=1)
	return frappe._dict({**base, **values})


class TestSalesOrderLine(unittest.TestCase):
	def lookup(self, row, found):
		with patch.object(invoices.frappe.db, "get_value", return_value=found):
			return invoices._sales_order_line(row)

	def test_a_line_naming_its_submitted_order_row_gets_that_row(self):
		row = {"item_code": "FEED", "sales_order": "SO-1", "so_detail": "row-1"}
		self.assertEqual(self.lookup(row, order_row()).rate, 9.0)

	def test_negative_no_so_detail_draft_order_other_item_or_other_order(self):
		self.assertIsNone(invoices._sales_order_line({"item_code": "FEED"}))
		for found, row in (
			(order_row(docstatus=0), {"item_code": "FEED", "so_detail": "row-1"}),
			(order_row(item_code="OTHER"), {"item_code": "FEED", "so_detail": "row-1"}),
			(order_row(), {"item_code": "FEED", "sales_order": "SO-2", "so_detail": "row-1"}),
			(None, {"item_code": "FEED", "so_detail": "gone"}),
		):
			with self.subTest(row=row):
				self.assertIsNone(self.lookup(row, found))


class TestDiscountCapStartsFromTheOrderRate(unittest.TestCase):
	def test_an_order_line_counts_from_its_own_rate(self):
		"""The engine says $10.37; the order line's agreed $9.00 is the cap's start."""
		doc = frappe._dict(items=[
			frappe._dict(item_code="FEED", qty=3, rate=9.0, price_list_rate=9.0, so_detail="row-1", is_free_item=0),
			frappe._dict(item_code="BAG", qty=1, rate=10.37, price_list_rate=10.37, is_free_item=0),
		])
		with patch.object(invoices, "_engine_rates", return_value=[10.37, 10.37]):
			rates = invoices.pricing_rule_rates(doc, frappe._dict(name="P"))
		self.assertEqual(rates, [9.0, 10.37])
