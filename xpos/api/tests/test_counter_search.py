"""Counter stories: find a feed by alias and a past sale by buyer or invoice."""
import unittest
from unittest.mock import MagicMock, patch
import frappe
from xpos.api.items import get_pos_items
from xpos.api.invoices import search_invoices_for_repeat


class TestCounterSearch(unittest.TestCase):
	def test_alias_is_searched_and_carried_into_the_browser_cache(self):
		config = {"fields": ["name", "item_name", "mule_legacy_product_code"],
			"item_search_limit": 0, "search_serial_no": 0, "search_batch_no": 0}
		with patch("xpos.api.items.frappe") as api, patch(
			"xpos.api.items.get_item_search_settings", return_value=config
		), patch("xpos.api.items.get_invoice_type", return_value="Sales Invoice"), patch(
			"xpos.api.items.get_stock_qty_map", return_value={"Prime": 1}
		), patch("xpos.api.items.selling_price", return_value=26.5):
			api.get_cached_doc.return_value = frappe._dict(warehouse="Main", item_groups=[], selling_price_list="Retail")
			api.get_list.return_value = [frappe._dict(item_code="Prime", mule_legacy_product_code="MP")]
			for term in ("MP", ""):
				rows = get_pos_items("Till", search_term=term)
				query = api.get_list.call_args.kwargs
				self.assertIn("mule_legacy_product_code", query["fields"])
				self.assertEqual(rows[0].mule_legacy_product_code, "MP")
				if term:
					self.assertIn(["mule_legacy_product_code", "like", "%MP%"], query["or_filters"])

	def test_repeat_search_matches_customer_without_relaxing_sale_scope(self):
		with patch("xpos.api.invoices.frappe") as api:
			api.get_list.return_value = [{"name": f"INV-{n}"} for n in range(21)]
			result = search_invoices_for_repeat("Mule", " SOUTHERN ", page=2)
			q = api.get_list.call_args.kwargs
			self.assertEqual(q["filters"], {"company":"Mule", "docstatus":1, "is_return":0})
			self.assertEqual(q["or_filters"], [[f,"like","%SOUTHERN%"] for f in ("name","customer","customer_name")])
			self.assertEqual(q["limit_start"],20)
			self.assertEqual(len(result["invoices"]),20)
			self.assertTrue(result["has_more"])

	def test_no_matching_invoice_is_an_empty_result(self):
		with patch("xpos.api.invoices.frappe") as api:
			api.get_list.return_value=[]
			self.assertEqual(search_invoices_for_repeat("Mule","missing"),{"invoices":[],"has_more":False})

	def test_invoice_number_and_explicit_customer_filters_are_preserved(self):
		with patch("xpos.api.invoices.frappe") as api:
			api.get_list.return_value=[]
			search_invoices_for_repeat("Mule","INV-123",customer="CUST",from_date="2026-01-01")
			q=api.get_list.call_args.kwargs
			self.assertIn(["name","like","%INV-123%"],q["or_filters"])
			self.assertEqual(q["filters"]["customer"],"CUST")
			self.assertEqual(q["filters"]["posting_date"],[">=","2026-01-01"])

	def test_recent_history_is_exact_customer_and_newest_first(self):
		with patch("xpos.api.invoices.frappe") as api:
			api.get_list.return_value = []
			search_invoices_for_repeat("Mule", customer="CUST-1")
			query = api.get_list.call_args.kwargs
			self.assertEqual(query["filters"]["customer"], "CUST-1")
			self.assertEqual(query["or_filters"], [])
			self.assertEqual(query["order_by"], "posting_date desc, name desc")


