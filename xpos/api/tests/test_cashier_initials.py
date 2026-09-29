# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Cashier initials on a shared register login (Mule City, MuleCity-fb00.2).

Bill (2026-09-29): Mule City signs the register in as one shared "POS" user and
several cashiers use it. On every sale, returns included, the cashier types
their initials at Pay. It is honor system (no PIN), but the initials must be on
the POS Profile's cashier list, and they are saved on the Sales Invoice so we
know who rang each sale. A sale paid while the register was offline is never
lost over its initials: it is saved and the invoice gets a note instead.
"""

import unittest
from unittest.mock import MagicMock, patch

from xpos.api import invoices

CASHIERS = [
	{"initials": "LE", "cashier_name": "Lee Evans"},
	# Typed in lowercase on the profile; still matches "BC".
	{"initials": " bc", "cashier_name": "Bill Cromie"},
]


def raising_throw(*args, **kwargs):
	"""Stand-in for ``frappe.throw`` that behaves like the real one (it raises)."""
	raise Exception(args[0] if args else "thrown")


def counter_profile(require_initials=1, cashiers=CASHIERS):
	"""The Mule City counter's POS Profile: every other setting reads as off."""
	fields = {"xpos_require_cashier_initials": require_initials, "xpos_cashiers": cashiers}
	pos = MagicMock()
	pos.name = "Mule City Counter"
	pos.company = "Mule City"
	pos.warehouse = "Store - MC"
	pos.currency = "USD"
	pos.get.side_effect = lambda key, default=None: fields.get(key, 0)
	return pos


def stored_cashier(invoice):
	"""What the invoice holds in ``pos_cashier``, or None if it was never set.

	A MagicMock invents attributes on read; one set by the code is in its __dict__.
	"""
	return vars(invoice).get("pos_cashier")


