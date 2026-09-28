"""Counter stories: record a new customer's Mule City customer type.

Runs against a real site (the Customer's ``mule_customer_kind`` field comes
from mulecity_erpnext). Every story rolls back. Run only on a disposable site::

    bench --site <site> run-tests --module xpos.api.tests.test_create_customer_kind
"""

import unittest
from unittest.mock import patch

import frappe
from frappe.model.meta import Meta

from xpos.api import customers

SAVEPOINT = "xpos_create_customer_kind"
FIELD = "mule_customer_kind"


def site_has_kind() -> bool:
	return frappe.get_meta("Customer").has_field(FIELD)


class TestCreateCustomerKind(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint(SAVEPOINT)
		self.addCleanup(frappe.db.rollback, save_point=SAVEPOINT)
		self.name = f"XPOS Kind {frappe.generate_hash(length=6)}"

	def create(self, **kwargs):
		# Leaf group and territory: a bare test site has no Selling Settings defaults.
		kwargs.setdefault("customer_group", frappe.db.get_value("Customer Group", {"is_group": 0}, "name"))
		kwargs.setdefault("territory", frappe.db.get_value("Territory", {"is_group": 0}, "name"))
		return customers.create_customer(customer_name=self.name, **kwargs)["name"]

	def test_the_cashier_records_a_reseller(self):
		"""On a Mule City site, the chosen type is saved on the new customer."""
		if not site_has_kind():
			self.skipTest("site lacks the field")
		customer = self.create(mule_customer_kind="Reseller")
		self.assertEqual(frappe.db.get_value("Customer", customer, FIELD), "Reseller")

	def test_negative_an_unknown_type_is_refused_and_nothing_is_created(self):
		if not site_has_kind():
			self.skipTest("site lacks the field")
		with self.assertRaisesRegex(frappe.ValidationError, "Customer type must be one of"):
			self.create(mule_customer_kind="Wholesaler")
		self.assertFalse(frappe.db.exists("Customer", {"customer_name": self.name}))

	def test_no_type_leaves_it_blank(self):
		customer = self.create()
		if site_has_kind():
			self.assertFalse(frappe.db.get_value("Customer", customer, FIELD))

	def test_a_site_without_the_field_ignores_the_type(self):
		"""Without mulecity_erpnext the counter still creates the customer."""
		real_get_field = Meta.get_field

		def get_field(meta, fieldname):
			if meta.name == "Customer" and fieldname == FIELD:
				return None
			return real_get_field(meta, fieldname)

		with patch.object(Meta, "get_field", get_field):
			customer = self.create(mule_customer_kind="Wholesaler")
		self.assertTrue(frappe.db.exists("Customer", customer))
		if site_has_kind():
			self.assertFalse(frappe.db.get_value("Customer", customer, FIELD))

	def test_an_exemption_flag_is_not_accepted(self):
		"""A tax exemption is asked for with a Customer Tax Change Request, not
		a flag on create: create_customer no longer takes one."""
		with self.assertRaises(TypeError):
			self.create(request_tax_exemption=1)
