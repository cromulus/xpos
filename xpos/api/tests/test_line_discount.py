"""User stories: a $ line discount charges what the cart showed (MuleCity-1msa).

The cashier types a $ discount on a cart line as money off the whole line: $10
off 4 bags at $10 shows -$10 and a $30.00 line. ``create_invoice`` posts a
line's ``discount_amount`` per unit (``rate = price_list_rate -
discount_amount``), so the cart sends the typed amount divided by the quantity
at the line's 9 places (``frontend/src/utils/lineDiscount.ts``). These tests
post the payloads the cart builds for such lines and check that the Sales
Invoice takes off the line discount the cart showed, to the cent, by the bag
and by the pound, and that its totals are the cart's.
"""

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt

from xpos.api.invoices import _build_invoice_doc

# (qty, price list rate, line discount the cashier typed, per-unit discount the
# cart posts, line total the cart shows). The per-unit figures are
# perUnitDiscount(...) from the cart; $5 over 3 bags does not divide evenly.
BAG_LINES = [
	(1, 23.47, 3.00, 3.0, 20.47),
	(4, 10.00, 10.00, 2.5, 30.00),
	(4, 10.00, 6.66, 1.665, 33.34),
	(3, 10.00, 5.00, 1.666666667, 25.00),
]
POUND_RATE = 0.670571439  # a 35 lb bag at $23.47, by the pound at 9 places
POUND_LINE = (12.5, POUND_RATE, 1.23, 0.0984, 7.15)


def _uom(name, whole=0):
	if not frappe.db.exists("UOM", name):
		frappe.get_doc({"doctype": "UOM", "uom_name": name, "must_be_whole_number": whole}).insert()
	return name


class TestALineDiscountChargesWhatTheCartShowed(IntegrationTestCase):
	def setUp(self):
		self.profile = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not self.profile:
			self.skipTest("needs a POS Profile")
		self.price_list = frappe.db.get_value("POS Profile", self.profile, "selling_price_list")
		self.run = frappe.generate_hash(length=6)
		self.customer = (
			frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": f"XPOS Line Discount {self.run}",
					"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
					"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
				}
			)
			.insert()
			.name
		)

	def _item(self, uom, rate):
		"""A non-stock item sold in ``uom`` at ``rate`` on the profile's price list."""
		code = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": f"XPOS-LD-{uom}-{frappe.generate_hash(length=6)}",
				"item_name": f"Line discount {uom}",
				"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
				"stock_uom": uom,
				"is_stock_item": 0,
			}
		).insert().name
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": code, "price_list": self.price_list, "uom": uom,
			 "price_list_rate": rate}
		).insert()
		return code

	def _post(self, lines, uom):
		"""Save the Sales Invoice the cart's payload becomes; one item per line."""
		items = [
			{
				"item_code": self._item(uom, rate),
				"qty": qty,
				"rate": rate,
				"price_list_rate": rate,
				"uom": uom,
				"discount_percentage": 0,
				"discount_amount": per_unit,
			}
			for qty, rate, _typed, per_unit, _shown in lines
		]
		doc = _build_invoice_doc({"pos_profile": self.profile, "customer": self.customer, "items": items})[0]
		doc.insert(ignore_permissions=True)
		return doc

	def assertChargesWhatTheCartShowed(self, doc, lines):
		for row, (qty, rate, typed, _per_unit, shown) in zip(doc.items, lines):
			# The line posts the total the cart showed, i.e. the discount the cashier typed.
			self.assertEqual(flt(row.amount, 2), shown, row.item_code)
			self.assertEqual(flt(qty * flt(row.price_list_rate) - flt(row.amount), 2), typed, row.item_code)
		# The ticket is the cart's: the lines it showed, plus sales tax on that net as
		# the cart figures it (each On Net Total rate, to the cent).
		shown_total = flt(sum(line[-1] for line in lines), 2)
		self.assertEqual(flt(doc.net_total, 2), shown_total)
		self.assertTrue(all(tax.charge_type == "On Net Total" for tax in doc.taxes))
		cart_tax = sum(flt(shown_total * flt(tax.rate) / 100, 2) for tax in doc.taxes)
		self.assertEqual(flt(doc.grand_total, 2), flt(shown_total + cart_tax, 2))

	def test_by_the_bag_at_one_three_and_four_bags(self):
		"""$10 off 4 bags at $10 charges $30.00, not $0; $5 off 3 bags charges $25.00."""
		bag = _uom("XPOS Test Bag", whole=1)
		doc = self._post(BAG_LINES, bag)
		self.assertChargesWhatTheCartShowed(doc, BAG_LINES)

	def test_by_the_pound(self):
		"""$1.23 off 12.5 lb at $0.670571439/lb charges $7.15."""
		pound = _uom("XPOS Test Fractional Pound")
		doc = self._post([POUND_LINE], pound)
		self.assertChargesWhatTheCartShowed(doc, [POUND_LINE])

	def test_the_old_payload_took_the_line_discount_off_every_unit(self):
		"""Before MuleCity-1msa the cart sent the line total as ``discount_amount``:
		$10 on 4 bags at $10 took $40 off. The server still reads it per unit."""
		bag = _uom("XPOS Test Bag", whole=1)
		doc = self._post([(4, 10.0, 10.0, 10.0, 0.0)], bag)
		self.assertEqual(flt(doc.items[0].amount, 2), 0.0)
