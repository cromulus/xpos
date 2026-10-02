"""Delivery quoted by the site through hooks (Mule City, MuleCity-6nb1).

XPOS knows no delivery rule: the site names its policy, quote, customer details
and typed-miles recorder in hooks.py (``xpos_delivery_*``), and XPOS resolves
them with ``frappe.get_hooks``. Without the hooks there is no quoted delivery.
"""

import unittest
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import delivery

POLICY = {"rate_per_mile": 5.0, "round_to": 5.0, "local_miles": 5.0, "local_charge": 5.0,
	"bands": [{"min_lb": 0.0, "pct": 25.0}], "item_code": "DEL"}


def site_hooks(**methods):
	"""Stand in for the site's hooks.py: {hook name: callable}."""
	registry = {f"site.{name}": fn for name, fn in methods.items()}

	def get_hooks(name):
		return [f"site.{name}"] if f"site.{name}" in registry else []

	return (
		patch.object(delivery.frappe, "get_hooks", side_effect=get_hooks),
		patch.object(delivery.frappe, "get_attr", side_effect=registry.__getitem__),
	)


class HookCase(unittest.TestCase):
	def with_hooks(self, **methods):
		for patcher in site_hooks(**methods):
			patcher.start()
			self.addCleanup(patcher.stop)


class TestThePolicy(HookCase):
	def test_the_site_policy_comes_with_its_delivery_item(self):
		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY), xpos_delivery_quote=lambda *a: {})
		item = frappe._dict(name="DEL", item_name="Delivery Charge", stock_uom="Nos", item_group="Services")
		with patch.object(delivery.frappe.db, "get_value", return_value=item), \
				patch.object(delivery, "walk_in_customers", return_value=[]):
			policy = delivery.get_delivery_policy()
		self.assertEqual(policy["rate_per_mile"], 5.0)
		self.assertEqual(policy["item"], {"item_code": "DEL", "item_name": "Delivery Charge",
			"stock_uom": "Nos", "item_group": "Services"})

	def test_negative_no_hooks_or_no_item_means_no_quoted_delivery(self):
		self.with_hooks()
		self.assertIsNone(delivery.get_delivery_policy())
		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY))  # a policy but no quote
		self.assertIsNone(delivery.get_delivery_policy())
		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY), xpos_delivery_quote=lambda *a: {})
		with patch.object(delivery.frappe.db, "get_value", return_value=None):
			self.assertIsNone(delivery.get_delivery_policy())


class TestTheQuote(HookCase):
	def test_the_site_quotes_the_cart_weighed_as_erpnext_weighs_it(self):
		asked = []

		def quote(customer, address, weight_lb):
			asked.append((customer, address, weight_lb))
			return {"amount": 105, "source": "miles"}

		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY), xpos_delivery_quote=quote)
		weights = [("FEED", 50.0), ("CORN", 1.0)]
		items = [{"item_code": "FEED", "qty": 30, "conversion_factor": 1},
			{"item_code": "CORN", "qty": 2, "conversion_factor": 50},
			{"item_code": "DEL", "qty": 1}]
		with patch.object(delivery.frappe, "get_all", return_value=weights) as get_all:
			self.assertEqual(delivery.quote_delivery("CUST", "ADDR", frappe.as_json(items)), {"amount": 105, "source": "miles"})
		self.assertEqual(asked, [("CUST", "ADDR", 1600.0)])
		# The delivery line itself is never weighed.
		self.assertNotIn("DEL", get_all.call_args.kwargs["filters"]["name"][1])

	def test_negative_a_site_without_the_hook_refuses_to_quote(self):
		self.with_hooks()
		with self.assertRaises(frappe.ValidationError):
			delivery.quote_delivery("CUST", "ADDR", "[]")


