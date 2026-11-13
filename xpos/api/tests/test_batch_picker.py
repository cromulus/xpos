# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""The batch picker lists the lots on the shelf.

ERPNext v15+ moves batched stock through a Serial and Batch Bundle: the Stock
Ledger Entry's own ``batch_no`` stays empty and the lot lives on the bundle's
entries. The picker summed ``sle.batch_no``, so a lot received by Stock Entry
showed no batches at all. Here two lots are received by Stock Entry (which
makes the bundles) and the picker must list both, with their quantities, for
an administrator and for a cashier with no stock role.
"""

import frappe
from erpnext.tests.utils import ERPNextTestSuite
from frappe.utils import add_days, flt, today

from xpos.api.items import _get_batch_data, get_item_detail
from xpos.api.tests.test_profile_settings_hardening import (
	CASHIER,
	COMPANY,
	make_profile,
	setup_fixtures,
)

WAREHOUSE = "_Test Warehouse - _TC"
PROFILE = "_Test Batch Picker Profile"


class TestBatchPickerReadsBundles(ERPNextTestSuite):
	def setUp(self):
		frappe.set_user("Administrator")
		if not frappe.db.exists("Warehouse", WAREHOUSE):
			self.skipTest(f"needs ERPNext's test records ({WAREHOUSE})")
		setup_fixtures()
		self.profile = make_profile(PROFILE, warehouse=WAREHOUSE, users=[(CASHIER, "Cashier", 0)]).name
		self.run = frappe.generate_hash(length=6)
		self.item = (
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": f"_Test Lot Item {self.run}",
					"item_name": "Lot-tracked item",
					"item_group": "All Item Groups",
					"stock_uom": "Nos",
					"is_stock_item": 1,
					"has_batch_no": 1,
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		# The older lot has no expiry; the newer one does.
		self.old_lot = self._lot("OLD", manufacturing_date=add_days(today(), -2))
		self.new_lot = self._lot("NEW", expiry_date=add_days(today(), 365), manufacturing_date=today())
		self._move("Material Receipt", self.old_lot, 7)
		self._move("Material Receipt", self.new_lot, 5)

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	def _lot(self, tag, **dates):
		return (
			frappe.get_doc(
				{"doctype": "Batch", "batch_id": f"_TLOT-{tag}-{self.run}", "item": self.item, **dates}
			)
			.insert(ignore_permissions=True)
			.name
		)

	def _move(self, purpose, lot, qty):
		warehouse_field = "t_warehouse" if purpose == "Material Receipt" else "s_warehouse"
		entry = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": purpose,
				"company": COMPANY,
				"items": [
					{
						"item_code": self.item,
						warehouse_field: WAREHOUSE,
						"qty": qty,
						"basic_rate": 4,
						"use_serial_batch_fields": 1,
						"batch_no": lot,
					}
				],
			}
		)
		entry.insert(ignore_permissions=True)
		entry.submit()
		return entry

	def _picker(self):
		detail = get_item_detail(self.item, self.profile, warehouse=WAREHOUSE)
		return {b["batch_no"]: flt(b["qty"]) for b in detail["batches"]}

	def test_the_receipts_are_bundle_based(self):
		"""Precondition: the stock sits on bundles and the SLE carries no batch."""
		sles = frappe.get_all(
			"Stock Ledger Entry",
			filters={"item_code": self.item, "is_cancelled": 0},
			fields=["batch_no", "serial_and_batch_bundle"],
		)
		self.assertEqual(len(sles), 2)
		for sle in sles:
			self.assertTrue(sle.serial_and_batch_bundle, sle)
			self.assertFalse(sle.batch_no, sle)

	def test_both_lots_and_their_qty_come_back(self):
		lots = {b["batch_no"]: b for b in _get_batch_data(self.item, WAREHOUSE)}
		self.assertEqual(
			{lot: flt(b["batch_qty"]) for lot, b in lots.items()}, {self.old_lot: 7, self.new_lot: 5}
		)
		self.assertEqual(str(lots[self.new_lot]["expiry_date"]), str(add_days(today(), 365)))
		self.assertEqual(str(lots[self.old_lot]["manufacturing_date"]), str(add_days(today(), -2)))
		self.assertIsNone(lots[self.old_lot]["expiry_date"])

		self.assertEqual(self._picker(), {self.old_lot: 7, self.new_lot: 5})

	def test_a_cashier_without_stock_roles_sees_the_same_lots(self):
		self.assertFalse({"Stock User", "Stock Manager"} & set(frappe.get_roles(CASHIER)))
		frappe.set_user(CASHIER)
		self.assertEqual(self._picker(), {self.old_lot: 7, self.new_lot: 5})

	def test_a_sold_out_lot_and_an_expired_lot_are_not_offered(self):
		expired = self._lot("EXP", expiry_date=add_days(today(), 30))
		self._move("Material Receipt", expired, 3)
		frappe.db.set_value("Batch", expired, "expiry_date", add_days(today(), -1))
		self._move("Material Issue", self.new_lot, 5)
		self.assertEqual({b["batch_no"] for b in _get_batch_data(self.item, WAREHOUSE)}, {self.old_lot})
