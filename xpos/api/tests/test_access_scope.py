# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks that POS endpoints act only through the caller's own POS Profile.

Builds on test_record_access's fixtures. Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_access_scope
"""

import frappe

from xpos.api import customers as customers_api
from xpos.api import profiles
from xpos.api.tests.test_record_access import (
	CASHIER,
	INSIDE,
	OWN_PROFILE,
	RecordAccessTestCase,
)


class TestGuestProfile(RecordAccessTestCase):
	"""Guest never resolves a POS Profile, named or default."""

	def test_guest_is_refused_with_a_permission_error(self):
		frappe.set_user("Guest")
		for name in (OWN_PROFILE, None):
			with self.subTest(pos_profile=name), self.assertRaises(frappe.PermissionError):
				profiles.resolve_pos_profile(name)
		with self.assertRaises(frappe.PermissionError):
			customers_api.get_customer_info(INSIDE)

	def test_a_profile_user_still_resolves_it(self):
		self.assertEqual(frappe.session.user, CASHIER)
		self.assertEqual(profiles.resolve_pos_profile(OWN_PROFILE).name, OWN_PROFILE)


class TestSuperuserDefaultProfile(RecordAccessTestCase):
	"""A superuser with no POS Profile row still gets an enabled profile."""

	def test_default_profile_without_a_profile_row(self):
		frappe.set_user("Administrator")
		frappe.db.delete("POS Profile User", {"user": "Administrator"})
		profile = profiles.get_default_pos_profile("Administrator")
		self.assertTrue(profile)
		self.assertEqual(frappe.db.get_value("POS Profile", profile, "disabled"), 0)
