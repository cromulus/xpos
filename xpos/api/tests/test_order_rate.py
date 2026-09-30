"""A line billed from a Sales Order keeps the order's price (MuleCity-jfdy).

The live story (as a counter login, through create_invoice) is in
mulecity_erpnext's test_xpos_counter_settings (TestPickupKeepsTheOrderPrice).
"""

import unittest
import unittest.mock
from unittest.mock import patch

import frappe

from xpos.api import invoices


def order_row(**values):
	base = dict(parent="SO-1", item_code="FEED", rate=9.0, price_list_rate=9.0,
		discount_percentage=0, discount_amount=0, docstatus=1)
	return frappe._dict({**base, **values})


class TestSalesOrderLine(unittest.TestCase):
	def lookup(self, row, found):
		with patch.object(invoices.frappe, "get_meta"), patch.object(invoices.frappe.db, "get_value", return_value=found):
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


class TestNativeOrderTransport(unittest.TestCase):
	def test_native_links_and_literal_notes_survive_but_old_quote_evidence_does_not(self):
		"""Pickup transports the native source row without reviving a parallel quote."""
		row = {"sales_order": "SO-1", "so_detail": "ROW-1", "bom_no": "BOM-1",
			"mule_processing_instructions": "CRACK <<2X>>\n2 PALLETS",
			"mule_source_bom": "OLD", "mule_mix_quote": "QUOTE", "rate": 999}
		self.assertEqual(invoices._mule_order_fields(row), {
			key: row[key] for key in ("sales_order", "so_detail", "bom_no", "mule_processing_instructions")})
		self.assertEqual(invoices._mule_order_fields({"item_code": "CORN"}), {})

	def test_optional_mill_instructions_are_read_only_when_the_field_exists(self):
		"""A plain ERPNext site has no Mule fields; a Mule site reads its order note."""
		for has_field in (False, True):
			with self.subTest(has_field=has_field), patch.object(invoices.frappe, "get_meta") as meta, patch.object(
				invoices.frappe.db, "get_value", return_value=order_row()) as lookup:
				meta.return_value.has_field.return_value = has_field
				invoices._sales_order_line({"item_code": "FEED", "so_detail": "ROW-1"})
				self.assertEqual("mule_processing_instructions" in lookup.call_args.args[2], has_field)


class TestOrderAdvances(unittest.TestCase):
	"""MuleCity-fxh: a ticket billing an order uses what was paid on the order."""

	def test_the_orders_own_advances_are_set_on_the_ticket(self):
		doc = frappe._dict(company="Mule", currency="USD", conversion_rate=None)
		doc.calculate_taxes_and_totals = unittest.mock.Mock()
		doc.set_advances = unittest.mock.Mock()
		with patch.object(invoices.frappe, "get_cached_value", return_value="USD"):
			invoices._set_order_advances(doc)
		self.assertEqual(doc.only_include_allocated_payments, 1)
		self.assertEqual(doc.conversion_rate, 1)
		doc.calculate_taxes_and_totals.assert_called_once()
		doc.set_advances.assert_called_once()

	def test_the_expected_total_is_what_the_register_collected(self):
		"""$31.11 ticket, $20 paid on the order: the register showed $11.11."""
		doc = frappe._dict(grand_total=31.11, rounded_total=0, total_advance=20, is_return=0, currency="USD")
		with patch.object(invoices, "get_currency_precision", return_value=2), patch.object(
			invoices, "invoice_currency_of", return_value="USD"
		):
			invoices.check_expected_total(doc, {"expected_total": 11.11})
			with self.assertRaises(frappe.ValidationError):
				invoices.check_expected_total(doc, {"expected_total": 31.11})
