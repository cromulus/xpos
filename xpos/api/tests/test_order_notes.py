# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The till's note on a Sales Order header (Mule City, MuleCity-qajl.7).

Bill (2026-10-01): "we should be able to add notes to sales, orders, and returns
as well." Sales and returns keep the cart's note in the Sales Invoice / POS
Invoice field ``pos_notes``. A Sales Order had a note only on its items
(``pos_additional_notes``), so the fork adds ``pos_notes`` to the Sales Order
header too. Same fieldname, never ``no_copy``: ERPNext's own
``make_sales_invoice`` then carries an order's note onto the invoice made from
it (a pickup), with no code.
"""

import json
import os
import unittest
from unittest.mock import MagicMock, patch

from xpos.api import sales_orders

CUSTOM = os.path.join(os.path.dirname(__file__), "..", "..", "x_pos", "custom")


def custom_field(doctype_file, fieldname):
	with open(os.path.join(CUSTOM, doctype_file)) as handle:
		fields = json.load(handle)["custom_fields"]
	return next((row for row in fields if row["fieldname"] == fieldname), None)


class TestSalesOrderNoteField(unittest.TestCase):
	def test_the_sales_order_header_has_pos_notes_like_the_invoices(self):
		order = custom_field("sales_order.json", "pos_notes")
		invoice = custom_field("sales_invoice.json", "pos_notes")
		self.assertIsNotNone(order, "Sales Order has no pos_notes custom field")
		self.assertEqual(order["dt"], "Sales Order")
		self.assertEqual(order["name"], "Sales Order-pos_notes")
		self.assertEqual(order["fieldtype"], invoice["fieldtype"])
		# Mapped to the pickup invoice by fieldname: neither side may be no_copy.
		self.assertEqual((order["no_copy"], invoice["no_copy"]), (0, 0))
		self.assertEqual(order["insert_after"], "delivery_date")

	def test_the_field_is_installed_on_this_site(self):
		"""On a migrated site (erp2 slots), both doctypes carry the field."""
		import frappe

		if not getattr(frappe.local, "site", None):
			self.skipTest("No site: the custom JSON check above covers the field")
		for doctype in ("Sales Order", "Sales Invoice"):
			field = frappe.get_meta(doctype).get_field("pos_notes")
			self.assertIsNotNone(field, f"{doctype} has no pos_notes; run bench migrate")
			self.assertFalse(field.no_copy)


class TestCreateSalesOrderKeepsTheNote(unittest.TestCase):
	def _create(self, mock_frappe, notes):
		pos = MagicMock(company="Mule City", currency="USD", selling_price_list="Retail", warehouse="Store - MC")
		mock_frappe.get_cached_doc.return_value = pos
		mock_frappe.db.exists.return_value = False
		order = MagicMock()
		order.items = []
		mock_frappe.new_doc.return_value = order
		data = {"pos_profile": "Counter", "customer": "SMITH", "items": [{"item_code": "LAYER", "qty": 1, "rate": 20}]}
		if notes is not None:
			data["pos_notes"] = notes
		with patch("xpos.api.sales_orders.apply_sales_person"):
			sales_orders.create_sales_order(json.dumps(data))
		return order

	@patch("xpos.api.sales_orders.frappe")
	def test_the_note_goes_on_the_order_header(self, mock_frappe):
		order = self._create(mock_frappe, "  Call Steve first ")
		self.assertEqual(order.pos_notes, "Call Steve first")
		order.save.assert_called_once()

	@patch("xpos.api.sales_orders.frappe")
	def test_no_note_leaves_the_header_blank(self, mock_frappe):
		self.assertEqual(self._create(mock_frappe, None).pos_notes, "")
