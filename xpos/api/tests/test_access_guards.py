# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Who is refused a customer, an invoice or a POS Profile (MuleCity-0bsc).

test_record_access is upstream's live version of these checks; it needs
ERPNext's "_Test" records, which a Mule City site does not have. These cases
stub the database so they run on any site:

    bench --site <site> run-tests --module xpos.api.tests.test_access_guards
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api import customers, invoices, profiles

PROFILE = frappe._dict(
	name="Mule City Retail",
	company="Mule City",
	customer="Walk-In",
	customer_groups=[frappe._dict(customer_group="Farm")],
)
GROUPS = {"Walk-In": "Internal", "Greenview": "Farm", "Insider": "Internal"}


class CustomerCase(unittest.TestCase):
	def setUp(self):
		for name, kwargs in (
			("resolve_pos_profile", {"return_value": PROFILE}),
			("_get_child_groups", {"side_effect": lambda _type, root: [root]}),
			("walk_in_customers", {"return_value": []}),
			("user_may_see", {"return_value": True}),
		):
			patcher = patch.object(customers, name, **kwargs)
			setattr(self, name, patcher.start())
			self.addCleanup(patcher.stop)
		for target, kwargs in (
			("frappe.db.exists", {"side_effect": lambda doctype, name=None, *a, **k: name in GROUPS}),
			("frappe.db.get_value", {"side_effect": lambda doctype, name, field, *a, **k: GROUPS.get(name)}),
			("frappe.has_permission", {"return_value": True}),
		):
			patcher = patch(target, **kwargs)
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)


class TestCustomerAccess(CustomerCase):
	def test_a_customer_in_the_profile_groups_is_allowed(self):
		self.assertEqual(customers.require_customer_access("Greenview"), PROFILE)

	def test_negative_a_customer_outside_the_profile_groups_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			customers.require_customer_access("Insider")

	def test_negative_desk_permission_does_not_lift_the_groups(self):
		self.has_permission.return_value = True
		with self.assertRaises(frappe.PermissionError):
			customers.require_customer_access("Insider", "write")

	def test_the_profiles_walk_in_is_allowed_though_outside_the_groups(self):
		self.assertEqual(customers.require_customer_access("Walk-In"), PROFILE)

	def test_negative_user_permissions_still_apply_inside_the_groups(self):
		self.user_may_see.return_value = False
		with self.assertRaises(frappe.PermissionError):
			customers.require_customer_access("Greenview")

	def test_negative_reading_a_customer_does_not_allow_changing_it(self):
		self.has_permission.return_value = False
		customers.require_customer_access("Greenview")
		with self.assertRaises(frappe.PermissionError):
			customers.require_customer_access("Greenview", "write")

	def test_negative_an_unknown_customer_is_not_found(self):
		with self.assertRaises(frappe.DoesNotExistError):
			customers.require_customer_access("Nobody")

	def test_negative_credit_and_card_of_an_outside_customer_are_refused(self):
		for call in (
			lambda: customers.get_customer_credit("Insider", "Mule City", pos_profile=PROFILE.name),
			lambda: customers.get_customer_info("Insider", pos_profile=PROFILE.name),
			lambda: customers.get_customer_addresses("Insider", pos_profile=PROFILE.name),
		):
			with self.assertRaises(frappe.PermissionError):
				call()

	def test_an_address_needs_read_access_not_customer_write(self):
		"""Mule City's counter login reads customers only and adds addresses in Edit Customer."""
		self.has_permission.return_value = False
		address = {"address_line1": "77 Feed Lot Ln", "city": "Benson"}
		with patch.object(customers, "_insert_customer_address", return_value={"name": "ADDR-1"}) as insert:
			self.assertEqual(customers.make_address({"customer": "Greenview", **address}), {"name": "ADDR-1"})
			with self.assertRaises(frappe.PermissionError):
				customers.make_address({"customer": "Insider", **address})
		self.assertEqual([call.args[0] for call in insert.call_args_list], ["Greenview"])

	def test_negative_a_delivery_address_for_an_outside_customer_is_refused(self):
		added = []
		with patch.object(customers, "_last_hook", return_value=lambda **kw: added.append(kw)):
			with self.assertRaises(frappe.PermissionError):
				customers.add_delivery_address("Insider", "1 Main St", "Benson", "NC", "27504")
		self.assertEqual(added, [])


