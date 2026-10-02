"""The till's add-address street typeahead goes through XPOS's own API (Mule City, MuleCity-p644).

User story: Leslie adds a new delivery address at the till. She types "88 New
Gr", picks Google's "88 New Ground Rd, Coats, NC" and the form fills in, with
the miles; the saved Address keeps the picked point. XPOS knows no Google: the
site answers through hooks (Mule City: address_lookup.autocomplete / resolve),
as it does for add_delivery_address. Without the hooks, or when the site cannot
look up, the clerk types the address as before.
"""

from unittest.mock import patch

import frappe

from xpos.api import customers, delivery
from xpos.api.tests.test_delivery import HookCase

SUGGESTIONS = [{"place_id": "ChIJ-88", "description": "88 New Ground Rd, Coats, NC, USA"}]
RESOLVED = {"address_line1": "88 New Ground Rd", "address_line2": None, "city": "Coats", "county": "Harnett County",
	"state": "NC", "pincode": "27521", "country": "United States", "latitude": 35.4123, "longitude": -78.6712,
	"validated": True, "formatted_address": "88 New Ground Rd, Coats, NC 27521, USA", "place_id": "ChIJ-88",
	"delivery_miles": 18.2}
ADDRESS = {"address_line1": "88 New Ground Rd", "city": "Coats", "state": "NC", "pincode": "27521"}


class TestTheTypeaheadIsTheSites(HookCase):
	def test_suggestions_and_the_pick_come_from_the_sites_hooks_with_the_session_token(self):
		asked = []
		self.with_hooks(
			xpos_address_autocomplete=lambda **args: asked.append(("autocomplete", args)) or SUGGESTIONS,
			xpos_address_resolve=lambda **args: asked.append(("resolve", args)) or dict(RESOLVED),
		)
		self.assertEqual(customers.address_autocomplete("88 New Gr", session_token="tok-1"), SUGGESTIONS)
		self.assertEqual(customers.address_resolve("ChIJ-88", session_token="tok-1"), RESOLVED)
		self.assertEqual(asked, [
			("autocomplete", {"text": "88 New Gr", "session_token": "tok-1"}),
			("resolve", {"place_id": "ChIJ-88", "session_token": "tok-1"}),
		])

	def test_both_are_endpoints(self):
		self.assertIn(customers.address_autocomplete, frappe.whitelisted)
		self.assertIn(customers.address_resolve, frappe.whitelisted)
		self.assertNotIn(customers.address_autocomplete, frappe.guest_methods)
		self.assertNotIn(customers.address_resolve, frappe.guest_methods)

	def test_no_suggestions_is_an_empty_list(self):
		self.with_hooks(xpos_address_autocomplete=lambda **args: None)
		self.assertEqual(customers.address_autocomplete("88 N"), [])

	def test_negative_a_site_without_a_lookup_refuses_and_the_till_types_the_address(self):
		self.with_hooks()
		for call in (lambda: customers.address_autocomplete("88 New Gr"), lambda: customers.address_resolve("ChIJ-88")):
			with self.assertRaises(frappe.ValidationError):
				call()

	def test_negative_the_sites_refusal_reaches_the_till_unchanged(self):
		"""No key, Google's 403 (AddressLookupUnavailable) or too many lookups: the till shows its note."""

		def unavailable(**args):
			raise frappe.ValidationError("Address lookup is unavailable — type the address by hand.")

		def too_many(**args):
			raise frappe.RateLimitExceededError("Too many address lookups")

		self.with_hooks(xpos_address_autocomplete=unavailable, xpos_address_resolve=too_many)
		with self.assertRaises(frappe.ValidationError):
			customers.address_autocomplete("88 New Gr", session_token="tok-1")
		with self.assertRaises(frappe.RateLimitExceededError):
			customers.address_resolve("ChIJ-88", session_token="tok-1")


class TestThePickedPointIsSaved(HookCase):
	def test_the_picked_point_reaches_the_sites_add_address(self):
		added = []
		self.with_hooks(xpos_add_delivery_address=lambda **args: added.append(args) or {"name": "ADDR-NEW"})
		with patch.object(customers, "walk_in_customers", return_value=["Walk-In"]):
			customers.add_delivery_address("Greenview", **ADDRESS, county="Harnett County",
				latitude="35.4123", longitude="-78.6712")
		self.assertEqual(added[0]["latitude"], 35.4123)
		self.assertEqual(added[0]["longitude"], -78.6712)
		self.assertEqual(added[0]["county"], "Harnett County")

	def test_negative_a_typed_address_sends_no_point_so_older_site_hooks_still_work(self):
		def add(customer, address_line1, city, state, pincode, address_line2=None, county=None, country=None,
				title=None, delivery_miles=None, miles_source=None, local_id=None, make_primary_shipping=0):
			return {"name": "ADDR-NEW"}

		self.with_hooks(xpos_add_delivery_address=add)
		with patch.object(customers, "walk_in_customers", return_value=["Walk-In"]):
			self.assertEqual(customers.add_delivery_address("Greenview", **ADDRESS), {"name": "ADDR-NEW"})
			self.assertEqual(customers.add_delivery_address("Greenview", **ADDRESS, latitude="", longitude=None),
				{"name": "ADDR-NEW"})

	def test_an_address_queued_after_a_pick_carries_its_point_to_the_sale_fallback(self):
		self.assertEqual(delivery._add_address_args("CUST", {**ADDRESS, "latitude": 35.4123, "longitude": -78.6712}),
			{"customer": "CUST", **ADDRESS, "address_line2": None, "title": None, "delivery_miles": None,
			 "miles_source": "manual_offline", "local_id": None, "latitude": 35.4123, "longitude": -78.6712})
		self.assertNotIn("latitude", delivery._add_address_args("CUST", dict(ADDRESS)))

