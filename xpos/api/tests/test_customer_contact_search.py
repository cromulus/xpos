"""Cashier stories (Mule City, MuleCity-1ptj): find a farm by the person on the account.

A Contact linked to a Customer (Dynamic Link) finds that customer at the till by
the contact's name, email or phone. Phones compare digits only, so a number is
found however it was typed, and by its last four digits. The farm's own exact
name or code still comes first, then farms matching on their own fields, then
farms found only through a contact.
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api.customers import get_customers


class TestCustomerContactSearch(unittest.TestCase):
	def setUp(self):
		self.s = frappe.generate_hash(length=6)
		# The last four digits are unique to this run, so "last four" finds only this farm.
		self.digits = str(int(self.s, 16) % 10000).zfill(4)
		self.farm = self._customer(f"Sharp Farms {self.s}")
		self.namesake = self._customer(f"Quillon{self.s} Hill Farm")
		self.contact = frappe.get_doc(
			{
				"doctype": "Contact",
				"first_name": f"Quillon{self.s}",
				"last_name": "Sharp",
				"email_ids": [{"email_id": f"quillon{self.s}@sharp.test", "is_primary": 1}],
				"phone_nos": [{"phone": f"(919) 55{self.digits[:1]}-{self.digits}", "is_primary_mobile_no": 1}],
				"links": [{"link_doctype": "Customer", "link_name": self.farm.name}],
			}
		).insert(ignore_permissions=True)
		self.phone = self.contact.phone_nos[0].phone
		# A till with no customer-group limit: these cases are about search, not scope.
		resolve = patch("xpos.api.customers.resolve_pos_profile", return_value=frappe._dict(name="Till", customer_groups=[]))
		resolve.start()
		self.addCleanup(resolve.stop)

	def tearDown(self):
		frappe.db.rollback()

	def _customer(self, name, **fields):
		return frappe.get_doc(
			{"doctype": "Customer", "customer_name": name, "customer_type": "Company", **fields}
		).insert(ignore_permissions=True)

	def _names(self, term):
		return [row["name"] for row in get_customers(search_term=term)]

	def test_contact_name_finds_the_farm(self):
		self.assertIn(self.farm.name, self._names(f"Quillon{self.s} Sharp"))

	def test_contact_email_finds_the_farm(self):
		self.assertEqual(self._names(f"quillon{self.s}@sharp"), [self.farm.name])

	def test_contact_phone_finds_the_farm_however_typed(self):
		digits = "".join(ch for ch in self.phone if ch.isdigit())
		for typed in (self.phone, digits, f"{digits[:3]}-{digits[3:6]}-{digits[6:]}", self.digits):
			with self.subTest(typed=typed):
				self.assertIn(self.farm.name, self._names(typed))

	def test_customer_own_mobile_is_found_by_digits(self):
		own = self._customer(f"Byrd Acres {self.s}")
		frappe.db.set_value("Customer", own.name, "mobile_no", f"336-55{self.digits[:1]}-{self.digits}")
		self.assertIn(own.name, self._names(f"(336) 55{self.digits[:1]} {self.digits}"))

	def test_farm_named_like_the_contact_ranks_before_the_contact_match(self):
		names = self._names(f"Quillon{self.s}")
		self.assertLess(names.index(self.namesake.name), names.index(self.farm.name))

	def test_contact_rows_carry_the_contact_for_offline_search(self):
		row = next(r for r in get_customers(search_term=f"Quillon{self.s} Sharp") if r["name"] == self.farm.name)
		self.assertEqual(row["xpos_contacts"][0]["full_name"], f"Quillon{self.s} Sharp")
		self.assertIn(self.phone, row["xpos_contacts"][0]["phones"])

	def test_negative_three_digits_and_strangers_find_nobody(self):
		# Three digits spanning the dash: in the number's digits, but not in its text.
		three = self.digits[0] + self.digits[:2]
		if not any(three in v for v in (self.phone, self.farm.name, self.contact.email_ids[0].email_id)):
			self.assertNotIn(self.farm.name, self._names(three))
		self.assertEqual(self._names(f"nobody-{self.s}"), [])