class TestCustomerDetails(HookCase):
	def test_the_site_details_ride_on_the_customer_rows(self):
		from xpos.api import customers

		details = {"C1": {"standing_charge": 80, "no_charge": False, "addresses": []}}
		self.with_hooks(xpos_delivery_customers=lambda names: {n: details[n] for n in names if n in details})
		rows = [{"name": "C1", "mobile_no": ""}, {"name": "C2", "mobile_no": ""}]
		with patch.object(customers.frappe.db, "sql", side_effect=[[], [
			{"name": "C1", "address_count": 1, "has_email": 0}, {"name": "C2", "address_count": 0, "has_email": 0}]]), \
			patch.object(customers, "_customer_contacts", return_value={}):
			customers._enrich_picker_customers(rows, None)
		self.assertEqual(rows[0]["xpos_delivery"], details["C1"])
		self.assertNotIn("xpos_delivery", rows[1])

	def test_negative_without_the_hook_rows_carry_nothing(self):
		self.with_hooks()
		self.assertEqual(delivery.customer_delivery(["C1"]), {})


class TestAnAddressTypedOffline(HookCase):
	def setUp(self):
		patcher = patch.object(delivery, "walk_in_customers", return_value=["Walk-In"])
		patcher.start()
		self.addCleanup(patcher.stop)

	def sale(self, **extra):
		return {"customer": "CUST", "xpos_new_shipping_address":
			{"address_line1": "88 New Ground Rd", "city": "Coats", "miles": 17.4}, **extra}

	def test_it_is_made_once_with_the_typed_miles_and_the_sale_ships_there(self):
		typed = []
		self.with_hooks(xpos_delivery_typed_miles=lambda doc, miles: typed.append(miles))
		address = MagicMock()
		address.name = "ADDR-NEW"
		data = self.sale()
		with patch.object(delivery.frappe.db, "sql", return_value=[]), \
			patch.object(delivery.frappe.db, "get_single_value", return_value="United States"), \
			patch.object(delivery.frappe, "get_doc", return_value=address) as get_doc:
			delivery.resolve_new_shipping_address(data)
		self.assertEqual(data["shipping_address_name"], "ADDR-NEW")
		self.assertEqual(typed, [17.4])
		address.insert.assert_called_once_with(ignore_permissions=True)
		made = get_doc.call_args.args[0]
		self.assertEqual((made["address_line1"], made["city"], made["links"]),
			("88 New Ground Rd", "Coats", [{"link_doctype": "Customer", "link_name": "CUST"}]))

	def test_a_replayed_sale_finds_the_address_it_made(self):
		self.with_hooks()
		data = self.sale()
		with patch.object(delivery.frappe.db, "sql", return_value=[["ADDR-NEW"]]), \
			patch.object(delivery.frappe, "get_doc") as get_doc:
			delivery.resolve_new_shipping_address(data)
		self.assertEqual(data["shipping_address_name"], "ADDR-NEW")
		get_doc.assert_not_called()

	def test_negative_a_sale_with_a_chosen_address_or_none_makes_nothing(self):
		with patch.object(delivery.frappe, "get_doc") as get_doc:
			delivery.resolve_new_shipping_address({"customer": "CUST", "shipping_address_name": "ADDR-1",
				"xpos_new_shipping_address": {"address_line1": "x", "city": "y"}})
			delivery.resolve_new_shipping_address({"customer": "CUST"})
		get_doc.assert_not_called()
		with self.assertRaises(frappe.ValidationError):
			delivery.resolve_new_shipping_address(self.sale(xpos_new_shipping_address={"address_line1": "", "city": "Coats"}))


	def test_an_address_from_the_mc23_form_is_made_by_the_sites_add_address_hook(self):
		"""The till's add-address form sends the whole address and a local id: when
		its own replay did not run first, the sale makes it the same way (typed miles
		flagged manual_offline)."""
		added = []
		self.with_hooks(xpos_add_delivery_address=lambda **args: added.append(args) or {"name": "ADDR-NEW"})
		data = self.sale(xpos_new_shipping_address={"address_line1": "88 New Ground Rd", "city": "Coats", "state": "NC",
			"pincode": "27521", "miles": 17.4, "local_id": "LOCAL-ADDR-1"})
		with patch.object(delivery.frappe, "get_doc") as get_doc:
			delivery.resolve_new_shipping_address(data)
		get_doc.assert_not_called()
		self.assertEqual(data["shipping_address_name"], "ADDR-NEW")
		self.assertEqual(added, [{"customer": "CUST", "address_line1": "88 New Ground Rd", "city": "Coats", "state": "NC",
			"pincode": "27521", "address_line2": None, "title": None, "delivery_miles": 17.4,
			"miles_source": "manual_offline", "local_id": "LOCAL-ADDR-1"}])

	def test_negative_a_walk_in_sale_typed_offline_makes_no_address(self):
		with patch.object(delivery.frappe, "get_doc") as get_doc, self.assertRaises(frappe.ValidationError):
			delivery.resolve_new_shipping_address(self.sale(customer="Walk-In"))
		get_doc.assert_not_called()


