"""Counter stories: useful identification, linked phones, and scoped net sales."""
import unittest
from unittest.mock import patch

from xpos.api import customers


class TestPickerContext(unittest.TestCase):
	def test_description_keeps_distinguishing_fields_without_generic_clutter(self):
		row = {"name": "MC-CUST-2980", "customer_name": "Southern Woods",
			"mule_filepro_alias_codes": "2980", "alias": "2980",
			"customer_group": "Mule City Customers", "territory": "United States",
			"mule_customer_kind": "Reseller"}
		self.assertEqual(customers._search_description(row, list(row)), "Reseller")

	def test_linked_phone_and_company_scoped_sales_are_batched(self):
		rows = [{"name": "C1", "mobile_no": ""}, {"name": "C2", "mobile_no": "222"}]
		with patch.object(customers.frappe.db, "sql", side_effect=[[
			{"link_name": "C1", "phone": "(919) 555-0100"}], [
			{"name": "C1", "address_count": 2, "has_email": 0},
			{"name": "C2", "address_count": 0, "has_email": 1}]]), \
			patch.object(customers.frappe, "has_permission", return_value=True), \
			patch.object(customers.frappe, "get_cached_value", return_value="USD"), \
			patch.object(customers, "today", return_value="2026-09-28"), \
			patch.object(customers.frappe, "get_list", side_effect=[
				[{"customer": "C1", "sales": 125}], [{"customer": "C1", "sales": -25}]
			]) as sales:
			customers._enrich_picker_customers(rows, "Mule")
		self.assertEqual(rows[0]["mobile_no"], "(919) 555-0100")
		self.assertEqual(rows[0]["xpos_sales_12mo"], 100)
		self.assertTrue(rows[0]["xpos_has_phone"])
		self.assertTrue(rows[0]["xpos_has_address"])
		self.assertEqual(rows[0]["xpos_address_count"], 2)
		self.assertFalse(rows[0]["xpos_has_email"])
		self.assertFalse(rows[1]["xpos_has_address"])
		self.assertTrue(rows[1]["xpos_has_email"])
		self.assertEqual(rows[1]["mobile_no"], "222")
		self.assertEqual(sales.call_args_list[0].kwargs["filters"]["is_consolidated"], 0)
		for call in sales.call_args_list:
			self.assertEqual(call.kwargs["filters"]["company"], "Mule")
			self.assertEqual(call.kwargs["filters"]["posting_date"],
				["between", ["2025-09-28", "2026-09-28"]])

	def test_sales_hidden_without_invoice_read_permission(self):
		rows = [{"name": "C1"}]
		with patch.object(customers.frappe.db, "sql", return_value=[]), \
			patch.object(customers.frappe, "has_permission", return_value=False), \
			patch.object(customers.frappe, "get_list") as sales:
			customers._enrich_picker_customers(rows, "Mule")
		self.assertNotIn("xpos_sales_12mo", rows[0])
		sales.assert_not_called()
