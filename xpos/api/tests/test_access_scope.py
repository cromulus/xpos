# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Live checks that POS endpoints act only through the caller's own POS Profile.

Builds on test_record_access's fixtures. Run on a disposable test site::

    bench --site <site> run-tests --module xpos.api.tests.test_access_scope
"""

import frappe

from xpos.api import customers as customers_api
from xpos.api import invoices as invoices_api
from xpos.api import offers, profiles, shifts
from xpos.api.tests.test_record_access import (
	BROAD,
	CASHIER,
	INSIDE,
	OTHER_COMPANY,
	OTHER_PROFILE,
	OUTSIDE,
	OWN_PROFILE,
	RecordAccessTestCase,
)
from xpos.x_pos.api import offers as legacy_offers
from xpos.x_pos.api import payments as legacy_payments
from xpos.x_pos.api import quotations
from xpos.x_pos.api.invoice_processing import creation as legacy_creation
from xpos.x_pos.api.invoice_processing import data as legacy_invoice_data


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


class TestLastInvoiceRatesThroughTheCallersProfile(RecordAccessTestCase):
	"""Last invoice rates reveal what a customer paid: the profile's customers, in its company."""

	ITEMS = ["_Test PS Item A"]

	def lookups(self, customer, **kwargs):
		return (
			lambda: invoices_api.get_last_invoice_rates(customer, self.ITEMS, **kwargs),
			lambda: legacy_invoice_data.get_last_invoice_rates(customer, self.ITEMS, **kwargs),
		)

	def test_a_customer_inside_the_profile_is_looked_up(self):
		rates = invoices_api.get_last_invoice_rates(INSIDE, self.ITEMS, pos_profile=OWN_PROFILE)
		self.assertIsInstance(rates, (list, dict))

	def test_a_customer_outside_the_profile_groups_is_refused(self):
		for i, lookup in enumerate(self.lookups(OUTSIDE, pos_profile=OWN_PROFILE)):
			with self.subTest(i), self.assertRaises(frappe.PermissionError):
				lookup()

	def test_another_company_or_profile_is_refused(self):
		for kwargs in (
			{"company": OTHER_COMPANY, "pos_profile": OWN_PROFILE},
			{"pos_profile": OTHER_PROFILE},
		):
			for i, lookup in enumerate(self.lookups(INSIDE, **kwargs)):
				with self.subTest(i, **kwargs), self.assertRaises(frappe.PermissionError):
					lookup()


