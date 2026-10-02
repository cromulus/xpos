"""Counter story (MuleCity-yn4b): the till sells to the walk-in account offline.

On staging (mc31, 2026-10-02) the shared cashier login started the till offline
and the customer search could not find "Walk-In Customer", so the test sale went
to a named customer. The POS Profile limits the till to the "Mule City
Customers" group, while the walk-in account sits under "Mule City Internal
References": get_customers filtered it out, so it never reached the offline
cache. Here a profile restricted to one group, with a preload cap of one, must
still hand the till its default customer and the site's walk-in accounts, and
nothing else from outside the group.
"""

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from xpos.api import customers

CASHIER_ROLES = ("Mule POS Cashier", "Desk User")


class TestWalkInReachesTheOfflineCache(IntegrationTestCase):
	def setUp(self):
		self.run = frappe.generate_hash(length=6)
		self.company = frappe.db.get_value("Company", {}, "name")
		self.sales_group = self._group(f"XPOS Sales {self.run}")
		self.internal_group = self._group(f"XPOS Internal {self.run}")
		# Alphabetically the walk-in comes last, so a cap of one would cut it off.
		self.first = self._customer(f"AAA Buyer {self.run}", self.sales_group)
		self.second = self._customer(f"AAB Buyer {self.run}", self.sales_group)
		self.walk_in = self._customer(f"ZZ Walk-In {self.run}", self.internal_group)
		self.internal = self._customer(f"ZZ Internal {self.run}", self.internal_group)
		self.profile = frappe._dict(
			name=f"Till {self.run}",
			company=self.company,
			customer=self.walk_in,
			customer_groups=[frappe._dict(customer_group=self.sales_group)],
			xpos_customer_preload_limit=1,
			xpos_customer_order="Alphabetical",
		)
		real = frappe.get_cached_doc

		def cached_doc(doctype, *args, **kwargs):
			return self.profile if doctype == "POS Profile" else real(doctype, *args, **kwargs)

		patcher = patch("frappe.get_cached_doc", side_effect=cached_doc)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _group(self, name):
		return frappe.get_doc(
			{"doctype": "Customer Group", "customer_group_name": name, "parent_customer_group": "All Customer Groups"}
		).insert().name

	def _customer(self, name, group, **extra):
		return frappe.get_doc(
			{"doctype": "Customer", "customer_name": name, "customer_group": group, **extra}
		).insert().name

	def _as_cashier(self):
		missing = [role for role in CASHIER_ROLES if not frappe.db.exists("Role", role)]
		if missing:
			self.skipTest(f"no role {missing} on this site")
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"till.{self.run}@walkin.test",
				"first_name": "Till",
				"send_welcome_email": 0,
				"roles": [{"role": role} for role in CASHIER_ROLES],
			}
		).insert()
		self.addCleanup(frappe.set_user, "Administrator")
		frappe.set_user(user.name)

	def _preload(self):
		return customers.get_customers(pos_profile=self.profile.name, preload=1, with_metadata=1)

	def test_the_capped_group_preload_still_carries_the_walk_in(self):
		self._as_cashier()
		result = self._preload()
		names = [row["name"] for row in result["customers"]]
		self.assertIn(self.first, names)
		self.assertNotIn(self.second, names, "the cap still holds for the sale group")
		self.assertIn(self.walk_in, names)
		self.assertNotIn(self.internal, names, "only walk-ins come from outside the group")
		self.assertFalse(result["complete"])
		row = next(r for r in result["customers"] if r["name"] == self.walk_in)
		# The offline tax and pricing context ride on the row.
		for field in ("customer_group", "territory", "tax_category", "customer_name"):
			self.assertIn(field, row)
		self.assertEqual(row["customer_group"], self.internal_group)

	def test_an_uncapped_preload_lists_the_walk_in_once(self):
		self.profile.xpos_customer_preload_limit = 0
		names = [row["name"] for row in self._preload()["customers"]]
		self.assertEqual(names.count(self.walk_in), 1)
		self.assertNotIn(self.internal, names)

	def test_searching_walk_finds_the_walk_in(self):
		self._as_cashier()
		found = customers.get_customers(search_term=f"walk-in {self.run}", pos_profile=self.profile.name)
		self.assertEqual([row["name"] for row in found], [self.walk_in])
		self.assertEqual(
			customers.get_customers(search_term=f"internal {self.run}", pos_profile=self.profile.name), []
		)

	def test_the_sites_walk_in_accounts_come_too(self):
		site_walk_in = self._customer(f"ZZ Cash {self.run}", self.internal_group)
		with patch("xpos.api.customers.walk_in_customers", return_value=[site_walk_in]):
			names = [row["name"] for row in self._preload()["customers"]]
		self.assertIn(site_walk_in, names)
		self.assertIn(self.walk_in, names)

	def test_negative_a_disabled_walk_in_is_not_cached(self):
		frappe.db.set_value("Customer", self.walk_in, "disabled", 1)
		names = [row["name"] for row in self._preload()["customers"]]
		self.assertNotIn(self.walk_in, names)