class TestProfileAccess(unittest.TestCase):
	def test_negative_a_profile_sent_as_data_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			profiles.resolve_pos_profile({"name": "Mule City Retail", "customer_groups": []})

	@patch.object(profiles, "user_may_use_profile", return_value=False)
	@patch("frappe.db.exists", return_value=True)
	def test_negative_someone_elses_profile_is_refused(self, _exists, _may_use):
		with self.assertRaises(frappe.PermissionError):
			profiles.resolve_pos_profile("Other Till")

	@patch.object(profiles, "user_may_use_profile", return_value=False)
	@patch("frappe.db.exists", return_value=True)
	def test_negative_customer_search_through_someone_elses_profile_is_refused(self, _exists, _may_use):
		with self.assertRaises(frappe.PermissionError):
			customers.get_customers("Green", pos_profile="Other Till")


class TestInvoiceAccess(unittest.TestCase):
	SCOPE = frappe._dict(pos_profile="Mule City Retail", company="Mule City")

	def load(self, *, desk=False, profile_user=True, profile_company="Mule City", user_permission=True):
		doc = frappe._dict(name="ACC-SINV-1", has_permission=lambda ptype: desk)
		with (
			patch("frappe.db.get_value", side_effect=lambda doctype, name, field, **k: (
				self.SCOPE if doctype == "Sales Invoice" else profile_company
			)),
			patch("frappe.get_doc", return_value=doc),
			patch.object(invoices, "user_may_use_profile", return_value=profile_user),
			patch.object(invoices, "has_user_permission", return_value=user_permission),
		):
			return invoices.get_pos_invoice("Sales Invoice", "ACC-SINV-1")

	def test_an_invoice_of_the_users_own_till_is_allowed(self):
		self.assertEqual(self.load().name, "ACC-SINV-1")

	def test_desk_permission_reaches_any_invoice(self):
		self.assertEqual(self.load(desk=True, profile_user=False).name, "ACC-SINV-1")

	def test_negative_another_tills_invoice_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			self.load(profile_user=False)

	def test_negative_an_invoice_of_another_company_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			self.load(profile_company="Other Co")

	def test_negative_user_permissions_beat_the_till(self):
		with self.assertRaises(frappe.PermissionError):
			self.load(user_permission=False)

	def test_negative_other_doctypes_are_refused_before_loading(self):
		for doctype in ("Customer", "User", "Salary Slip"):
			with self.subTest(doctype), self.assertRaises(frappe.PermissionError):
				invoices.get_pos_invoice(doctype, "Administrator")

	@patch("frappe.db.get_value", return_value=None)
	def test_negative_a_missing_invoice_is_refused_like_a_forbidden_one(self, _get_value):
		with self.assertRaises(frappe.PermissionError):
			invoices.get_pos_invoice("Sales Invoice", "ACC-SINV-NONE")