class TestCashierInitialsAtPay(unittest.TestCase):
	"""User stories: the cashier types their initials at Pay and the sale records them."""

	def setUp(self):
		self.stub("build_tender_legs", return_value=([{"mode_of_payment": "Cash", "amount": 20.0}], 20.0))
		self.stub("build_change_legs", return_value=([], 0.0))
		self.stub("invoice_currency_of", return_value="USD")
		self.stub("get_currency_precision", return_value=2)
		self.stub("get_invoice_type", return_value="Sales Invoice")
		# The right to sell and the return lookup have their own tests.
		self.stub("resolve_pos_profile")
		self.stub("_validate_return_invoice", side_effect=lambda against, customer, items: items)
		self.stub("find_invoice_by_local_id", return_value=None)
		# Guards run after the invoice is saved; each has its own tests.
		self.stub("enforce_stock_availability")
		self.stub("check_expected_total")
		self.stub("_validate_unpaid_balance_permissions")
		for target, kwargs in (
			# The Mule City tax adapter and FBR fiscalization have their own tests.
			("mulecity_erpnext.pos_workspace.apply_customer_taxes", {}),
			("xpos.x_pos.integrations.fbr.prepare_fiscalization", {"return_value": MagicMock(status="disabled")}),
		):
			patcher = patch(target, **kwargs)
			patcher.start()
			self.addCleanup(patcher.stop)

		self.frappe = self.stub("frappe")
		self.frappe.throw.side_effect = raising_throw
		self.frappe.db.get_value.return_value = "Debtors - MC"
		self.new_invoice()

	def new_invoice(self):
		"""The unsaved invoice the next sale fills in."""
		self.invoice = MagicMock()
		self.invoice.name = "ACC-SINV-2026-00001"
		self.invoice.as_dict.return_value = {"name": self.invoice.name}
		self.frappe.new_doc.return_value = self.invoice

	def stub(self, name, **kwargs):
		"""Patch `name` in the xpos.api.invoices namespace for the current test."""
		patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
		mocked = patcher.start()
		self.addCleanup(patcher.stop)
		return mocked

	def sale(self, profile, local_id=None, **fields):
		"""Ring a $20 sale at the counter through ``create_invoice``."""
		self.frappe.get_cached_doc.return_value = profile
		data = {
			"pos_profile": profile.name,
			"customer": "Walk-In Customer",
			"items": [{"item_code": "LAYER-PELLET", "qty": 1, "rate": 20}],
			"payments": [{"mode_of_payment": "Cash", "amount": 20}],
			"local_id": "inv_abc",
			**fields,
		}
		return invoices.create_invoice(data, local_id=local_id)

	def test_known_initials_are_saved_on_the_invoice(self):
		"""Lee types LE at Pay: the sale is saved and says Lee rang it."""
		self.sale(counter_profile(), pos_cashier="LE")

		self.invoice.insert.assert_called_once()
		self.assertEqual(stored_cashier(self.invoice), "LE")
		self.invoice.add_comment.assert_not_called()

	def test_initials_are_trimmed_and_uppercased(self):
		"""Typed " le " or "bc" match LE and a lowercase " bc" row, and are stored as LE and BC."""
		self.sale(counter_profile(), pos_cashier=" le ")
		self.assertEqual(stored_cashier(self.invoice), "LE")

		self.new_invoice()
		self.sale(counter_profile(), pos_cashier="bc")
		self.assertEqual(stored_cashier(self.invoice), "BC")

	def test_a_sale_without_initials_is_refused(self):
		"""Pay with no initials is refused and nothing is saved."""
		with self.assertRaises(Exception) as refused:
			self.sale(counter_profile(), pos_cashier="  ")

		self.assertIn("cashier initials", str(refused.exception))
		self.invoice.insert.assert_not_called()

	def test_initials_not_on_the_list_are_refused(self):
		"""Someone types ZZ, who is not on the counter's cashier list: refused, nothing saved."""
		with self.assertRaises(Exception) as refused:
			self.sale(counter_profile(), pos_cashier="zz")

		self.assertIn("ZZ", str(refused.exception))
		self.invoice.insert.assert_not_called()

	def test_a_return_needs_initials_too(self):
		"""A refund goes through the same Pay: without initials it is refused; with them it records who."""
		returning = {
			"is_return": 1,
			"return_against": "ACC-SINV-2026-00000",
			"items": [{"item_code": "LAYER-PELLET", "qty": -1, "rate": 20}],
			"payments": [{"mode_of_payment": "Cash", "amount": -20}],
		}
		with self.assertRaises(Exception) as refused:
			self.sale(counter_profile(), **returning)
		self.assertIn("cashier initials", str(refused.exception))
		self.invoice.insert.assert_not_called()

		self.sale(counter_profile(), pos_cashier="le", **returning)
		self.assertEqual(self.invoice.is_return, 1)
		self.assertEqual(stored_cashier(self.invoice), "LE")

	def test_an_offline_sale_with_unknown_initials_is_saved_with_a_note(self):
		"""Paid offline as ZZ; the queue replays it later. The paid sale is kept, with a note."""
		self.sale(counter_profile(), local_id="inv_abc", pos_cashier="zz")

		self.invoice.insert.assert_called_once()
		self.assertEqual(stored_cashier(self.invoice), "ZZ")
		kind, note = self.invoice.add_comment.call_args.args
		self.assertEqual(kind, "Comment")
		self.assertIn("ZZ", note)

	def test_an_offline_sale_without_initials_is_saved_with_a_note(self):
		"""Queued before initials were required (or typed blank): kept, and the note says so."""
		self.sale(counter_profile(), local_id="inv_abc")

		self.invoice.insert.assert_called_once()
		self.assertIsNone(stored_cashier(self.invoice))
		self.invoice.add_comment.assert_called_once()

	def test_an_offline_sale_with_known_initials_needs_no_note(self):
		"""The usual offline case: LE was typed at Pay; it syncs like any other sale."""
		self.sale(counter_profile(), local_id="inv_abc", pos_cashier="LE")

		self.assertEqual(stored_cashier(self.invoice), "LE")
		self.invoice.add_comment.assert_not_called()

	def test_with_the_flag_off_the_field_is_ignored(self):
		"""A register that does not ask for initials sells as today, even if some are sent."""
		self.sale(counter_profile(require_initials=0))
		self.invoice.insert.assert_called_once()
		self.assertIsNone(stored_cashier(self.invoice))

		self.new_invoice()
		self.sale(counter_profile(require_initials=0), pos_cashier="LE")
		self.assertIsNone(stored_cashier(self.invoice))
		self.invoice.add_comment.assert_not_called()

	def test_an_empty_cashier_list_refuses_every_online_sale(self):
		"""Flag on with no cashiers listed is a setup mistake; no initials can match."""
		with self.assertRaises(Exception) as refused:
			self.sale(counter_profile(cashiers=[]), pos_cashier="LE")
		self.assertIn("LE", str(refused.exception))
		self.invoice.insert.assert_not_called()


class TestNormalizeInitials(unittest.TestCase):
	def test_trims_and_uppercases(self):
		self.assertEqual(invoices.normalize_initials("  le "), "LE")
		self.assertEqual(invoices.normalize_initials(None), "")
