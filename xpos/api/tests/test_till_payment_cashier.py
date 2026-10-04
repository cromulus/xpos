# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Cashier initials on payments taken at the till (Mule City, MuleCity-b9df).

Bill (2026-10-03): payments taken at the till on the shared pos@ login (Receive
on Account, Settle an existing ticket) must ask for listed cashier initials like
Pay does, so the close sheet's per-cashier table files them under the cashier
instead of "(none)". The till asks; the server refuses a shared-login payment
without listed initials too, before anything is saved, so the rule does not rest
on the browser. Named logins record their own name. These payments are taken
online only, so there is no offline leniency.
"""

import unittest
from unittest.mock import MagicMock, patch

from xpos.api import payments
from xpos.api.tests.test_cashier_initials import NAMED_LOGIN, SHARED_LOGIN, counter_profile, raising_throw

SHIFT = "POS-OS-26-0000001"
PROFILE = "Mule City Counter"


def stored_cashier(doc):
	"""What the Payment Entry holds in ``pos_cashier``, or None if it was never set."""
	return vars(doc).get("pos_cashier")


class TillPaymentCase(unittest.TestCase):
	"""One frappe stand-in shared by the payments and invoices modules, signed in as pos@."""

	def setUp(self):
		self.frappe = MagicMock()
		self.frappe.throw.side_effect = raising_throw
		self.frappe.session.user = SHARED_LOGIN
		self.frappe.utils.get_fullname.side_effect = lambda user: {NAMED_LOGIN: "Ben Smith"}.get(user, user)
		self.frappe.get_cached_doc.return_value = counter_profile()
		for target in ("xpos.api.payments.frappe", "xpos.api.invoices.frappe"):
			patcher = patch(target, new=self.frappe)
			patcher.start()
			self.addCleanup(patcher.stop)
		self.pe = MagicMock()
		self.frappe.new_doc.return_value = self.pe


class TestStampTillPayment(TillPaymentCase):
	"""The rule, applied to a Payment Entry about to be saved."""

	def test_listed_initials_are_stamped_with_the_shift(self):
		payments.stamp_till_payment(self.pe, PROFILE, SHIFT, " le")
		self.assertEqual(self.pe.reference_no, SHIFT)
		self.assertEqual(stored_cashier(self.pe), "LE")

	def test_negative_no_initials_on_the_shared_login_is_refused(self):
		with self.assertRaisesRegex(Exception, "Enter your cashier initials to take this payment"):
			payments.stamp_till_payment(self.pe, PROFILE, SHIFT, "")
		self.assertIsNone(stored_cashier(self.pe))

	def test_negative_initials_not_on_the_list_are_refused(self):
		with self.assertRaisesRegex(Exception, "ZZ are not on the cashier list"):
			payments.stamp_till_payment(self.pe, PROFILE, SHIFT, "zz")
		self.assertIsNone(stored_cashier(self.pe))

	def test_a_named_login_is_not_asked_and_records_their_name(self):
		self.frappe.session.user = NAMED_LOGIN
		payments.stamp_till_payment(self.pe, PROFILE, SHIFT, None)
		self.assertEqual(stored_cashier(self.pe), "Ben Smith")

	def test_with_the_flag_off_nothing_is_asked(self):
		self.frappe.get_cached_doc.return_value = counter_profile(require_initials=0)
		payments.stamp_till_payment(self.pe, PROFILE, SHIFT, None)
		self.assertEqual(self.pe.reference_no, SHIFT)
		self.assertIsNone(stored_cashier(self.pe))


BANK = "erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account"
OUTSTANDING = "erpnext.accounts.doctype.payment_entry.payment_entry.get_outstanding_reference_documents"


@patch(OUTSTANDING, return_value=[])
@patch(BANK, return_value={"account": "Cash - MC"})
@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
class TestReceiveOnAccountAsTheSharedLogin(TillPaymentCase):
	"""pos@ takes $200 toward what a customer owes."""

	def setUp(self):
		super().setUp()
		self.frappe.db.exists.return_value = True
		self.frappe.db.get_value.return_value = "Mule City"
		self.pe.name = "ACC-PAY-0001"
		self.pe.unallocated_amount = 0
		self.pe.references = []

	def take(self, typed):
		return payments.receive_on_account("CUST-342", 200, "Cash", SHIFT, PROFILE, pos_cashier=typed)

	def test_listed_initials_are_saved_on_the_payment(self, *_):
		self.take("le")
		self.assertEqual(stored_cashier(self.pe), "LE")
		self.assertEqual(self.pe.reference_no, SHIFT)
		self.pe.insert.assert_called_once()

	def test_negative_without_initials_nothing_is_saved(self, *_):
		with self.assertRaisesRegex(Exception, "Enter your cashier initials to take this payment"):
			self.take(None)
		self.pe.insert.assert_not_called()
		self.pe.submit.assert_not_called()

	def test_negative_unlisted_initials_nothing_is_saved(self, *_):
		with self.assertRaisesRegex(Exception, "not on the cashier list"):
			self.take("ZZ")
		self.pe.insert.assert_not_called()


@patch(BANK, return_value={"account": "Cash - MC"})
@patch("xpos.api.payments.can_settle_outstanding", return_value=True)
class TestSettleAsTheSharedLogin(TillPaymentCase):
	"""pos@ settles an open ticket (the real create_payment_entry)."""

	def setUp(self):
		super().setUp()
		invoice = MagicMock()
		invoice.docstatus = 1
		invoice.outstanding_amount = 250.0
		invoice.customer = "CUST-001"
		invoice.company = "Mule City"
		self.frappe.db.exists.return_value = True
		self.frappe.get_doc.return_value = invoice
		self.frappe.db.get_value.return_value = 150.0
		self.pe.name = "ACC-PAY-0002"
		self.pe.docstatus = 1

	def settle(self, typed):
		return payments.settle_outstanding_invoice("SI-001", 100, "Cash", SHIFT, PROFILE, pos_cashier=typed)

	def test_listed_initials_are_saved_on_the_payment(self, *_):
		result = self.settle("bc")
		self.assertEqual(stored_cashier(self.pe), "BC")
		self.assertEqual(self.pe.reference_no, SHIFT)
		self.pe.insert.assert_called_once()
		self.assertEqual(result["payment_entry"], "ACC-PAY-0002")

	def test_negative_without_initials_nothing_is_saved(self, *_):
		with self.assertRaisesRegex(Exception, "Enter your cashier initials to take this payment"):
			self.settle("")
		self.pe.insert.assert_not_called()

	def test_negative_unlisted_initials_nothing_is_saved(self, *_):
		with self.assertRaisesRegex(Exception, "not on the cashier list"):
			self.settle("ZZ")
		self.pe.insert.assert_not_called()

	def test_a_named_login_settles_without_initials_under_their_name(self, *_):
		self.frappe.session.user = NAMED_LOGIN
		self.settle(None)
		self.assertEqual(stored_cashier(self.pe), "Ben Smith")
		self.pe.insert.assert_called_once()
