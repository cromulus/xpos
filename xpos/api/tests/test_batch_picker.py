"""Counter story (MuleCity-86ea): the batch picker lists the lots on the shelf.

ERPNext v15+ moves batched stock through a Serial and Batch Bundle: the Stock
Ledger Entry's own ``batch_no`` stays empty and the lot lives on the bundle's
entries. The picker summed ``sle.batch_no``, so on staging (2026-10-01) a lot
with 20 on the shelf showed no batches at all. Here two lots are received by
Stock Entry (which makes the bundles) and the picker must list both, with their
quantities, for an administrator and for the shared cashier login.
"""

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, flt, today

from xpos.api.items import _get_batch_data, get_item_detail

CASHIER_ROLES = ("Mule POS Cashier", "Desk User")


class TestBatchPickerReadsBundles(IntegrationTestCase):
	def setUp(self):
		self.run = frappe.generate_hash(length=6)
		self.profile = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not self.profile:
			self.skipTest("needs a POS Profile")
		self.company, self.warehouse = frappe.db.get_value(
			"POS Profile", self.profile, ["company", "warehouse"]
		)
		if not self.warehouse:
			self.skipTest("the POS Profile has no warehouse")

		self.item = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": f"XPOS-LOT-{self.run}",
				"item_name": "Lot-tracked feed",
				"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
				"stock_uom": frappe.db.get_value("UOM", {"name": "Nos"}) or "Nos",
				"is_stock_item": 1,
				"has_batch_no": 1,
			}
		).insert().name
		# The older lot has no expiry (like the mill's lots); the newer one does.
		self.old_lot = self._lot("OLD", manufacturing_date=add_days(today(), -2))
		self.new_lot = self._lot("NEW", expiry_date=add_days(today(), 365), manufacturing_date=today())
		self._receive(self.old_lot, 7)
		self._receive(self.new_lot, 5)

	def _lot(self, tag, **dates):
		return (
			frappe.get_doc({"doctype": "Batch", "batch_id": f"XPOS-{tag}-{self.run}", "item": self.item, **dates})
			.insert()
			.name
		)

	def _receive(self, lot, qty):
		entry = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"company": self.company,
				"items": [
					{
						"item_code": self.item,
						"t_warehouse": self.warehouse,
						"qty": qty,
						"basic_rate": 4,
						"use_serial_batch_fields": 1,
						"batch_no": lot,
					}
				],
			}
		).insert()
		entry.submit()
		return entry

	def _picker(self):
		detail = get_item_detail(self.item, self.profile, warehouse=self.warehouse)
		return {b["batch_no"]: b for b in detail["batches"]}

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
		lots = {b["batch_no"]: b for b in _get_batch_data(self.item, self.warehouse)}
		self.assertEqual({lot: flt(b["batch_qty"]) for lot, b in lots.items()}, {self.old_lot: 7, self.new_lot: 5})
		self.assertEqual(str(lots[self.new_lot]["expiry_date"]), str(add_days(today(), 365)))
		self.assertEqual(str(lots[self.old_lot]["manufacturing_date"]), str(add_days(today(), -2)))
		self.assertIsNone(lots[self.old_lot]["expiry_date"])

		picker = self._picker()
		self.assertEqual({lot: flt(b["qty"]) for lot, b in picker.items()}, {self.old_lot: 7, self.new_lot: 5})
		self.assertEqual(str(picker[self.old_lot]["manufacturing_date"]), str(add_days(today(), -2)))

	def test_the_shared_cashier_login_sees_the_same_lots(self):
		missing = [role for role in CASHIER_ROLES if not frappe.db.exists("Role", role)]
		if missing:
			self.skipTest(f"no role {missing} on this site")
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": f"till.{self.run}@lots.test",
				"first_name": "Till",
				"send_welcome_email": 0,
				"roles": [{"role": role} for role in CASHIER_ROLES],
			}
		).insert()
		self.assertEqual(set(frappe.get_roles(user.name)) & {"Stock User", "Stock Manager"}, set())
		self.addCleanup(frappe.set_user, "Administrator")
		frappe.set_user(user.name)
		picker = self._picker()
		self.assertEqual({lot: flt(b["qty"]) for lot, b in picker.items()}, {self.old_lot: 7, self.new_lot: 5})

	def test_negative_a_sold_out_lot_and_an_expired_lot_are_not_offered(self):
		expired = self._lot("EXP", expiry_date=add_days(today(), 30))
		self._receive(expired, 3)
		frappe.db.set_value("Batch", expired, "expiry_date", add_days(today(), -1))
		issue = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Issue",
				"company": self.company,
				"items": [
					{
						"item_code": self.item,
						"s_warehouse": self.warehouse,
						"qty": 5,
						"use_serial_batch_fields": 1,
						"batch_no": self.new_lot,
					}
				],
			}
		).insert()
		issue.submit()
		self.assertEqual({b["batch_no"] for b in _get_batch_data(self.item, self.warehouse)}, {self.old_lot})
