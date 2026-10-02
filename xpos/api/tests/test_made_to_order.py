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


def mix_price(**kwargs):
	"""A site pricing its own items (Mule City: a custom mix from its recipe)."""
	if kwargs["item_code"] != "MC-MIX-BEN":
		return None
	if kwargs["price_list"] == "Broken":
		frappe.throw("Corn has no price in Broken valid today, so the mix cannot be priced.")
	return 10.0 if kwargs["uom"] == "Bag" else 0.2


class TestSitePricedItems(unittest.TestCase):
	"""MuleCity-zstm.20: a custom mix has no Item Price, so the till showed $0.00.
	``selling_price`` asks the ``xpos_list_rate`` hooks first; an item no hook
	prices keeps ERPNext's Item Price lookup."""

	def price(self, item_code, price_list="Standard Selling", uom="Bag", native=3.5):
		item = frappe._dict(stock_uom="Bag", variant_of=None)
		with (
			patch.object(items.frappe, "get_hooks", side_effect=lambda name: ["site.mix_price"] if name == items.LIST_RATE_HOOK else []),
			patch.object(items.frappe, "get_attr", return_value=mix_price),
			patch.object(items.frappe, "get_cached_value", return_value=item),
			patch("erpnext.stock.get_item_details.get_conversion_factor", return_value={"conversion_factor": 0.02}),
			patch("erpnext.stock.get_item_details.get_price_list_rate_for", return_value=native) as native_lookup,
		):
			return items.selling_price(item_code, price_list, uom=uom), native_lookup

	def test_the_site_prices_its_mix_in_the_unit_sold(self):
		self.assertEqual(self.price("MC-MIX-BEN")[0], 10.0)
		rate, native_lookup = self.price("MC-MIX-BEN", uom="Pound")
		self.assertEqual(rate, 0.2)
		native_lookup.assert_not_called()

	def test_negative_an_item_the_site_does_not_price_keeps_its_item_price(self):
		rate, native_lookup = self.price("FEED")
		self.assertEqual(rate, 3.5)
		native_lookup.assert_called_once()

	def test_negative_a_mix_the_site_cannot_price_says_why(self):
		with self.assertRaisesRegex(frappe.ValidationError, "Corn has no price"):
			self.price("MC-MIX-BEN", price_list="Broken")