class TestNoDeliveryForWalkIns(HookCase):
	"""Bill 2026-10-01 22:52: a delivery always needs a real customer."""

	def test_the_walk_ins_are_every_profiles_default_customer_and_the_sites_own(self):
		self.with_hooks(xpos_walk_in_customers=lambda: ["CASH 338"])
		with patch.object(delivery.frappe, "get_all", return_value=["Walk-In", None]):
			self.assertEqual(delivery.walk_in_customers(), ["CASH 338", "Walk-In"])

	def test_the_till_caches_them_with_the_policy(self):
		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY), xpos_delivery_quote=lambda *a: {})
		item = frappe._dict(name="DEL", item_name="Delivery Charge", stock_uom="Nos", item_group="Services")
		with patch.object(delivery.frappe.db, "get_value", return_value=item), \
				patch.object(delivery, "walk_in_customers", return_value=["Walk-In"]):
			self.assertEqual(delivery.get_delivery_policy()["walk_in_customers"], ["Walk-In"])

	def refused(self, data):
		self.with_hooks(xpos_delivery_policy=lambda: dict(POLICY))
		with patch.object(delivery, "walk_in_customers", return_value=["Walk-In", "CASH 338"]):
			try:
				delivery.refuse_walk_in_delivery(data)
			except frappe.ValidationError as error:
				return str(error)
		return None

	def test_any_delivery_fact_on_a_walk_in_or_customerless_sale_is_refused(self):
		facts = ({"shipping_address_name": "ADDR-1"}, {"xpos_new_shipping_address": {"address_line1": "x", "city": "y"}},
			{"pos_delivery_miles": 12, "pos_delivery_date": "2026-10-03"}, {"items": [{"item_code": "DEL", "qty": 1}]})
		for customer in ("Walk-In", "CASH 338", "", None):
			for fact in facts:
				with self.subTest(customer=customer, fact=fact):
					self.assertIn("Delivery needs a named customer", self.refused({"customer": customer, **fact}) or "")

	def test_a_named_customer_a_day_alone_and_a_return_pass(self):
		self.assertIsNone(self.refused({"customer": "Greenview", "shipping_address_name": "ADDR-1",
			"items": [{"item_code": "DEL"}], "pos_delivery_miles": 12}))
		self.assertIsNone(self.refused({"customer": "Walk-In", "pos_delivery_date": "2026-10-03",
			"items": [{"item_code": "FEED"}]}))
		self.assertIsNone(self.refused({"customer": "CASH 338", "is_return": 1, "items": [{"item_code": "DEL", "qty": -1}]}))

	def test_every_sale_path_checks_before_it_makes_or_ships_anything(self):
		import inspect

		from xpos.api import invoices

		self.assertIn("refuse_walk_in_delivery(data)", inspect.getsource(invoices.apply_delivery_facts))
		self.assertIn("refuse_walk_in_delivery(data)", inspect.getsource(delivery.resolve_new_shipping_address))