class TestCustomerAddress(unittest.TestCase):
	"""A cashier can create a customer with a complete linked mailing address."""
	def test_full_address_is_passed_to_the_native_address_document(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api, patch("xpos.api.customers.make_address") as address:
			api.db.get_single_value.side_effect = lambda dt, field: {"territory": "North Carolina", "country": "United States"}.get(field)
			create_customer("Test Buyer", customer_group="Individual", address_line1="123 Main St", address_line2="Suite 2", city="Benson", state="NC", pincode="27504")
			fields = api.get_doc.call_args.args[0]
			self.assertEqual(fields["territory"], "North Carolina")
			self.assertNotIn("gender", fields)
			data = address.call_args.args[0]
			self.assertEqual((data["address_line1"], data["address_line2"], data["state"], data["pincode"]), ("123 Main St", "Suite 2", "NC", "27504"))

	def test_partial_address_is_rejected_before_creating_customer(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api:
			api.throw.side_effect = ValueError("incomplete address")
			with self.assertRaises(ValueError):
				create_customer("Test Buyer", address_line1="123 Main St")
			api.get_doc.assert_not_called()

	def test_address_remains_optional(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe"), patch("xpos.api.customers.make_address") as address:
			create_customer("Test Buyer")
			address.assert_not_called()



class TestNewCustomerTaxExemptReason(unittest.TestCase):
	"""Cashier story (Mule City): a new farm or reseller customer is exempt from
	the first ticket. The counter sends why; the Customer's own validation (in
	mulecity_erpnext) turns the reason into the Tax Category. Sites without the
	field keep working and never accept a reason."""

	REASONS = ["Farm", "Reseller (resale certificate)"]

	def test_the_reason_goes_on_the_customer_and_normal_validation_runs(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api, patch(
			"xpos.api.customers.customer_tax_exempt_reasons", return_value=self.REASONS
		):
			create_customer("Test Farmer", mule_tax_exempt_reason="Farm")
			doc = api.get_doc.return_value
			doc.set.assert_any_call("mule_tax_exempt_reason", "Farm")
			# XPOS sets no Tax Category itself: the Customer's validate does.
			self.assertNotIn("tax_category", api.get_doc.call_args.args[0])
			doc.insert.assert_called_once_with(ignore_permissions=True)

	def test_no_reason_leaves_the_customer_alone(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api, patch(
			"xpos.api.customers.customer_tax_exempt_reasons", return_value=self.REASONS
		):
			create_customer("Test Buyer")
			self.assertNotIn(
				"mule_tax_exempt_reason", [c.args[0] for c in api.get_doc.return_value.set.call_args_list]
			)

	def test_negative_an_unknown_reason_is_refused(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api, patch(
			"xpos.api.customers.customer_tax_exempt_reasons", return_value=self.REASONS
		):
			api.throw.side_effect = ValueError("bad reason")
			with self.assertRaises(ValueError):
				create_customer("Test Buyer", mule_tax_exempt_reason="Tax free")
			api.get_doc.assert_not_called()

	def test_negative_a_site_without_the_field_refuses_a_reason(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe") as api, patch(
			"xpos.api.customers.customer_tax_exempt_reasons", return_value=[]
		):
			api.throw.side_effect = ValueError("no field")
			with self.assertRaises(ValueError):
				create_customer("Test Farmer", mule_tax_exempt_reason="Farm")
			api.get_doc.assert_not_called()

	def test_the_old_classification_arguments_are_gone(self):
		from xpos.api.customers import create_customer
		with patch("xpos.api.customers.frappe"):
			with self.assertRaises(TypeError):
				create_customer("Test Farmer", mule_customer_kind="Farmer")


class TestTaxExemptReasonOptions(unittest.TestCase):
	"""The picker's choices come from the Customer field, for users who may set it."""

	def meta(self, field, writable=(0, 1)):
		meta = MagicMock()
		meta.get_field.return_value = field
		meta.get_permlevel_access.return_value = list(writable)
		return meta

	def field(self, permlevel=1):
		return MagicMock(fieldtype="Select", options="\nFarm\nReseller (resale certificate)", permlevel=permlevel)

	def test_options_come_from_the_field(self):
		from xpos.api.customers import customer_tax_exempt_reasons
		with patch("xpos.api.customers.frappe") as api:
			api.get_meta.return_value = self.meta(self.field())
			self.assertEqual(customer_tax_exempt_reasons(), ["Farm", "Reseller (resale certificate)"])

	def test_negative_no_field_no_options(self):
		from xpos.api.customers import customer_tax_exempt_reasons
		with patch("xpos.api.customers.frappe") as api:
			api.get_meta.return_value = self.meta(None)
			self.assertEqual(customer_tax_exempt_reasons(), [])

	def test_negative_a_user_who_may_not_set_it_gets_no_options(self):
		from xpos.api.customers import customer_tax_exempt_reasons
		with patch("xpos.api.customers.frappe") as api:
			api.get_meta.return_value = self.meta(self.field(), writable=(0,))
			self.assertEqual(customer_tax_exempt_reasons(), [])
