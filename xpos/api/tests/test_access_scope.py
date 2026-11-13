# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks that POS endpoints act only through the caller's own POS Profile.

Builds on test_record_access's fixtures. Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_access_scope
"""

import frappe

from xpos.api import customers as customers_api
from xpos.api import offers, profiles
from xpos.api.tests.test_record_access import (
	CASHIER,
	INSIDE,
	OTHER_COMPANY,
	OTHER_PROFILE,
	OUTSIDE,
	OWN_PROFILE,
	RecordAccessTestCase,
)
from xpos.x_pos.api import offers as legacy_offers


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


class TestOffersThroughTheCallersProfile(RecordAccessTestCase):
	"""get_offers lists a profile's offers only for a user of that profile."""

	def test_own_profile_offers_are_listed(self):
		self.assertIsInstance(offers.get_offers(OWN_PROFILE), list)
		self.assertIsInstance(legacy_offers.get_offers(OWN_PROFILE), list)

	def test_someone_elses_profile_is_refused(self):
		for get in (offers.get_offers, legacy_offers.get_offers):
			with self.subTest(get.__module__), self.assertRaises(frappe.PermissionError):
				get(OTHER_PROFILE)

	def test_guest_is_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			offers.get_offers(OWN_PROFILE)


class TestCouponsThroughTheCallersProfile(RecordAccessTestCase):
	"""Coupon and gift card lookups take the customer and company from the caller's profile."""

	def lookups(self, customer, **kwargs):
		return (
			lambda: offers.get_pos_coupon("_TEST-NO-SUCH-COUPON", customer, **kwargs),
			lambda: legacy_offers.get_pos_coupon("_TEST-NO-SUCH-COUPON", customer, **kwargs),
			lambda: offers.get_active_gift_coupons(customer, **kwargs),
			lambda: legacy_offers.get_active_gift_coupons(customer, **kwargs),
		)

	def test_a_customer_inside_the_profile_is_looked_up(self):
		for lookup in self.lookups(INSIDE, pos_profile=OWN_PROFILE):
			lookup()

	def test_a_customer_outside_the_profile_groups_is_refused(self):
		for i, lookup in enumerate(self.lookups(OUTSIDE, pos_profile=OWN_PROFILE)):
			with self.subTest(i), self.assertRaises(frappe.PermissionError):
				lookup()

	def test_another_company_is_refused(self):
		for i, lookup in enumerate(self.lookups(INSIDE, company=OTHER_COMPANY, pos_profile=OWN_PROFILE)):
			with self.subTest(i), self.assertRaises(frappe.PermissionError):
				lookup()

	def test_someone_elses_profile_is_refused_even_without_a_customer(self):
		for get in (offers.get_pos_coupon, legacy_offers.get_pos_coupon):
			with self.subTest(get.__module__), self.assertRaises(frappe.PermissionError):
				get("_TEST-NO-SUCH-COUPON", "", pos_profile=OTHER_PROFILE)