class TestShiftOpensOnTheCallersProfile(RecordAccessTestCase):
	"""open_shift and the offline sync's create_opening_shift open only the caller's own shift."""

	COMPANY = "_Test Company"
	CASH = [{"mode_of_payment": "Cash", "opening_amount": 0}]

	def test_own_profile_opens(self):
		shift = shifts.open_shift(OWN_PROFILE, self.COMPANY, self.CASH)["pos_opening_shift"]
		self.assertEqual((shift["pos_profile"], shift["user"]), (OWN_PROFILE, CASHIER))
		synced = shifts.create_opening_shift(
			{"pos_profile": OWN_PROFILE, "company": self.COMPANY, "balance_details": self.CASH}
		)
		self.assertEqual(
			frappe.db.get_value("POS Opening Shift", synced["name"], ["pos_profile", "user"]),
			(OWN_PROFILE, CASHIER),
		)

	def test_someone_elses_profile_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.open_shift(OTHER_PROFILE, self.COMPANY, self.CASH)
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift({"pos_profile": OTHER_PROFILE, "company": self.COMPANY})

	def test_another_company_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.open_shift(OWN_PROFILE, OTHER_COMPANY, self.CASH)
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift({"pos_profile": OWN_PROFILE, "company": OTHER_COMPANY})

	def test_a_synced_shift_cannot_name_another_user(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift(
				{"pos_profile": OWN_PROFILE, "company": self.COMPANY, "user": "Administrator"}
			)


class TestLegacyCreditThroughTheCallersProfile(RecordAccessTestCase):
	"""The legacy x_pos credit lookup is scoped like xpos.api.customer_credit."""

	def test_a_customer_inside_the_profile_is_looked_up(self):
		self.assertIsInstance(legacy_payments.get_available_credit(INSIDE, pos_profile=OWN_PROFILE), list)

	def test_outside_customer_other_company_or_other_profile_is_refused(self):
		for customer, kwargs in (
			(OUTSIDE, {"pos_profile": OWN_PROFILE}),
			(INSIDE, {"company": OTHER_COMPANY, "pos_profile": OWN_PROFILE}),
			(INSIDE, {"pos_profile": OTHER_PROFILE}),
		):
			with self.subTest(customer=customer, **kwargs), self.assertRaises(frappe.PermissionError):
				legacy_payments.get_available_credit(customer, **kwargs)


class TestLegacyInvoiceStaysOnItsTill(RecordAccessTestCase):
	"""update_invoice / submit_invoice may not move a saved invoice or scope a new one elsewhere."""

	def update(self, **changes):
		return legacy_creation.update_invoice(frappe.as_json({"name": self.own_draft.name, **changes}))

	def assertDraftUnchanged(self):
		frappe.set_user("Administrator")
		saved = frappe.db.get_value(
			"Sales Invoice", self.own_draft.name, ["pos_profile", "company", "customer"], as_dict=True
		)
		self.assertEqual(
			(saved.pos_profile, saved.company, saved.customer),
			(OWN_PROFILE, self.own_draft.company, self.own_draft.customer),
		)

	def test_a_saved_invoice_cannot_move_to_another_profile_or_company(self):
		for changes in ({"pos_profile": OTHER_PROFILE}, {"company": OTHER_COMPANY}):
			with self.subTest(**changes), self.assertRaises(frappe.PermissionError):
				self.update(**changes)
		with self.assertRaises(frappe.PermissionError):
			legacy_creation.submit_invoice(
				frappe.as_json({"name": self.own_draft.name, "pos_profile": OTHER_PROFILE}), "{}"
			)
		self.assertDraftUnchanged()

	def test_a_saved_invoice_cannot_take_a_customer_outside_the_profile(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(customer=OUTSIDE)
		self.assertDraftUnchanged()

	def test_server_fields_are_dropped_from_the_payload(self):
		doc = frappe.get_doc("Sales Invoice", self.own_draft.name)
		data = {"owner": "Administrator", "docstatus": 1, "creation": "2020-01-01", "modified_by": "x"}
		legacy_creation._guard_saved_invoice(doc, data)
		self.assertEqual(data, {})

	def test_a_new_invoice_is_scoped_to_the_callers_profile(self):
		for changes in (
			{"pos_profile": OTHER_PROFILE},
			{"pos_profile": OWN_PROFILE, "company": OTHER_COMPANY},
			{"pos_profile": OWN_PROFILE, "customer": OUTSIDE},
		):
			with self.subTest(**changes), self.assertRaises(frappe.PermissionError):
				legacy_creation.update_invoice(frappe.as_json({"items": [], **changes}))


class TestLegacyQuotationsAreQuotations(RecordAccessTestCase):
	"""update_quotation / submit_quotation save only a Quotation, behind Quotation permission."""

	FORGED = {"doctype": "User", "email": "forged-quotation@example.com", "first_name": "Forged"}

	def tearDown(self):
		frappe.set_user("Administrator")
		self.assertFalse(frappe.db.exists("User", self.FORGED["email"]))
		super().tearDown()

	def test_a_forged_doctype_is_not_saved(self):
		for user in (CASHIER, BROAD):
			for save in (quotations.update_quotation, quotations.submit_quotation):
				frappe.set_user(user)
				# Refused, or saved as an (invalid) Quotation: never as the forged doctype.
				with self.subTest(user=user, save=save.__name__), self.assertRaises(Exception):
					save(dict(self.FORGED))

	def test_a_user_without_quotation_permission_is_refused(self):
		self.assertFalse(frappe.has_permission("Quotation", "create"))
		for save in (quotations.update_quotation, quotations.submit_quotation):
			with self.subTest(save.__name__), self.assertRaises(frappe.PermissionError):
				save({"party_name": INSIDE, "company": "_Test Company", "items": []})

	def test_another_users_quotation_cannot_be_overwritten_without_permission(self):
		frappe.set_user("Administrator")
		quotation = frappe.get_doc(
			{
				"doctype": "Quotation",
				"quotation_to": "Customer",
				"party_name": INSIDE,
				"company": "_Test Company",
				"items": [{"item_code": "_Test PS Item A", "qty": 1, "rate": 100}],
			}
		).insert(ignore_permissions=True, ignore_mandatory=True)
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			quotations.update_quotation({"name": quotation.name, "party_name": OUTSIDE})
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.get_value("Quotation", quotation.name, "party_name"), INSIDE)


class ClosingCase(RecordAccessTestCase):
	"""A shift opened by Administrator (a superuser, who may close) on the cashier's profile."""

	COMPANY = "_Test Company"

	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")
		self.opening = frappe.get_doc(
			"POS Opening Shift",
			shifts.open_shift(OWN_PROFILE, self.COMPANY, [{"mode_of_payment": "Cash", "opening_amount": 25}])[
				"pos_opening_shift"
			]["name"],
		)


class TestSyncedClosingIsBuiltOnTheServer(ClosingCase):
	"""create_closing_shift takes only the till's counts from the payload."""

	def test_the_payload_cannot_set_profile_company_user_or_totals(self):
		result = shifts.create_closing_shift(
			{
				"pos_opening_shift": self.opening.name,
				"pos_profile": OTHER_PROFILE,
				"company": OTHER_COMPANY,
				"user": CASHIER,
				"grand_total": 999999,
				"net_total": 999999,
				"total_quantity": 42,
				"payment_reconciliation": [
					{"mode_of_payment": "Cash", "closing_amount": 20, "expected_amount": 20, "difference": 0}
				],
			}
		)
		closing = frappe.get_doc("POS Closing Shift", result["name"])
		self.assertEqual(
			(closing.pos_profile, closing.company, closing.user),
			(OWN_PROFILE, self.COMPANY, "Administrator"),
		)
		self.assertEqual((closing.grand_total, closing.total_quantity), (0, 0))
		cash = {row.mode_of_payment: row for row in closing.payment_reconciliation}["Cash"]
		self.assertEqual((cash.opening_amount, cash.expected_amount, cash.closing_amount), (25, 25, 20))
		self.assertEqual(cash.difference, -5)

	def test_an_uncounted_mode_is_a_shortage_not_a_missing_row(self):
		result = shifts.create_closing_shift({"pos_opening_shift": self.opening.name})
		closing = frappe.get_doc("POS Closing Shift", result["name"])
		cash = {row.mode_of_payment: row for row in closing.payment_reconciliation}["Cash"]
		self.assertEqual((cash.expected_amount, cash.closing_amount, cash.difference), (25, 0, -25))

	def test_a_mode_counted_twice_is_refused(self):
		counts = [{"mode_of_payment": "Cash", "closing_amount": 25}] * 2
		with self.assertRaises(frappe.ValidationError):
			shifts.create_closing_shift(
				{"pos_opening_shift": self.opening.name, "payment_reconciliation": counts}
			)
