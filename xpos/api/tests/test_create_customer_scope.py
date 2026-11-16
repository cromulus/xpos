# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The till's New Customer form: any till user, inside the POS Profile (MuleCity-py8t.80).

Bill (2026-11-16): "everyone can add a new customer". A user with a seat on
the POS Profile creates a customer without the Customer create permission
(the insert keeps its permission bypass), but only through a profile they may
use, only in one of the profile's customer groups, and only in the profile's
company. Covers ``xpos.api.customers.create_customer`` (the SPA's) and the
legacy ``xpos.x_pos.api.customers.create_customer`` with its
``xpos.x_pos.api.customer.create_customer`` wrapper.

The database is stubbed, so these run on any site:

    bench --site <site> run-tests --module xpos.api.tests.test_create_customer_scope
"""

import json
import unittest
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import customers
from xpos.x_pos.api import customer as legacy_wrapper
from xpos.x_pos.api import customers as legacy

# name: (lft, rgt, is_group)
TREE = {
	"All Customer Groups": (1, 16, 1),
	"Mule City Customers": (2, 3, 0),
	"Employee": (4, 5, 0),
	"Mule City Internal References": (6, 7, 0),
	"Resale Tiers": (8, 11, 1),
	"Resale-20": (9, 10, 0),
	"Empty Parent": (12, 13, 1),
	"Commercial": (14, 15, 0),
}


def _profile(*groups, company="Mule City", **extra):
	return frappe._dict(
		name="Mule City Retail",
		company=company,
		customer="Walk-In",
		customer_groups=[frappe._dict(customer_group=g) for g in groups],
		**extra,
	)


# Mule's profile lists Mule City Customers first; "Employee" sorts before it.
MULE = _profile("Mule City Customers", "Employee", "Resale Tiers")


def _get_value(doctype, name=None, fieldname=None, *args, **kwargs):
	if doctype == "Customer Group" and name in TREE:
		lft, rgt, is_group = TREE[name]
		if fieldname == "is_group":
			return is_group
		if fieldname in (["lft", "rgt"], ("lft", "rgt")):
			return (lft, rgt)
	return None


def _get_all(doctype, filters=None, pluck=None, order_by=None, limit=None, limit_page_length=None, **kwargs):
	if doctype != "Customer Group":
		return []
	filters = filters or {}
	rows = sorted(TREE.items(), key=lambda kv: kv[1][0])
	out = []
	for name, (lft, rgt, is_group) in rows:
		if "lft" in filters and not lft >= filters["lft"][1]:
			continue
		if "rgt" in filters and not rgt <= filters["rgt"][1]:
			continue
		if "is_group" in filters and is_group != filters["is_group"]:
			continue
		out.append(name)
	limit = limit or limit_page_length
	return out[:limit] if limit else out


class CreateCase(unittest.TestCase):
	"""Stubs the database; ``self.created`` collects each Customer the call builds."""

	profile = MULE
	selling_default = "Commercial"
	may_create = False

	def setUp(self):
		self.created = []

		def get_doc(data, *args, **kwargs):
			if isinstance(data, dict) and data.get("doctype") == "Customer":
				doc = MagicMock()
				doc.data = data
				doc.name = data["customer_name"]
				for key, value in data.items():
					setattr(doc, key, value)
				self.created.append(doc)
				return doc
			raise AssertionError(f"unexpected get_doc {data!r}")

		def single(doctype, field, *args, **kwargs):
			if (doctype, field) == ("Selling Settings", "customer_group"):
				return self.selling_default
			if (doctype, field) == ("Selling Settings", "territory"):
				return "All Territories"
			return None

		self.resolve = MagicMock(side_effect=lambda pos_profile=None, *a, **k: self.profile)
		for target, kwargs in (
			("xpos.api.customers.resolve_pos_profile", {"new": self.resolve}),
			("xpos.x_pos.api.customers.resolve_pos_profile", {"new": self.resolve}),
			("frappe.get_doc", {"side_effect": get_doc}),
			("frappe.get_all", {"side_effect": _get_all}),
			("frappe.db.get_value", {"side_effect": _get_value}),
			("frappe.db.get_single_value", {"side_effect": single}),
			("frappe.db.exists", {"return_value": None}),
			("frappe.has_permission", {"side_effect": lambda *a, **k: self.may_create}),
			("xpos.api.customers._insert_customer_address", {}),
			("xpos.x_pos.api.customers.make_address", {}),
		):
			patcher = patch(target, **kwargs)
			patcher.start()
			self.addCleanup(patcher.stop)

	def group_of(self, call):
		call()
		self.assertEqual(len(self.created), 1)
		return self.created[0].customer_group


class TestCreateCustomerScope(CreateCase):
	"""xpos.api.customers.create_customer, the endpoint the till's New Customer form calls."""

	def test_negative_a_user_without_a_seat_on_the_profile_is_refused(self):
		self.resolve.side_effect = frappe.PermissionError("no seat")
		with self.assertRaises(frappe.PermissionError):
			customers.create_customer("New Farm", pos_profile="Mule City Retail")
		self.assertEqual(self.created, [])

	def test_the_tills_profile_is_the_one_checked(self):
		customers.create_customer("New Farm", pos_profile="Mule City Feed Room")
		self.resolve.assert_called_once()
		self.assertEqual(
			self.resolve.call_args.args[:1] or (self.resolve.call_args.kwargs.get("pos_profile"),),
			("Mule City Feed Room",),
		)

	def test_any_till_user_may_add_a_customer_without_customer_create(self):
		self.may_create = False
		customers.create_customer("New Farm")
		self.created[0].insert.assert_called_once_with(ignore_permissions=True)

	def test_a_requested_group_of_the_profile_is_used(self):
		self.assertEqual(
			self.group_of(lambda: customers.create_customer("New Farm", customer_group="Employee")), "Employee"
		)

	def test_a_requested_leaf_under_a_profile_group_is_used(self):
		self.assertEqual(
			self.group_of(lambda: customers.create_customer("New Farm", customer_group="Resale-20")), "Resale-20"
		)

	def test_negative_a_requested_group_outside_the_profile_is_not_used(self):
		self.selling_default = "Employee"
		group = self.group_of(
			lambda: customers.create_customer("New Farm", customer_group="Mule City Internal References")
		)
		self.assertEqual(group, "Employee")

	def test_negative_a_requested_parent_group_is_not_used(self):
		self.selling_default = "Employee"
		group = self.group_of(lambda: customers.create_customer("New Farm", customer_group="Resale Tiers"))
		self.assertEqual(group, "Employee")

	def test_the_selling_settings_default_when_the_profile_sells_to_it(self):
		self.selling_default = "Employee"
		self.assertEqual(self.group_of(lambda: customers.create_customer("New Farm")), "Employee")

	def test_else_the_profiles_first_group_not_the_alphabetical_first(self):
		# Selling Settings' Commercial is outside Mule's profile.
		self.assertEqual(self.group_of(lambda: customers.create_customer("New Farm")), "Mule City Customers")

	def test_negative_never_all_customer_groups(self):
		self.selling_default = "All Customer Groups"
		self.assertEqual(self.group_of(lambda: customers.create_customer("New Farm")), "Mule City Customers")

	def test_the_first_leaf_under_a_parent_row(self):
		self.profile = _profile("Empty Parent", "Resale Tiers")
		self.assertEqual(self.group_of(lambda: customers.create_customer("New Farm")), "Resale-20")

	def test_negative_no_group_fits_is_refused_with_a_message(self):
		self.profile = _profile("Empty Parent")
		with self.assertRaises(frappe.ValidationError) as caught:
			customers.create_customer("New Farm", customer_group="Commercial")
		self.assertIn("Mule City Retail", str(caught.exception))
		self.assertEqual(self.created, [])

	def test_a_profile_without_group_limits_takes_the_requested_or_default_leaf(self):
		self.profile = _profile()
		self.assertEqual(
			self.group_of(lambda: customers.create_customer("New Farm", customer_group="Employee")), "Employee"
		)
		self.created.clear()
		self.assertEqual(self.group_of(lambda: customers.create_customer("Other Farm")), "Commercial")

	def test_negative_another_company_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			customers.create_customer("New Farm", company="Other Co")
		self.assertEqual(self.created, [])

	def test_the_profiles_own_company_is_accepted(self):
		customers.create_customer("New Farm", company="Mule City")
		self.assertEqual(len(self.created), 1)

	def test_the_sites_tax_exempt_reason_still_saves(self):
		with (
			patch.object(customers, "customer_tax_exempt_reasons", return_value=["Farm"]),
			patch.object(customers, "tax_exempt_reason_field", return_value="mule_tax_exempt_reason"),
		):
			customers.create_customer("New Farm", tax_exempt_reason="Farm")
		self.created[0].set.assert_any_call("mule_tax_exempt_reason", "Farm")
		self.assertEqual(self.created[0].customer_group, "Mule City Customers")

	def test_the_result_names_the_group_the_customer_landed_in(self):
		result = customers.create_customer("New Farm")
		self.assertEqual(result["customer_group"], "Mule City Customers")


class TestLegacyCreateCustomerScope(CreateCase):
	"""xpos.x_pos.api.customers.create_customer and its x_pos.api.customer wrapper."""

	def call(self, endpoint=legacy.create_customer, profile_doc=None, **kwargs):
		profile_doc = profile_doc if profile_doc is not None else {"name": "Mule City Retail"}
		kwargs.setdefault("company", "Mule City")
		return endpoint(customer_name="New Farm", pos_profile_doc=json.dumps(profile_doc), **kwargs)

	def test_negative_a_user_without_a_seat_is_refused_by_either_endpoint(self):
		self.resolve.side_effect = frappe.PermissionError("no seat")
		for endpoint in (legacy.create_customer, legacy_wrapper.create_customer):
			with self.assertRaises(frappe.PermissionError):
				self.call(endpoint)
		self.assertEqual(self.created, [])

	def test_the_profile_is_resolved_by_name_never_taken_from_the_clients_json(self):
		self.call(profile_doc={"name": "Mule City Feed Room", "customer_groups": [{"customer_group": "Commercial"}]})
		self.assertEqual(
			self.resolve.call_args.args[:1] or (self.resolve.call_args.kwargs.get("pos_profile"),),
			("Mule City Feed Room",),
		)
		self.assertEqual(self.created[0].customer_group, "Mule City Customers")

	def test_negative_never_all_customer_groups(self):
		for endpoint in (legacy.create_customer, legacy_wrapper.create_customer):
			self.created.clear()
			self.call(endpoint)
			self.assertEqual(self.created[0].customer_group, "Mule City Customers")

	def test_a_requested_group_of_the_profile_is_used(self):
		self.call(customer_group="Resale-20")
		self.assertEqual(self.created[0].customer_group, "Resale-20")

	def test_negative_a_requested_group_outside_the_profile_is_not_used(self):
		self.call(customer_group="Mule City Internal References")
		self.assertEqual(self.created[0].customer_group, "Mule City Customers")

	def test_negative_no_group_fits_is_refused(self):
		self.profile = _profile("Empty Parent")
		with self.assertRaises(frappe.ValidationError):
			self.call()
		self.assertEqual(self.created, [])

	def test_negative_another_company_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			self.call(company="Other Co")
		self.assertEqual(self.created, [])

	def test_the_referral_company_is_the_profiles(self):
		self.call(company="")
		self.assertEqual(self.created[0].data["referral_company"], "Mule City")

	def test_negative_duplicate_names_follow_the_profile_not_the_client(self):
		with patch("frappe.db.exists", side_effect=lambda doctype, *a, **k: doctype == "Customer"):
			with self.assertRaises(frappe.ValidationError):
				self.call(profile_doc={"name": "Mule City Retail", "allow_duplicate_customer_names": 1})
		self.assertEqual(self.created, [])

	def test_negative_update_needs_write_access_through_the_profile(self):
		with (
			patch.object(legacy, "require_customer_access", side_effect=frappe.PermissionError("no")) as access,
			patch("frappe.get_doc") as get_doc,
		):
			with self.assertRaises(frappe.PermissionError):
				self.call(method="update", customer_id="Greenview")
		access.assert_called_once()
		self.assertEqual(access.call_args.args[:2], ("Greenview", "write"))
		get_doc.assert_not_called()
