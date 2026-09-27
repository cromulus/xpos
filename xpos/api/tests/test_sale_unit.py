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


def _item(code, stock_uom, sales_uom=None, factor=None):
	item = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": code,
			"item_name": code,
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			"stock_uom": stock_uom,
			"sales_uom": sales_uom,
			"is_stock_item": 1,
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