class TestAddADeliveryAddressAtTheTill(HookCase):
	ADDRESS = {"address_line1": "88 New Ground Rd", "city": "Coats", "state": "NC", "pincode": "27521"}

	def test_xpos_hands_the_add_to_the_site(self):
		from xpos.api import customers

		added = []
		self.with_hooks(xpos_add_delivery_address=lambda **args: added.append(args) or {"name": "ADDR-NEW", "miles": 18.2})
		with patch.object(customers, "walk_in_customers", return_value=["Walk-In"]):
			result = customers.add_delivery_address("Greenview", **self.ADDRESS, delivery_miles=17.4,
				miles_source="manual_offline", local_id="LOCAL-ADDR-1")
		self.assertEqual(result, {"name": "ADDR-NEW", "miles": 18.2})
		self.assertEqual(added, [{"customer": "Greenview", **self.ADDRESS, "address_line2": None, "county": None,
			"country": "United States", "title": None, "delivery_miles": 17.4, "miles_source": "manual_offline",
			"local_id": "LOCAL-ADDR-1", "make_primary_shipping": 0}])
		self.assertTrue(customers.add_delivery_address in frappe.whitelisted)

	def test_negative_a_walk_in_no_customer_or_no_site_hook_adds_nothing(self):
		from xpos.api import customers

		added = []
		self.with_hooks(xpos_add_delivery_address=lambda **args: added.append(args))
		with patch.object(customers, "walk_in_customers", return_value=["Walk-In"]):
			for customer in ("Walk-In", ""):
				with self.subTest(customer=customer), self.assertRaises(frappe.ValidationError):
					customers.add_delivery_address(customer, **self.ADDRESS)
		self.assertEqual(added, [])
		self.with_hooks()
		with self.assertRaises(frappe.ValidationError):
			customers.add_delivery_address("Greenview", **self.ADDRESS)


class TestTheSaleIsFlagged(HookCase):
	def invoice(self):
		doc = MagicMock()
		doc.customer = "CUST"
		doc.get.return_value = "ADDR-NEW"
		return doc

	def test_a_sale_priced_from_typed_miles_gets_a_comment_with_both_values(self):
		self.with_hooks(xpos_delivery_customers=lambda names: {"CUST": {"addresses": [{"name": "ADDR-NEW", "miles": 18.2}]}})
		doc = self.invoice()
		with patch.object(delivery.frappe.db, "exists", return_value=None):
			delivery.note_typed_miles(doc, {"xpos_delivery": {"source": "miles", "miles": 17.4, "miles_source": "manual_offline"}})
		(kind, text), _ = doc.add_comment.call_args
		self.assertEqual(kind, "Comment")
		self.assertIn("17.4 mi typed there (manual_offline) to ADDR-NEW", text)
		self.assertIn("now has 18.2 mi", text)
		self.assertIn("not repriced", text)

	def test_a_parked_tab_is_flagged_when_saved_and_only_once(self):
		import inspect

		from xpos.api import invoices

		self.assertIn("note_typed_miles(invoice_doc, data)", inspect.getsource(invoices.save_draft_invoice))
		self.with_hooks()
		doc = self.invoice()
		quote = {"xpos_delivery": {"source": "miles", "miles": 17.4, "miles_source": "manual_offline"}}
		with patch.object(delivery.frappe.db, "exists", return_value=True):
			delivery.note_typed_miles(doc, quote)
		doc.add_comment.assert_not_called()

	def test_negative_looked_up_miles_standing_charges_and_no_delivery_are_not_flagged(self):
		self.with_hooks()
		for quote in ({"source": "miles", "miles": 42, "miles_source": "routes"},
				{"source": "standing", "miles": 40, "miles_source": "manual_offline"}, None):
			doc = self.invoice()
			delivery.note_typed_miles(doc, {"xpos_delivery": quote} if quote else {})
			doc.add_comment.assert_not_called()


