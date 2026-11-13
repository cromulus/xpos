# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The till's sale paths sell only to a customer the POS Profile may sell to (MuleCity-py8t.81).

``create_invoice`` (Pay, and the offline queue's replay), ``save_draft_invoice``,
``preview_invoice`` and ``card_terminal.save_card_draft`` set the invoice's
customer straight from the cart and insert with ignore_permissions. Each runs
``check_may_sell`` first; it now also puts the cart's customer through
``require_customer_access`` for the profile: inside its Customer Groups (or one
of its walk-in accounts) and allowed by the caller's User Permissions. A replayed
offline sale is refused like any other: the replay flag is the caller's own
argument, and a refused replay stays in the till's dead-letter list for a
manager. The database is stubbed, so these run on any site:

    bench --site <site> run-tests --module xpos.api.tests.test_invoice_customer_scope
"""

import json
import unittest
from unittest.mock import patch

import frappe

from xpos.api import card_terminal, customers, invoices

PROFILE = frappe._dict(
	name="Mule City Retail",
	company="Mule City",
	customer="Walk-In Customer",
	warehouse="Stores - MC",
	customer_groups=[frappe._dict(customer_group="Mule City Customers")],
)
GROUPS = {
	"Greenview": "Mule City Customers",
	"Walk-In Customer": "Mule City Internal References",
	"Insider": "Mule City Internal References",
}
_REAL_GET_CACHED_DOC = frappe.get_cached_doc
_REAL_EXISTS = frappe.db.exists


class PastTheCheck(Exception):
	"""The sale got past check_may_sell to building the invoice."""


def cart(customer, **extra):
	return {
		"pos_profile": PROFILE.name,
		"customer": customer,
		"warehouse": PROFILE.warehouse,
		"items": [{"item_code": "CORN", "qty": 1, "rate": 10}],
		"payments": [{"mode_of_payment": "Cash", "amount": 10}],
		**extra,
	}


class CustomerScopeCase(unittest.TestCase):
	"""The real require_customer_access over a stubbed profile and Customer table."""

	def setUp(self):
		for target, kwargs in (
			("xpos.api.invoices.resolve_pos_profile", {"return_value": PROFILE}),
			("xpos.api.customers.resolve_pos_profile", {"return_value": PROFILE}),
			("xpos.api.customers.allowed_customer_groups", {"return_value": ["Mule City Customers"]}),
			("xpos.api.customers.walk_in_customers", {"return_value": []}),
			("xpos.api.customers.user_may_see", {"return_value": True}),
			("xpos.api.invoices.find_invoice_by_local_id", {"return_value": None}),
			("xpos.api.invoices.resolve_new_shipping_address", {}),
			("xpos.api.invoices._build_invoice_doc", {"side_effect": PastTheCheck}),
			("xpos.api.card_terminal.resolve_new_shipping_address", {}),
			("frappe.has_permission", {"return_value": True}),
			("xpos.api.invoices.get_invoice_type", {"return_value": "Sales Invoice"}),
			("xpos.api.card_terminal.get_invoice_type", {"return_value": "Sales Invoice"}),
			(
				"frappe.db.exists",
				{
					"side_effect": lambda doctype, name=None, *a, **k: (
						name in GROUPS if doctype == "Customer" else _REAL_EXISTS(doctype, name, *a, **k)
					)
				},
			),
			(
				"frappe.db.get_value",
				{
					"side_effect": lambda doctype, name=None, field=None, *a, **k: (
						GROUPS.get(name) if doctype == "Customer" and field == "customer_group" else None
					)
				},
			),
			("frappe.get_cached_doc", {"side_effect": self._cached_doc}),
		):
			patcher = patch(target, **kwargs)
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)
		self.access = patch(
			"xpos.api.customers.require_customer_access", wraps=customers.require_customer_access
		).start()
		self.addCleanup(patch.stopall)

	@staticmethod
	def _cached_doc(doctype, *args, **kwargs):
		# save_draft_invoice and save_card_draft load the profile right after check_may_sell.
		if doctype == "POS Profile":
			raise PastTheCheck
		return _REAL_GET_CACHED_DOC(doctype, *args, **kwargs)


PATHS = {
	"create_invoice": lambda data: invoices.create_invoice(json.dumps(data)),
	"offline replay": lambda data: invoices.create_invoice(json.dumps(data), local_id="offline-1"),
	"save_draft_invoice": lambda data: invoices.save_draft_invoice(json.dumps(data)),
	"preview_invoice": lambda data: invoices.preview_invoice(json.dumps(data)),
	"save_card_draft": lambda data: card_terminal.save_card_draft(json.dumps(data)),
}


class TestTillSalePathsCheckTheCustomer(CustomerScopeCase):
	def test_negative_a_customer_outside_the_profile_is_refused_on_every_path(self):
		for path, call in PATHS.items():
			with self.subTest(path), self.assertRaises(frappe.PermissionError):
				call(cart("Insider"))
			self._build_invoice_doc.assert_not_called()

	def test_the_check_is_made_against_the_carts_profile(self):
		for path, call in PATHS.items():
			self.access.reset_mock()
			with self.subTest(path), self.assertRaises(PastTheCheck):
				call(cart("Greenview"))
			self.access.assert_called_once_with("Greenview", pos_profile=PROFILE.name)

	def test_the_profiles_walk_in_customer_is_sold_to_outside_its_groups(self):
		"""Mule City's walk-in account sits in its internal references, not the sale groups (MuleCity-yn4b)."""
		for path, call in PATHS.items():
			with self.subTest(path), self.assertRaises(PastTheCheck):
				call(cart("Walk-In Customer"))

	def test_negative_an_unknown_customer_is_refused_before_the_invoice_is_built(self):
		"""These paths never make a customer; an unknown name is refused, not looked up later."""
		for path, call in PATHS.items():
			with self.subTest(path), self.assertRaises(frappe.DoesNotExistError):
				call(cart("Nobody"))
			self._build_invoice_doc.assert_not_called()

	def test_negative_a_customer_the_users_permissions_hide_is_refused(self):
		self.user_may_see.return_value = False
		with self.assertRaises(frappe.PermissionError):
			invoices.create_invoice(json.dumps(cart("Greenview")))
		self._build_invoice_doc.assert_not_called()


class TestCheckMaySellWithoutACustomer(CustomerScopeCase):
	def test_a_profile_only_check_is_unchanged(self):
		"""Site callers (Mule City's counter_checkout and Pay balance) check the seat first, then create_invoice."""
		invoices.check_may_sell(PROFILE.name)
		self.access.assert_not_called()
