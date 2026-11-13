# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""An offline sale or return replayed a cent short of ERPNext's total settles.

ERPNext totals tax on the net and rounds it half away from zero: $6 of goods at
6.75% is $0.405 tax, $0.41, $6.41. A till that rounded the return's -$0.405 half
toward +infinity refunded $6.40, so the return posted -$6.41 against a -$6.40
refund and left -$0.01 outstanding on a return already settled in the drawer.

On an offline replay ``create_invoice`` writes that one smallest unit off to the POS
Profile's write-off account (ERPNext's own POS ``write_off_amount``), keeps the payment
as paid and notes it on the timeline. Never more than one unit, never an overpayment,
and only on a replay.
"""

import unittest
from unittest.mock import MagicMock, patch

from xpos.api import invoices
from xpos.api.tests.test_invoices import tender_legs_from_payments


class FakeInvoice:
	"""Just enough of a Sales Invoice for absorb_replay_rounding."""

	def __init__(self, **fields):
		self.__dict__.update(
			{
				"is_pos": 1,
				"is_consolidated": 0,
				"is_return": 0,
				"company": "Test Company",
				"write_off_amount": 0,
				"write_off_account": None,
				"write_off_cost_center": None,
				"rounded_total": 0,
			}
		)
		self.__dict__.update(fields)
		self.save = MagicMock()

	def get(self, key, default=None):
		return self.__dict__.get(key, default)


def profile(**fields):
	values = {"write_off_account": "Write Off - TC", "write_off_cost_center": "Main - TC", **fields}
	return MagicMock(get=lambda key, default=None: values.get(key, default))


class TestAbsorbReplayRounding(unittest.TestCase):
	def setUp(self):
		for name, kwargs in (
			("invoice_currency_of", {"return_value": "USD"}),
			("get_currency_precision", {"return_value": 2}),
		):
			patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
			patcher.start()
			self.addCleanup(patcher.stop)
		patcher = patch("xpos.api.invoices.frappe")
		self.frappe = patcher.start()
		self.addCleanup(patcher.stop)
		self.frappe.get_cached_value.return_value = None
		self.frappe.utils.fmt_money.side_effect = lambda amount, currency=None: f"${amount:.2f}"

	def test_a_return_refunded_a_cent_short_writes_the_cent_off(self):
		doc = FakeInvoice(is_return=1, grand_total=-6.41, paid_amount=-6.40, outstanding_amount=-0.01)

		note = invoices.absorb_replay_rounding(doc, profile())

		self.assertEqual(doc.write_off_amount, -0.01)
		self.assertEqual(doc.write_off_account, "Write Off - TC")
		self.assertEqual(doc.write_off_cost_center, "Main - TC")
		doc.save.assert_called_once_with(ignore_permissions=True)
		self.assertIn("rounding difference", note)
		self.assertIn("return", note)
		self.assertIn("$6.40", note)
		self.assertIn("$6.41", note)

	def test_a_sale_paid_a_cent_short_writes_the_cent_off(self):
		doc = FakeInvoice(grand_total=6.41, paid_amount=6.40, outstanding_amount=0.01)

		note = invoices.absorb_replay_rounding(doc, profile())

		self.assertEqual(doc.write_off_amount, 0.01)
		self.assertIn("sale", note)

	def test_the_company_write_off_account_stands_in_for_the_profiles(self):
		self.frappe.get_cached_value.side_effect = lambda doctype, name, field: {
			"write_off_account": "Company Write Off - TC",
			"cost_center": "Company CC - TC",
		}[field]
		doc = FakeInvoice(grand_total=6.41, paid_amount=6.40, outstanding_amount=0.01)

		invoices.absorb_replay_rounding(doc, profile(write_off_account=None, write_off_cost_center=None))

		self.assertEqual(doc.write_off_account, "Company Write Off - TC")
		self.assertEqual(doc.write_off_cost_center, "Company CC - TC")

	def assertUntouched(self, doc, pos=None):
		self.assertIsNone(invoices.absorb_replay_rounding(doc, pos or profile()))
		self.assertEqual(doc.write_off_amount, 0)
		doc.save.assert_not_called()

	def test_negative_two_cents_short_is_no_rounding(self):
		self.assertUntouched(
			FakeInvoice(is_return=1, grand_total=-6.41, paid_amount=-6.39, outstanding_amount=-0.02)
		)

	def test_negative_an_overpaid_sale_is_change_not_a_write_off(self):
		self.assertUntouched(FakeInvoice(grand_total=6.41, paid_amount=6.42, outstanding_amount=-0.01))

	def test_negative_paid_in_full_or_unpaid_is_left_alone(self):
		self.assertUntouched(FakeInvoice(grand_total=6.41, paid_amount=6.41, outstanding_amount=0))
		self.assertUntouched(FakeInvoice(grand_total=0.01, paid_amount=0, outstanding_amount=0.01))

	def test_negative_no_write_off_account_anywhere(self):
		self.assertUntouched(
			FakeInvoice(grand_total=6.41, paid_amount=6.40, outstanding_amount=0.01),
			profile(write_off_account=None),
		)

	def test_negative_not_a_pos_invoice(self):
		self.assertUntouched(
			FakeInvoice(is_pos=0, grand_total=6.41, paid_amount=6.40, outstanding_amount=0.01)
		)


class TestOnlyAReplayIsAbsorbed(unittest.TestCase):
	"""create_invoice absorbs only when the sale's local_id comes as an argument (offline queue, desktop sync)."""

	def setUp(self):
		self.stub("build_tender_legs", side_effect=tender_legs_from_payments)
		self.stub("build_change_legs", return_value=([], 0.0))
		self.stub("invoice_currency_of", return_value="USD")
		self.stub("get_currency_precision", return_value=2)
		self.stub(
			"resolve_pos_profile",
			side_effect=lambda name: invoices.frappe.get_cached_doc("POS Profile", name),
		)
		self.stub("repricing_changes", return_value=None)
		self.stub("validate_sale_discounts")
		self.stub("check_zero_payable")
		self.stub("find_invoice_by_local_id", return_value=None)
		self.absorb = self.stub("absorb_replay_rounding", return_value="rounding note")

	def stub(self, name, **kwargs):
		patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
		mock = patcher.start()
		self.addCleanup(patcher.stop)
		return mock

	def sell(self, mock_frappe, **kwargs):
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-R"
		mock_invoice.as_dict.return_value = {"name": "INV-R"}
		mock_frappe.new_doc.return_value = mock_invoice

		invoices.create_invoice(
			{
				"pos_profile": "POS-PROFILE-1",
				"customer": "Customer A",
				"local_id": "inv_local_1",
				"items": [{"item_code": "ITEM-001", "qty": 1, "rate": 6}],
				"payments": [{"mode_of_payment": "Cash", "amount": 6.40}],
			},
			**kwargs,
		)
		return mock_invoice

	@patch("xpos.api.invoices.frappe")
	def test_an_offline_replay_is_absorbed_and_noted(self, mock_frappe):
		invoice = self.sell(mock_frappe, local_id="inv_local_1")

		self.absorb.assert_called_once()
		invoice.add_comment.assert_any_call("Comment", "rounding note")

	@patch("xpos.api.invoices.frappe")
	def test_negative_a_sale_taken_online_is_left_as_posted(self, mock_frappe):
		self.sell(mock_frappe)

		self.absorb.assert_not_called()
