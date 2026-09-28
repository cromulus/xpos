"""User stories: a cashier tells same-named customers apart by the code the shop uses.

Shops configure which Customer fields identify a customer through the standard
Customer ``search_fields`` (Customize Form). The register's customer picker
searches those fields and shows their values under each name, as desk's
customer dropdown does.
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api import customers
from xpos.api.customers import get_customers

# A standard Customer Data field stands in for a shop's own customer-code field.
CODE_FIELD = "website"


def _customer(name, code):
	return frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": name,
			"customer_type": "Individual",
			CODE_FIELD: code,
		}
	).insert(ignore_permissions=True)


class TestCustomerPickerSearchFields(unittest.TestCase):
	def setUp(self):
		self.suffix = frappe.generate_hash(length=6)
		self.name = f"XPOS Donald Byrd {self.suffix}"
		self.six = _customer(self.name, f"6{self.suffix}")
		self.other = _customer(self.name, f"16{self.suffix}")
		patcher = patch.object(customers, "_customer_search_fields", return_value=[CODE_FIELD])
		patcher.start()
		self.addCleanup(patcher.stop)

	def tearDown(self):
		frappe.db.rollback()

	def test_two_same_named_customers_show_their_codes(self):
		"""Searching the shared name lists both, each with its own code visible."""
		rows = {row["name"]: row for row in get_customers(search_term=self.name)}
		self.assertEqual(rows[self.six.name]["xpos_search_description"], f"6{self.suffix}")
		self.assertEqual(rows[self.other.name]["xpos_search_description"], f"16{self.suffix}")

	def test_typing_a_code_finds_that_customer_first(self):
		"""The exact code ranks above a longer code that merely contains it."""
		rows = get_customers(search_term=f"6{self.suffix}")
		names = [row["name"] for row in rows]
		self.assertIn(self.other.name, names)  # "16…" contains "6…"
		self.assertEqual(names[0], self.six.name)

	def test_unknown_code_finds_nobody(self):
		"""Negative: a code no customer has returns no one."""
		self.assertEqual(get_customers(search_term=f"no-such-{self.suffix}"), [])


class TestCustomerSearchFieldConfig(unittest.TestCase):
	def test_only_real_text_fields_reach_the_query(self):
		"""Negative: a stale name or a table field in the setting is skipped, not fatal."""
		meta = frappe.get_meta("Customer")
		with patch.object(customers.frappe, "get_meta") as get_meta:
			get_meta.return_value = frappe._dict(
				search_fields=f"no_such_field, sales_team, {CODE_FIELD}, {CODE_FIELD}",
				get_field=meta.get_field,
			)
			self.assertEqual(customers._customer_search_fields(), [CODE_FIELD])

	def test_no_search_fields_configured(self):
		"""Negative: a site with no search fields keeps the built-in search."""
		with patch.object(customers.frappe, "get_meta") as get_meta:
			get_meta.return_value = frappe._dict(search_fields=None, get_field=lambda f: None)
			self.assertEqual(customers._customer_search_fields(), [])