class TestCustomerAccessMc63(CustomerCase):
	"""The four gaps mc62 left open on customer endpoints (mc63, MuleCity-0bsc)."""

	def test_negative_a_delivery_address_is_checked_through_the_tills_profile(self):
		with (
			patch.object(customers, "_last_hook", return_value=lambda **kw: kw),
			patch.object(customers, "require_customer_access", return_value=PROFILE) as access,
		):
			customers.add_delivery_address(
				"Greenview", "1 Main St", "Benson", "NC", "27504", pos_profile="Mule City Feed Room"
			)
		access.assert_called_once_with("Greenview", "read", "Mule City Feed Room")

	def test_negative_a_reader_cannot_make_a_delivery_address_the_primary_shipping_one(self):
		self.has_permission.return_value = False
		with patch.object(customers, "_last_hook", return_value=lambda **kw: kw):
			added = customers.add_delivery_address(
				"Greenview", "1 Main St", "Benson", "NC", "27504", make_primary_shipping=1
			)
		self.assertEqual(added["make_primary_shipping"], 0)

	def test_a_customer_writer_may_make_a_delivery_address_the_primary_shipping_one(self):
		with patch.object(customers, "_last_hook", return_value=lambda **kw: kw):
			added = customers.add_delivery_address(
				"Greenview", "1 Main St", "Benson", "NC", "27504", make_primary_shipping=1
			)
		self.assertEqual(added["make_primary_shipping"], 1)

	def test_negative_credit_of_another_company_is_refused(self):
		with patch("frappe.db.sql", return_value=[]) as sql:
			with self.assertRaises(frappe.PermissionError):
				customers.get_customer_credit("Greenview", "Other Co", pos_profile=PROFILE.name)
		sql.assert_not_called()

	def test_credit_is_read_in_the_profiles_company_when_none_is_sent(self):
		with patch("frappe.db.sql", return_value=[]) as sql:
			self.assertEqual(customers.get_customer_credit("Greenview", "", pos_profile=PROFILE.name), [])
		self.assertTrue(sql.call_args_list)
		self.assertEqual({call.args[1]["company"] for call in sql.call_args_list}, {"Mule City"})

	def test_negative_the_other_credit_endpoints_refuse_an_outside_customer_or_company(self):
		from xpos.api import payments
		from xpos.x_pos.api import payments as legacy_payments

		with patch("frappe.db.sql", return_value=[]) as sql, patch("frappe.get_all", return_value=[]) as get_all:
			for call in (
				lambda: payments.get_available_credit("Insider", "Mule City"),
				lambda: payments.get_available_credit("Greenview", "Other Co"),
				lambda: legacy_payments.get_available_credit("Insider", "Mule City"),
				lambda: legacy_payments.get_available_credit("Greenview", "Other Co"),
			):
				with self.assertRaises(frappe.PermissionError):
					call()
		sql.assert_not_called()
		get_all.assert_not_called()

	def test_negative_a_reader_adds_an_address_but_not_as_primary_or_shipping(self):
		self.has_permission.return_value = False
		address = {"address_line1": "77 Feed Lot Ln", "city": "Benson", "is_primary_address": 1, "is_shipping_address": 1}
		with patch.object(customers, "_insert_customer_address", return_value={"name": "ADDR-1"}) as insert:
			customers.make_address({"customer": "Greenview", **address})
		args = insert.call_args.args[1]
		self.assertEqual((args["is_primary_address"], args["is_shipping_address"]), (0, 0))

	def test_a_customer_writer_may_add_a_primary_shipping_address(self):
		address = {"address_line1": "77 Feed Lot Ln", "city": "Benson", "is_primary_address": 1, "is_shipping_address": 1}
		with patch.object(customers, "_insert_customer_address", return_value={"name": "ADDR-1"}) as insert:
			customers.make_address({"customer": "Greenview", **address})
		args = insert.call_args.args[1]
		self.assertEqual((args["is_primary_address"], args["is_shipping_address"]), (1, 1))

	def test_negative_a_walk_in_gets_no_address(self):
		self.walk_in_customers.return_value = ["Walk-In"]
		with patch.object(customers, "_insert_customer_address") as insert:
			with self.assertRaises(frappe.ValidationError):
				customers.make_address({"customer": "Walk-In", "address_line1": "1 Main St", "city": "Benson"})
		insert.assert_not_called()


