"""Made-to-order items (Mule City MuleCity-3j1m): sold before any stock exists.

A site names them through the ``xpos_made_to_order_items`` hook (Mule City:
its custom mixes). XPOS keeps them under "hide unavailable items" and flags
each with ``is_made_to_order`` so the cart doesn't refuse it for lacking stock.
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api import items


def site_mixes(pos_profile):
	return ["MC-MIX-BEN", "MC-MIX-ANN"] if pos_profile == "Mule City Retail" else []


class TestMadeToOrderItems(unittest.TestCase):
	def hooks(self, methods):
		return patch.object(items.frappe, "get_hooks", return_value=methods)

	def test_the_hooks_name_the_items_for_the_profile(self):
		with self.hooks(["some.site.mixes"]), patch.object(items.frappe, "get_attr", return_value=site_mixes):
			self.assertEqual(items.made_to_order_items("Mule City Retail"), {"MC-MIX-BEN", "MC-MIX-ANN"})

	def test_negative_no_hook_no_profile_or_nothing_returned(self):
		with self.hooks([]):
			self.assertEqual(items.made_to_order_items("Mule City Retail"), set())
		with self.hooks(["some.site.mixes"]), patch.object(items.frappe, "get_attr", return_value=site_mixes):
			self.assertEqual(items.made_to_order_items(None), set())
			self.assertEqual(items.made_to_order_items("Other Profile"), set())


class TestTheCountIncludesThem(unittest.TestCase):
	def count_sql(self, made_to_order):
		pos = frappe._dict(hide_unavailable_items=1, warehouse="Main - MC", item_groups=[])
		captured = {}

		def fake_sql(sql, values):
			captured.update(sql=sql, values=values)
			return [[3]]

		with (
			patch.object(items.frappe, "get_cached_doc", return_value=pos),
			patch.object(items, "made_to_order_items", return_value=made_to_order),
			patch.object(items.frappe.db, "sql", side_effect=fake_sql, create=True),
		):
			self.assertEqual(items.get_items_count("Mule City Retail"), 3)
		return captured

	def test_made_to_order_items_count_with_no_stock(self):
		captured = self.count_sql({"MC-MIX-BEN"})
		self.assertIn("i.name IN %(made_to_order)s", captured["sql"])
		self.assertEqual(captured["values"]["made_to_order"], ("MC-MIX-BEN",))

	def test_negative_without_the_hook_the_stock_filter_is_unchanged(self):
		captured = self.count_sql(set())
		self.assertIn("(i.is_stock_item = 0 OR bin.actual_qty > 0)", captured["sql"])
		self.assertNotIn("made_to_order", captured["values"])


class TestBarcodeFlag(unittest.TestCase):
	def test_a_scanned_made_to_order_item_is_flagged(self):
		with (
			patch.object(items, "_search_barcode", return_value={"item_code": "MC-MIX-BEN"}),
			patch.object(items, "made_to_order_items", return_value={"MC-MIX-BEN"}),
		):
			self.assertEqual(items.search_barcode("MC-MIX-BEN", "Mule City Retail")["is_made_to_order"], 1)
		with (
			patch.object(items, "_search_barcode", return_value={"item_code": "FEED"}),
			patch.object(items, "made_to_order_items", return_value={"MC-MIX-BEN"}),
		):
			self.assertEqual(items.search_barcode("FEED", "Mule City Retail")["is_made_to_order"], 0)
