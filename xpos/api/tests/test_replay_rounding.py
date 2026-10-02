"""User stories: an offline sale or return a cent off ERPNext's total settles (MuleCity-2un7).

Staging, 2026-10-02 (mc23 walk): ACC-SINV-49757 sold $6 of goods at NC 6.75%.
ERPNext totals the tax on the net, $0.405, and rounds it half away from zero
(System Settings "Commercial Rounding") to $0.41: $6.41. The offline return
ACC-SINV-49758 was refunded $6.40, because the till rounded -$0.405 with JS
Math.round (half toward +infinity) to -$0.40. The return posted -$6.41 against
a -$6.40 refund: -$0.01 outstanding on a return that is settled in the drawer.

The till now rounds as ERPNext does. As a safety net, an offline sale or return
replayed a cent short of the invoice's total writes that cent off to the POS
Profile's write-off account (ERPNext's own POS ``write_off_amount``), keeps the
payment as paid and notes it on the timeline. Never more than one cent, and only
on an offline replay. The register sells as the shared counter login, as Mule
City's counter does (MuleCity-g4gj).
"""

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import cint, flt

from xpos.api.invoices import _build_invoice_doc, create_invoice
from xpos.api.utilities import get_invoice_type

PROFILE = "Mule City Retail"


def shared_counter_login() -> tuple[str, str] | None:
	"""The profile's shared counter login and a listed cashier's initials, made by the app's recipe."""
	try:
		from mulecity_erpnext.configuration import configure_role_profiles, configure_staff_users
		from mulecity_erpnext.xpos_settings import CASHIERS_FIELD, ensure_cashier_initials, shared_logins
	except ImportError:
		return None
	configure_role_profiles(apply=True)
	configure_staff_users(apply=True)
	ensure_cashier_initials()
	logins = sorted(shared_logins())
	if not logins:
		return None
	profile = frappe.get_doc("POS Profile", PROFILE)
	initials = [row.initials for row in profile.get(CASHIERS_FIELD) or [] if row.initials]
	return logins[0], (initials[0] if initials else "")


