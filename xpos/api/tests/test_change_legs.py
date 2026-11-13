# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""A cash sale paid with change posts when Cash has no tender currency.

The till sends the tender and one change row::

    payments:        [{mode_of_payment: Cash, amount: 150}]
    change_amount:   50
    pos_change_legs: [{mode_of_payment: Cash, currency: <company currency>, amount: 50, ...}]

``POS Change Leg.currency`` is fetched from ``Mode of Payment.pos_tender_currency``.
Without ``fetch_if_empty`` Frappe's link validation re-fetches it on save and
blanks the currency ``build_change_legs`` set whenever the Mode of Payment has
no tender currency (it pays in the company currency, the common case), so the
sale is refused with "POS Change Leg Row #1: Value missing for: Currency".
Online Pay and an offline replay both go through ``create_invoice``.
"""

import frappe
from frappe.utils import flt

from xpos.api.invoices import create_invoice
from xpos.api.tests.test_profile_settings_hardening import (
	COMPANY,
	HardeningTestCase,
	line,
)
from xpos.api.utilities import get_invoice_type

CHANGE = 50
TENDERED = 150


class TestACashSaleWithChangePosts(HardeningTestCase):
	def setUp(self):
		if not frappe.db.exists("Company", COMPANY):
			self.skipTest(f"needs ERPNext's test records ({COMPANY})")
		super().setUp()
		frappe.db.set_single_value("POS Settings", "post_change_gl_entries", 1)
		self.pos.db_set("account_for_change_amount", "Cash - _TC")
		frappe.clear_cache(doctype="POS Profile")
		if frappe.get_meta("Mode of Payment").has_field("pos_tender_currency"):
			frappe.db.set_value("Mode of Payment", "Cash", "pos_tender_currency", None)
		self.currency = frappe.get_cached_value("Company", COMPANY, "default_currency")

	def _sale_with_change(self, local_id):
		return {
			"pos_profile": self.pos.name,
			"customer": "_Test Customer",
			"items": [line(rate=100)],
			"payments": [{"mode_of_payment": "Cash", "amount": TENDERED}],
			"change_amount": CHANGE,
			"pos_change_legs": [
				{
					"mode_of_payment": "Cash",
					"currency": self.currency,
					"amount": CHANGE,
					"exchange_rate": 1,
					"base_amount": CHANGE,
				}
			],
			"local_id": local_id,
		}

	def test_a_sale_with_change_posts_and_keeps_the_change_currency(self):
		local_id = "inv_" + frappe.generate_hash(length=32)
		result = create_invoice(frappe.as_json(self._sale_with_change(local_id)), local_id=local_id)

		doc = frappe.get_doc(get_invoice_type(), result["name"])
		self.assertEqual(doc.docstatus, 1)
		self.assertEqual(flt(doc.paid_amount, 2), TENDERED)
		self.assertEqual(flt(doc.change_amount, 2), CHANGE)
		self.assertEqual(len(doc.pos_change_legs), 1)
		leg = doc.pos_change_legs[0]
		self.assertEqual(leg.mode_of_payment, "Cash")
		# The currency the server set survives the save (it used to be blanked).
		self.assertEqual(leg.currency, self.currency)
		self.assertEqual(flt(leg.base_amount, 2), CHANGE)

	def test_the_change_currency_field_fetches_only_when_empty(self):
		field = frappe.get_meta("POS Change Leg").get_field("currency")
		self.assertEqual(field.fetch_from, "mode_of_payment.pos_tender_currency")
		self.assertTrue(field.fetch_if_empty)