class TestCustomerAccessJn61(CustomerCase):
	"""Coupons and last invoice rates take a customer and company from the till (MuleCity-jn61).

	Each is checked through the caller's POS Profile (customer_in_profile), and
	read in that profile's company; another company is refused.
	"""

	COUPON = frappe._dict(
		name="GIFT-1",
		coupon_code="GIFT100",
		coupon_type="Gift Card",
		valid_from=None,
		valid_upto=None,
		customer="Greenview",
		pos_offer=None,
		maximum_use=0,
		used=0,
	)

	def setUp(self):
		super().setUp()
		# nowdate reads System Settings through frappe.db.get_value, stubbed here.
		for target in ("xpos.api.offers.nowdate", "xpos.x_pos.api.offers.nowdate"):
			patcher = patch(target, return_value="2026-11-13")
			patcher.start()
			self.addCleanup(patcher.stop)

	def coupon_lookups(self):
		"""Answer POS Coupon lookups with COUPON; record the filters they used."""
		seen = []
		customer_lookup = self.get_value.side_effect

		def get_value(doctype, name=None, *args, **kwargs):
			if doctype == "POS Coupon":
				seen.append(name)
				return self.COUPON
			return customer_lookup(doctype, name, *args, **kwargs)

		self.get_value.side_effect = get_value
		return seen

	def refused(self, call):
		with self.assertRaises(frappe.PermissionError):
			call()

	def test_negative_a_coupon_is_not_checked_for_a_customer_outside_the_profile(self):
		from xpos.api import offers
		from xpos.x_pos.api import offers as legacy_offers

		seen = self.coupon_lookups()
		with patch.object(legacy_offers, "check_coupon_code", return_value={"coupon": None}) as legacy_check:
			for call in (
				lambda: offers.get_pos_coupon("GIFT100", "Insider", "Mule City"),
				lambda: offers.get_pos_coupon("GIFT100", "Greenview", "Other Co"),
				lambda: offers.get_pos_coupon("GIFT100", "", "Other Co"),
				lambda: legacy_offers.get_pos_coupon("GIFT100", "Insider", "Mule City"),
				lambda: legacy_offers.get_pos_coupon("GIFT100", "Greenview", "Other Co"),
				lambda: legacy_offers.get_pos_coupon("GIFT100", "", "Other Co"),
			):
				self.refused(call)
		self.assertEqual(seen, [])
		legacy_check.assert_not_called()

	def test_a_coupon_is_checked_in_the_profiles_company(self):
		from xpos.api import offers
		from xpos.x_pos.api import offers as legacy_offers

		seen = self.coupon_lookups()
		result = offers.get_pos_coupon("GIFT100", "Greenview", "", pos_profile=PROFILE.name)
		self.assertEqual(result["msg"], "Apply")
		self.assertEqual(seen[-1]["company"], "Mule City")
		# No customer picked yet: still the profile's company (a coupon for anyone).
		self.COUPON = frappe._dict(self.COUPON, coupon_code="SUMMER10", coupon_type="Promotional", customer=None)
		offers.get_pos_coupon("SUMMER10", "", "Mule City")
		self.assertEqual(seen[-1]["company"], "Mule City")
		with patch.object(legacy_offers, "check_coupon_code", return_value={"coupon": None}) as legacy_check:
			legacy_offers.get_pos_coupon("GIFT100", "Greenview", "")
		legacy_check.assert_called_once_with("GIFT100", "Greenview", "Mule City")
		self.resolve_pos_profile.assert_any_call(PROFILE.name)

	def test_negative_gift_coupons_are_not_listed_for_a_customer_outside_the_profile(self):
		from xpos.api import offers
		from xpos.x_pos.api import offers as legacy_offers

		with patch("frappe.get_all", return_value=[]) as get_all:
			for call in (
				lambda: offers.get_active_gift_coupons("Insider", "Mule City"),
				lambda: offers.get_active_gift_coupons("Greenview", "Other Co"),
				lambda: legacy_offers.get_active_gift_coupons("Insider", "Mule City"),
				lambda: legacy_offers.get_active_gift_coupons("Greenview", "Other Co"),
			):
				self.refused(call)
		get_all.assert_not_called()

	def test_gift_coupons_are_listed_in_the_profiles_company(self):
		from xpos.api import offers
		from xpos.x_pos.api import offers as legacy_offers

		with patch("frappe.get_all", return_value=[]) as get_all:
			self.assertEqual(offers.get_active_gift_coupons("Greenview"), [])
			self.assertEqual(legacy_offers.get_active_gift_coupons("Greenview", pos_profile=PROFILE.name), [])
		self.assertEqual({call.kwargs["filters"]["company"] for call in get_all.call_args_list}, {"Mule City"})

	def test_negative_last_invoice_rates_are_not_read_for_a_customer_outside_the_profile(self):
		from xpos.x_pos.api.invoice_processing import data as legacy_data

		with patch("frappe.db.sql", return_value=[]) as sql, patch("frappe.get_all", return_value=[]) as get_all:
			for call in (
				lambda: invoices.get_last_invoice_rates("Insider", ["FEED-1"], "Mule City"),
				lambda: invoices.get_last_invoice_rates("Greenview", ["FEED-1"], "Other Co"),
				lambda: legacy_data.get_last_invoice_rates("Insider", ["FEED-1"], "Mule City"),
				lambda: legacy_data.get_last_invoice_rates("Greenview", ["FEED-1"], "Other Co"),
			):
				self.refused(call)
		sql.assert_not_called()
		get_all.assert_not_called()

	def test_last_invoice_rates_are_read_in_the_profiles_company(self):
		from xpos.x_pos.api.invoice_processing import data as legacy_data

		with (
			patch("frappe.db.sql", return_value=[]) as sql,
			patch("frappe.get_all", return_value=[]) as get_all,
			patch("frappe.db.get_default", return_value="Some Default Co"),
		):
			invoices.get_last_invoice_rates("Greenview", '["FEED-1"]', "", pos_profile=PROFILE.name)
			legacy_data.get_last_invoice_rates("Greenview", ["FEED-1"])
		self.assertEqual(sql.call_args.args[1]["company"], "Mule City")
		self.assertIn(["Sales Invoice", "company", "=", "Mule City"], get_all.call_args.kwargs["filters"])