class TestOfflineReplayACentShort(IntegrationTestCase):
	def setUp(self):
		if not frappe.db.exists("POS Profile", PROFILE):
			self.skipTest(f"needs POS Profile {PROFILE}")
		if get_invoice_type() != "Sales Invoice":
			self.skipTest("the till posts POS Invoices here")
		self.profile = frappe.get_doc("POS Profile", PROFILE)
		if not self.profile.write_off_account:
			self.skipTest("the POS Profile has no write-off account")
		self.cash = next(
			(
				row.mode_of_payment
				for row in self.profile.payments
				if frappe.db.get_value("Mode of Payment", row.mode_of_payment, "type") == "Cash"
			),
			None,
		)
		if not self.cash:
			self.skipTest("needs a Cash mode on the POS Profile")
		login = shared_counter_login()
		if not login:
			self.skipTest("needs the app's shared counter login")
		self.user, self.initials = login
		self.run = frappe.generate_hash(length=6)
		self.customer = (
			frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": f"XPOS Replay Cent {self.run}",
					"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
					"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		# 49757's lines: a $5 charge and a $1 bag.
		self.lines = [(self._item("FIVE", 5), 5.0), (self._item("ONE", 1), 1.0)]
		self.addCleanup(frappe.set_user, "Administrator")

	def _item(self, suffix, rate):
		code = (
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": f"XPOS-CENT-{suffix}-{self.run}",
					"item_name": f"Replay cent {suffix}",
					"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
					"stock_uom": "Nos",
					"is_stock_item": 0,
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": code,
				"price_list": self.profile.selling_price_list,
				"price_list_rate": rate,
			}
		).insert(ignore_permissions=True)
		return code

	def _cart(self, sign=1):
		return {
			"pos_profile": PROFILE,
			"customer": self.customer,
			"pos_cashier": self.initials,
			"items": [
				{"item_code": code, "qty": sign, "rate": rate, "price_list_rate": rate}
				for code, rate in self.lines
			],
		}

	def _total(self, data):
		"""What ERPNext totals the cart at (built and rolled back, nothing kept)."""
		frappe.db.savepoint("xpos_cent_total")
		draft = _build_invoice_doc(dict(data))[0]
		draft.insert(ignore_permissions=True)
		total = flt(draft.rounded_total or draft.grand_total, 2)
		frappe.db.rollback(save_point="xpos_cent_total")
		return total

	def _sell(self, data, paid, offline=True):
		"""Post ``data`` paid ``paid`` in cash as the shared counter login; the invoice."""
		data = {**data, "payments": [{"mode_of_payment": self.cash, "amount": paid}]}
		local_id = f"offline-cent-{frappe.generate_hash(length=8)}"
		data["local_id"] = local_id
		frappe.set_user(self.user)
		try:
			result = create_invoice(frappe.as_json(data), local_id=local_id if offline else None)
		finally:
			frappe.set_user("Administrator")
		return frappe.get_doc(result.get("doctype") or "Sales Invoice", result["name"])

	def _rounding_notes(self, doc):
		return frappe.get_all(
			"Comment",
			filters={
				"reference_doctype": doc.doctype,
				"reference_name": doc.name,
				"comment_type": "Comment",
				"content": ("like", "%rounding difference%"),
			},
			pluck="content",
		)

	def _sale(self):
		total = self._total(self._cart())
		return self._sell(self._cart(), total), total

	def _return(self, sale):
		return {**self._cart(sign=-1), "is_return": 1, "return_against": sale.name}

	def test_the_49758_return_a_cent_short_settles_with_a_written_off_cent(self):
		"""The return of a $6.41 sale refunded $6.40 offline posts with nothing owing."""
		sale, total = self._sale()
		self.assertEqual(sale.docstatus, 1)
		self.assertEqual(flt(sale.outstanding_amount, 2), 0)

		refund = flt(total - 0.01, 2)
		doc = self._sell(self._return(sale), -refund)

		self.assertEqual(doc.docstatus, 1)
		self.assertEqual(cint(doc.is_return), 1)
		self.assertEqual(flt(doc.grand_total, 2), -total)
		# The refund stays what the drawer paid out; the cent is written off.
		self.assertEqual(flt(doc.paid_amount, 2), -refund)
		self.assertEqual(flt(doc.write_off_amount, 2), -0.01)
		self.assertEqual(doc.write_off_account, self.profile.write_off_account)
		self.assertEqual(flt(doc.outstanding_amount, 2), 0)
		self.assertEqual(len(self._rounding_notes(doc)), 1)
		gl = frappe.get_all(
			"GL Entry",
			filters={"voucher_no": doc.name, "account": doc.write_off_account, "is_cancelled": 0},
			fields=["debit", "credit"],
		)
		self.assertAlmostEqual(sum(flt(g.credit) - flt(g.debit) for g in gl), 0.01, places=2)

	def test_a_sale_a_cent_short_offline_settles_too(self):
		"""The same cent on a sale: posted, not refused as a partial payment, nothing owing."""
		total = self._total(self._cart())
		doc = self._sell(self._cart(), flt(total - 0.01, 2))

		self.assertEqual(doc.docstatus, 1)
		self.assertEqual(flt(doc.paid_amount, 2), flt(total - 0.01, 2))
		self.assertEqual(flt(doc.write_off_amount, 2), 0.01)
		self.assertEqual(flt(doc.outstanding_amount, 2), 0)
		self.assertEqual(len(self._rounding_notes(doc)), 1)

	def test_negative_two_cents_short_is_not_written_off(self):
		"""More than one cent is no rounding: it stays owing for someone to look at."""
		sale, total = self._sale()
		doc = self._sell(self._return(sale), -flt(total - 0.02, 2))

		self.assertEqual(flt(doc.write_off_amount, 2), 0)
		self.assertEqual(flt(doc.outstanding_amount, 2), -0.02)
		self.assertFalse(self._rounding_notes(doc))

	def test_negative_an_online_return_a_cent_short_is_left_as_posted(self):
		"""Only an offline replay is absorbed; online the till pays the server's own total."""
		sale, total = self._sale()
		doc = self._sell(self._return(sale), -flt(total - 0.01, 2), offline=False)

		self.assertEqual(flt(doc.write_off_amount, 2), 0)
		self.assertEqual(flt(doc.outstanding_amount, 2), -0.01)
		self.assertFalse(self._rounding_notes(doc))

	def test_a_paid_in_full_replay_is_untouched(self):
		"""The usual case: paid to the cent, no write-off and no note."""
		sale, _total = self._sale()

		self.assertEqual(flt(sale.write_off_amount, 2), 0)
		self.assertFalse(self._rounding_notes(sale))
