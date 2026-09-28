"""Counter stories: an item sold in a bigger unit than it is stocked in.

A feed is stocked in kilograms and sold by the 25 kg sack (Item "Default Sales
Unit of Measure" = Sack, 1 Sack = 25 Kg). ERPNext starts a selling line in the
sales UOM with its conversion factor; one tap at the register must do the same,
priced for that unit by the standard Item Price lookup.
"""

import frappe
from frappe.tests import IntegrationTestCase

from xpos.api.items import sale_unit, sale_uoms

PRICE_LIST = "Standard Selling"


def _uom(name):
	if not frappe.db.exists("UOM", name):
		frappe.get_doc({"doctype": "UOM", "uom_name": name}).insert()
	return name


def _item(code, stock_uom, sales_uom=None, factor=None, **fields):
	item = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": code,
			"item_name": code,
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			"stock_uom": stock_uom,
			"sales_uom": sales_uom,
			"is_stock_item": 1,
			**fields,
		}
	)
	if factor:
		item.append("uoms", {"uom": sales_uom, "conversion_factor": factor})
	return item.insert().name


def _price(item_code, uom, rate):
	frappe.get_doc(
		{"doctype": "Item Price", "item_code": item_code, "price_list": PRICE_LIST, "uom": uom,
		 "price_list_rate": rate}
	).insert()


class TestSaleUnit(IntegrationTestCase):
	def setUp(self):
		self.kg, self.sack = _uom("Kg"), _uom("XPOS Test Sack")
		self.run = frappe.generate_hash(length=6)

	def test_a_sack_feed_rings_up_one_sack_at_the_sack_price(self):
		feed = _item(f"XPOS-SACK-{self.run}", self.kg, self.sack, 25)
		_price(feed, self.sack, 18.0)
		self.assertEqual(sale_uoms([feed])[feed], (self.sack, 25.0))
		self.assertEqual(sale_unit(feed, PRICE_LIST), {"uom": self.sack, "conversion_factor": 25.0, "rate": 18.0})

	def test_a_sack_is_priced_from_the_stock_unit_price_when_it_has_none(self):
		feed = _item(f"XPOS-KGP-{self.run}", self.kg, self.sack, 25)
		_price(feed, self.kg, 0.5)
		self.assertEqual(sale_unit(feed, PRICE_LIST)["rate"], 12.5)

	def test_an_item_with_no_sales_unit_sells_its_stock_unit(self):
		feed = _item(f"XPOS-KG-{self.run}", self.kg)
		_price(feed, self.kg, 0.5)
		self.assertEqual(sale_unit(feed, PRICE_LIST), {"uom": self.kg, "conversion_factor": 1.0, "rate": 0.5})

	def test_a_sales_unit_without_a_conversion_is_not_sold_as_one_stock_unit(self):
		feed = _item(f"XPOS-NOCF-{self.run}", self.kg, self.sack)
		self.assertEqual(sale_uoms([feed])[feed], (self.kg, 1.0))

	def test_a_barcode_unit_is_priced_for_that_unit(self):
		feed = _item(f"XPOS-BC-{self.run}", self.kg, self.sack, 25)
		_price(feed, self.kg, 0.5)
		self.assertEqual(sale_unit(feed, PRICE_LIST, uom=self.kg), {"uom": self.kg, "conversion_factor": 1.0, "rate": 0.5})

	def test_a_serialised_item_sells_its_stock_unit(self):
		"""One serial number is one stock unit, so a sack of 25 serials is not one line."""
		feed = _item(f"XPOS-SER-{self.run}", self.kg, self.sack, 25, has_serial_no=1)
		self.assertEqual(sale_uoms([feed])[feed], (self.kg, 1.0))


class TestSwitchingACartLineUnit(IntegrationTestCase):
	"""Mule City (MuleCity-mxwy.8): a 35 lb bag at $23.47, stocked by the Bag,
	sells by the pound at bag price ÷ weight. The cart asks ``get_sale_unit``
	for the new unit's price, the one the invoice price lock posts."""

	def setUp(self):
		self.bag, self.lb = _uom("XPOS Test Bag"), _uom("XPOS Test Pound")
		self.run = frappe.generate_hash(length=6)
		self.profile = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not self.profile:
			self.skipTest("needs a POS Profile")
		self.price_list = frappe.db.get_value("POS Profile", self.profile, "selling_price_list") or PRICE_LIST
		self.feed = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": f"XPOS-LB-{self.run}",
				"item_name": "35 lb feed",
				"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
				"stock_uom": self.bag,
				"is_stock_item": 1,
				"uoms": [{"uom": self.lb, "conversion_factor": round(1 / 35, 9)}],
			}
		).insert().name
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": self.feed, "price_list": self.price_list,
			 "uom": self.bag, "price_list_rate": 23.47}
		).insert()

	def test_the_pound_is_the_bag_price_times_its_factor(self):
		from xpos.api.items import get_sale_unit

		unit = get_sale_unit(self.feed, self.profile, self.lb)
		self.assertEqual(unit["uom"], self.lb)
		self.assertEqual(unit["conversion_factor"], round(1 / 35, 9))
		self.assertAlmostEqual(unit["rate"], 23.47 * round(1 / 35, 9), places=9)
		self.assertEqual(round(unit["rate"] * 35, 2), 23.47)
		self.assertEqual(get_sale_unit(self.feed, self.profile, self.bag)["rate"], 23.47)

	def test_a_unit_the_item_does_not_have_is_refused(self):
		from xpos.api.items import get_sale_unit

		with self.assertRaises(frappe.ValidationError):
			get_sale_unit(self.feed, self.profile, _uom("XPOS Test Ton"))

	def test_the_cart_rounds_rates_like_the_invoice_line(self):
		"""The settings the SPA loads carry the invoice line's rate precision."""
		from xpos.api.settings import _item_rate_precision

		field = frappe.get_meta("Sales Invoice Item").get_field("rate")
		self.assertGreaterEqual(_item_rate_precision(), frappe.utils.cint(field.precision))
		self.assertGreaterEqual(_item_rate_precision(), frappe.utils.cint(frappe.db.get_default("float_precision")))