class TestTheSaleCarriesItsAddressAndLineDescription(unittest.TestCase):
	"""The invoice builders set shipping_address_name and a line's own description."""

	def test_both_builders_set_them(self):
		import inspect

		from xpos.api import invoices

		for builder in (invoices._build_invoice_doc, invoices.save_draft_invoice):
			source = inspect.getsource(builder)
			self.assertIn("apply_delivery_facts(invoice_doc, data)", source)
			self.assertIn('item.description = item_data["description"]', source)
		# Only saving makes an offline-typed address; the preview never does.
		self.assertIn("resolve_new_shipping_address(data)", inspect.getsource(invoices.create_invoice))
		self.assertNotIn("resolve_new_shipping_address", inspect.getsource(invoices._build_invoice_doc))
		# A parked sale reopened keeps both.
		details = inspect.getsource(invoices.get_invoice_details)
		self.assertIn('"description": i.description', details)
		self.assertIn('"shipping_address_name": doc.get("shipping_address_name")', details)
		self.assertIn('"pos_delivery_miles": doc.get("pos_delivery_miles")', details)


class TestTheSaleKeepsItsDeliveryFacts(unittest.TestCase):
	"""Bill 2026-10-01 (MuleCity-qajl): the address, day and miles are stored on
	the sale as they were at the till; prints never read today's Address."""

	def apply(self, data):
		from xpos.api import invoices

		doc = frappe._dict()
		# A named customer's sale (a walk-in's is refused: TestNoDeliveryForWalkIns).
		with patch("frappe.contacts.doctype.address.address.get_address_display", return_value="12 Mill Rd<br>Angier") as display, \
				patch.object(invoices, "refuse_walk_in_delivery"):
			invoices.apply_delivery_facts(doc, {"customer": "Greenview", **data})
		return doc, display

	def test_address_day_and_miles_from_the_address(self):
		doc, display = self.apply({"shipping_address_name": "ADDR-BARN", "pos_delivery_date": "2026-10-03",
			"pos_delivery_miles": 17.4, "pos_delivery_miles_source": "address"})
		display.assert_called_once_with("ADDR-BARN")
		self.assertEqual((doc.shipping_address_name, doc.shipping_address, doc.pos_delivery_date),
			("ADDR-BARN", "12 Mill Rd<br>Angier", "2026-10-03"))
		self.assertEqual((doc.pos_delivery_miles, doc.pos_delivery_miles_source), (17.4, "address"))

	def test_miles_the_clerk_typed_are_flagged_manual(self):
		doc, _ = self.apply({"shipping_address_name": "ADDR-SHED", "pos_delivery_miles": "9.5", "pos_delivery_miles_source": "manual"})
		self.assertEqual((doc.pos_delivery_miles, doc.pos_delivery_miles_source), (9.5, "manual"))

	def test_negative_no_miles_or_an_unknown_source_stores_no_source(self):
		doc, display = self.apply({"pos_delivery_miles": 0, "pos_delivery_miles_source": "manual"})
		display.assert_not_called()
		self.assertEqual((doc.pos_delivery_miles, doc.pos_delivery_miles_source), (None, None))
		self.assertNotIn("shipping_address_name", doc)
		doc, _ = self.apply({"pos_delivery_miles": 12, "pos_delivery_miles_source": "routes"})
		self.assertEqual((doc.pos_delivery_miles, doc.pos_delivery_miles_source), (12, None))

	def test_the_fields_exist_on_sales_and_pos_invoices(self):
		import json
		import os

		import xpos

		root = os.path.join(os.path.dirname(xpos.__file__), "x_pos", "custom")
		for name, doctype in (("sales_invoice.json", "Sales Invoice"), ("pos_invoice.json", "POS Invoice")):
			with open(os.path.join(root, name)) as f:
				fields = {row["fieldname"]: row for row in json.load(f)["custom_fields"]}
			self.assertEqual(fields["pos_delivery_miles"]["fieldtype"], "Float", doctype)
			self.assertEqual(fields["pos_delivery_miles_source"]["options"], "\naddress\nmanual", doctype)
