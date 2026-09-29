"""User stories: a cash sale paid with change posts (MuleCity-ztb9).

The counter rings up $10.37 of feed, the customer hands over a $50 bill, and the
cashier gives $39.63 back. The register sends the tender and one change row:

    payments:        [{mode_of_payment: Cash, amount: 50}]
    change_amount:   39.63
    pos_change_legs: [{mode_of_payment: Cash, currency: USD, amount: 39.63,
                       exchange_rate: 1, base_amount: 39.63}]

Online, Pay posts that at once; offline, the register queues it and
``syncPendingInvoices`` replays the same payload through ``create_invoice`` on
reconnect. Before the fix every such sale was refused with "POS Change Leg Row
#1: Value missing for: Currency": the change row's ``currency`` was fetched from
the Mode of Payment's tender currency on save, and Mule City's Cash mode has none
(it pays in the company currency), so the fetch blanked the currency the server
had set. The field now fetches only when empty.
"""

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt

from xpos.api.exchange import tender_currency_field_exists
from xpos.api.invoices import _build_invoice_doc, create_invoice
from xpos.api.utilities import get_invoice_type

CHANGE = 39.63


class TestACashSaleWithChangePosts(IntegrationTestCase):
	def setUp(self):
		self.profile = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not self.profile:
			self.skipTest("needs a POS Profile")
		self.cash = self._untagged_cash_mode()
		if not self.cash:
			self.skipTest("needs a Cash mode of payment on the POS Profile with no tender currency")
		company = frappe.db.get_value("POS Profile", self.profile, "company")
		self.currency = frappe.get_cached_value("Company", company, "default_currency")
		self.run = frappe.generate_hash(length=6)
		self.customer = (
			frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": f"XPOS Change Legs {self.run}",
					"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
					"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
				}
			)
			.insert()
			.name
		)
		self.item = self._item(10.37)

	def _untagged_cash_mode(self):
		"""The profile's Cash mode that pays in the company currency, like Mule City's Cash."""
		modes = frappe.get_all(
			"POS Payment Method", filters={"parent": self.profile}, pluck="mode_of_payment"
		)
		for mode in modes:
			if frappe.db.get_value("Mode of Payment", mode, "type") != "Cash":
				continue
			if tender_currency_field_exists() and frappe.db.get_value(
				"Mode of Payment", mode, "pos_tender_currency"
			):
				continue
			return mode
		return None

	def _item(self, rate):
		"""A non-stock item at ``rate`` on the profile's price list."""
		price_list = frappe.db.get_value("POS Profile", self.profile, "selling_price_list")
		code = (
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": f"XPOS-CHG-{self.run}",
					"item_name": "Change legs feed",
					"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
					"stock_uom": "Nos",
					"is_stock_item": 0,
				}
			)
			.insert()
			.name
		)
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": code, "price_list": price_list, "price_list_rate": rate}
		).insert()
		return code

	def _cart(self):
		return {
			"pos_profile": self.profile,
			"customer": self.customer,
			"items": [{"item_code": self.item, "qty": 1, "rate": 10.37, "price_list_rate": 10.37}],
		}

	def _total_due(self):
		"""What the register would charge for the cart: its total with tax, as ERPNext posts it."""
		draft = _build_invoice_doc(self._cart())[0]
		draft.insert(ignore_permissions=True)
		return flt(draft.rounded_total or draft.grand_total, 2)

	def _queued_sale(self):
		"""The payload the register queues offline (and sends online) for a sale paid with change."""
		tendered = flt(self._total_due() + CHANGE, 2)
		return {
			**self._cart(),
			"payments": [{"mode_of_payment": self.cash, "amount": tendered}],
			"change_amount": CHANGE,
			"pos_change_legs": [
				{
					"mode_of_payment": self.cash,
					"currency": self.currency,
					"amount": CHANGE,
					"exchange_rate": 1,
					"base_amount": CHANGE,
				}
			],
		}, tendered

	def assertPostedWithChange(self, doc, tendered):
		self.assertEqual(flt(doc.paid_amount, 2), tendered)
		self.assertEqual(flt(doc.change_amount, 2), CHANGE)
		self.assertEqual(len(doc.pos_change_legs), 1)
		leg = doc.pos_change_legs[0]
		self.assertEqual(leg.mode_of_payment, self.cash)
		# The currency the server set survives the save (it used to be blanked).
		self.assertEqual(leg.currency, self.currency)
		self.assertEqual(flt(leg.amount, 2), CHANGE)
		self.assertEqual(flt(leg.base_amount, 2), CHANGE)

	def test_the_change_row_keeps_its_currency_when_saved(self):
		"""The failing step itself: saving the sale no longer drops the change row's currency."""
		data, tendered = self._queued_sale()
		doc = _build_invoice_doc(data)[0]
		doc.insert(ignore_permissions=True)
		self.assertPostedWithChange(doc, tendered)

	def test_a_replayed_offline_sale_with_change_posts(self):
		"""The register comes back online and replays the queued sale: it is submitted,
		shows the $50-style tender and the change handed back, and is not dead-lettered."""
		data, tendered = self._queued_sale()
		local_id = f"offline-change-{self.run}"
		data["local_id"] = local_id

		result = create_invoice(frappe.as_json(data), local_id=local_id)

		doc = frappe.get_doc(get_invoice_type(), result["name"])
		self.assertEqual(doc.docstatus, 1)
		self.assertPostedWithChange(doc, tendered)