class TestOffersOnTheCallersProfile(unittest.TestCase):
	"""get_offers reads offers only through a POS Profile the caller may use (MuleCity-get_offers).

	Both the SPA's offers.get_offers and the legacy x_pos one used to load any
	profile they were sent and list its company's offers.
	"""

	OFFER_PROFILE = frappe._dict(PROFILE, warehouse="Stores - MC")

	def call_both(self, profile, *, may_use):
		from xpos.api import offers
		from xpos.x_pos.api import offers as legacy_offers

		results = []
		with (
			patch.object(profiles, "user_may_use_profile", return_value=may_use),
			patch("frappe.db.exists", return_value=True),
			patch("frappe.get_cached_doc", return_value=self.OFFER_PROFILE) as get_cached_doc,
			patch("frappe.get_doc", return_value=self.OFFER_PROFILE) as get_doc,
			patch("frappe.db.sql", return_value=[]) as sql,
			patch.object(offers, "_get_promotional_scheme_offers", return_value=[]) as promo,
			patch.object(legacy_offers, "_get_promotional_scheme_offers", return_value=[]) as legacy_promo,
		):
			for call in (
				lambda: offers.get_offers(profile),
				lambda: legacy_offers.get_offers(profile),
			):
				if may_use:
					results.append(call())
				else:
					with self.assertRaises(frappe.PermissionError):
						call()
		return frappe._dict(
			results=results,
			sql=sql,
			loads=get_cached_doc.call_count + get_doc.call_count,
			promo=promo.call_count + legacy_promo.call_count,
		)

	def test_negative_someone_elses_profile_lists_no_offers(self):
		seen = self.call_both("Other Till", may_use=False)
		seen.sql.assert_not_called()
		self.assertEqual(seen.loads, 0)
		self.assertEqual(seen.promo, 0)

	def test_the_callers_profile_lists_its_company_offers(self):
		seen = self.call_both(PROFILE.name, may_use=True)
		self.assertEqual(seen.results, [[], []])
		self.assertEqual(seen.sql.call_count, 2)
		for call in seen.sql.call_args_list:
			values = call.kwargs["values"]
			self.assertEqual(values["company"], "Mule City")
			self.assertEqual(values["pos_profile"], "Mule City Retail")
			self.assertEqual(values["warehouse"], "Stores - MC")
