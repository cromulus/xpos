# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""What a till's payload may not change, and who may close a shift (mc63, MuleCity-0bsc).

Refusals that mc62 still let through: a saved invoice moved to another POS
Profile, company, owner or opening shift; desk shift-closing endpoints with no
permission check; a synced closing that brings its own expected cash; a legacy
quotation endpoint that saved whatever doctype it was sent. The database is
stubbed, so these run on any site:

    bench --site <site> run-tests --module xpos.api.tests.test_scope_guards
"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe

from xpos.api import shifts
from xpos.x_pos.api import quotations
from xpos.x_pos.api.invoice_processing import creation
from xpos.x_pos.doctype.pos_closing_shift.closing_processing import creation as closing_creation
from xpos.x_pos.doctype.pos_closing_shift.closing_processing import data as closing_data
from xpos.x_pos.doctype.pos_closing_shift.closing_processing import overview as closing_overview

PROFILE = frappe._dict(name="Mule City Retail", company="Mule City")


class Applied(Exception):
	"""The payload reached ``invoice_doc.update``: the guard let it through."""


class FakeInvoice:
	def __init__(self, **fields):
		self.__dict__.update(fields)
		self.applied = []

	def get(self, key, default=None):
		return self.__dict__.get(key, default)

	def update(self, data):
		self.applied.append(dict(data))
		raise Applied


def saved_draft():
	return FakeInvoice(
		name="ACC-SINV-1",
		doctype="Sales Invoice",
		pos_profile="Mule City Retail",
		company="Mule City",
		customer="Greenview",
		pos_opening_shift="POS-OS-1",
		docstatus=0,
	)


def refuse_unless(allowed):
	"""A frappe.has_permission stand-in: (doctype, ptype) pairs in ``allowed`` pass, the rest throw."""

	def has_permission(doctype=None, ptype="read", doc=None, *args, throw=False, **kwargs):
		if (doctype, ptype) in allowed:
			return True
		if throw:
			raise frappe.PermissionError(f"{ptype} {doctype}")
		return False

	return has_permission


class InvoiceCase(unittest.TestCase):
	def setUp(self):
		self.draft = saved_draft()
		for target, kwargs in (
			("get_pos_invoice", {"return_value": self.draft}),
			("get_invoice_type", {"return_value": "Sales Invoice"}),
			("resolve_pos_profile", {"return_value": PROFILE}),
		):
			patcher = patch.object(creation, target, **kwargs)
			setattr(self, target, patcher.start())
			self.addCleanup(patcher.stop)
		self.shifts = {"POS-OS-1": "Mule City Retail", "POS-OS-2": "Mule City Retail", "POS-OS-9": "Other Till"}
		for target, kwargs in (
			("frappe.db.exists", {"return_value": True}),
			(
				"frappe.db.get_value",
				{
					"side_effect": lambda doctype, name, *a, **k: (
						frappe._dict(name=name, pos_profile=self.shifts[name], user="pos@mulecity.com")
						if doctype == "POS Opening Shift" and name in self.shifts
						else None
					)
				},
			),
			("xpos.api.shifts.ensure_shift_access", {"return_value": None}),
			("xpos.api.customers.require_customer_access", {"side_effect": self._customer_access}),
		):
			patcher = patch(target, **kwargs)
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)

	@staticmethod
	def _customer_access(customer, ptype="read", pos_profile=None):
		if customer == "Insider":
			raise frappe.PermissionError(customer)
		return PROFILE

	def update(self, **data):
		return creation.update_invoice(json.dumps({"name": "ACC-SINV-1", **data}))


class TestSavedInvoiceStaysOnItsTill(InvoiceCase):
	def test_negative_a_saved_invoice_cannot_move_to_another_profile(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(pos_profile="Other Till")
		self.assertEqual(self.draft.applied, [])

	def test_negative_a_saved_invoice_cannot_move_to_another_company(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(company="Other Co")
		self.assertEqual(self.draft.applied, [])

	def test_negative_owner_and_docstatus_are_the_servers(self):
		with self.assertRaises(Applied):
			self.update(owner="boss@mulecity.com", docstatus=1, creation="2020-01-01", customer_name="Greenview")
		(applied,) = self.draft.applied
		for field in ("owner", "docstatus", "creation"):
			self.assertNotIn(field, applied)
		self.assertEqual(applied["customer_name"], "Greenview")

	def test_the_same_profile_and_company_pass(self):
		with self.assertRaises(Applied):
			self.update(pos_profile="Mule City Retail", company="Mule City")

	def test_negative_a_saved_invoice_cannot_join_another_tills_shift(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(pos_opening_shift="POS-OS-9")
		self.assertEqual(self.draft.applied, [])

	def test_negative_a_saved_invoice_cannot_join_an_unknown_shift(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(pos_opening_shift="POS-OS-NONE")

	def test_a_draft_resumed_on_the_tills_next_shift_moves_to_it(self):
		with self.assertRaises(Applied):
			self.update(pos_opening_shift="POS-OS-2")
		self.ensure_shift_access.assert_called_once()

	def test_negative_a_saved_invoice_cannot_change_to_a_customer_outside_the_profile(self):
		with self.assertRaises(frappe.PermissionError):
			self.update(customer="Insider")
		self.assertEqual(self.draft.applied, [])
		self.require_customer_access.assert_called_once_with("Insider", pos_profile="Mule City Retail")

	def test_negative_submitting_a_saved_draft_cannot_move_it_either(self):
		for field, value in (("pos_profile", "Other Till"), ("company", "Other Co"), ("customer", "Insider")):
			with self.subTest(field), self.assertRaises(frappe.PermissionError):
				creation.submit_invoice(json.dumps({"name": "ACC-SINV-1", field: value}), "{}")
		self.assertEqual(self.draft.applied, [])


class TestNewInvoiceIsScopedToTheProfile(InvoiceCase):
	def test_negative_a_new_invoice_for_another_company_is_refused(self):
		with patch("frappe.get_doc") as get_doc:
			with self.assertRaises(frappe.PermissionError):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "company": "Other Co"}))
		get_doc.assert_not_called()

	def test_negative_a_new_invoice_for_a_customer_outside_the_profile_is_refused(self):
		with patch("frappe.get_doc") as get_doc:
			with self.assertRaises(frappe.PermissionError):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "customer": "Insider"}))
		get_doc.assert_not_called()

	def test_negative_a_new_invoice_cannot_name_its_owner(self):
		with patch("frappe.get_doc", side_effect=Applied) as get_doc:
			with self.assertRaises(Applied):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "owner": "boss@mulecity.com"}))
		made = get_doc.call_args.args[0]
		self.assertNotIn("owner", made)
		self.assertEqual((made["pos_profile"], made["company"]), ("Mule City Retail", "Mule City"))


class TestShiftClosing(unittest.TestCase):
	"""close_shift and the offline sync's create_closing_shift (upstream 86425a7, bb17c4f)."""

	def setUp(self):
		self.opening = SimpleNamespace(
			name="POS-OS-1",
			pos_profile="Other Till",
			company="Mule City",
			period_start_date="2026-11-12 07:00:00",
			user="pos@mulecity.com",
			balance_details=[SimpleNamespace(mode_of_payment="Cash", amount=100)],
		)
		self.closing = MagicMock()
		self.closing.name = "POS-CS-1"
		self.appended = []
		self.closing.append.side_effect = lambda table, row: self.appended.append((table, row))
		self.made = []

		def get_doc(*args, **kwargs):
			if args and args[0] == "POS Opening Shift":
				return self.opening
			self.made.append(args[0])
			return self.closing

		for target, kwargs in (
			("frappe.get_doc", {"side_effect": get_doc}),
			("frappe.db.get_value", {"return_value": None}),
			("xpos.api.shifts.can_close_shift", {"return_value": True}),
			("xpos.api.shifts.user_may_use_profile", {"return_value": False}),
			("xpos.api.shifts.get_invoice_type", {"return_value": "Sales Invoice"}),
			("xpos.api.shifts._get_shift_invoices", {"return_value": []}),
			("xpos.api.shifts.get_shift_till_payments", {"return_value": []}),
			(
				"xpos.api.shifts.get_shift_expected_amounts",
				{"return_value": {"Cash": {"amount": 400, "currency": "USD"}}},
			),
		):
			patcher = patch(target, **kwargs)
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)

	def test_negative_close_shift_refuses_a_profile_the_user_is_not_on(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.close_shift("POS-OS-1", "[]")
		self.closing.insert.assert_not_called()

	def test_negative_close_shift_needs_close_shift_on_the_shifts_own_profile(self):
		self.user_may_use_profile.return_value = True
		self.can_close_shift.side_effect = lambda user=None, pos_profile=None: pos_profile is None
		with self.assertRaises(frappe.PermissionError):
			shifts.close_shift("POS-OS-1", "[]")
		self.closing.insert.assert_not_called()

	def test_negative_a_synced_closing_refuses_a_profile_the_user_is_not_on(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.create_closing_shift({"pos_opening_shift": "POS-OS-1"})
		self.closing.insert.assert_not_called()

	def test_negative_a_synced_closing_cannot_bring_its_own_expected_cash(self):
		self.user_may_use_profile.return_value = True
		shifts.create_closing_shift(
			{
				"pos_opening_shift": "POS-OS-1",
				"pos_profile": "Mule City Retail",
				"company": "Other Co",
				"user": "boss@mulecity.com",
				# The till claims 300 was expected and counted: no shortage.
				"payment_reconciliation": [
					{"mode_of_payment": "Cash", "opening_amount": 999, "expected_amount": 300,
						"closing_amount": 300, "difference": 0},
				],
			}
		)
		(cash,) = [row for table, row in self.appended if table == "payment_reconciliation"]
		self.assertEqual(
			(cash["expected_amount"], cash["closing_amount"], cash["difference"], cash["opening_amount"]),
			(400, 300, -100, 100),
		)
		closing = frappe.get_doc.call_args_list[-1].args[0]
		self.assertEqual(
			(closing["pos_profile"], closing["company"], closing["user"]),
			("Other Till", "Mule City", frappe.session.user),
		)

	def test_negative_a_count_out_of_range_is_refused(self):
		self.user_may_use_profile.return_value = True
		for amount in (-1, 10**13):
			with self.subTest(amount), self.assertRaises(frappe.ValidationError):
				shifts.close_shift("POS-OS-1", json.dumps([{"mode_of_payment": "Cash", "closing_amount": amount}]))
		self.closing.insert.assert_not_called()


class TestDeskShiftClosing(unittest.TestCase):
	"""The desk POS Closing Shift endpoints need desk permission (upstream 86425a7, 882e1a8)."""

	def setUp(self):
		for target in (
			"xpos.x_pos.doctype.pos_closing_shift.closing_processing.data.submit_printed_invoices",
			"xpos.x_pos.doctype.pos_closing_shift.closing_processing.creation.submit_printed_invoices",
			"frappe.get_all",
		):
			patcher = patch(target, return_value=[])
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)

	def refuse(self, *allowed):
		patcher = patch("frappe.has_permission", side_effect=refuse_unless(set(allowed)))
		patcher.start()
		self.addCleanup(patcher.stop)

	def test_negative_shift_invoices_and_payments_need_read_on_the_shift(self):
		self.refuse(("POS Closing Shift", "read"))
		for call in (
			lambda: closing_data.get_pos_invoices("POS-OS-1", "Sales Invoice"),
			lambda: closing_data.get_payments_entries("POS-OS-1"),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		self.get_all.assert_not_called()
		self.submit_printed_invoices.assert_not_called()

	def test_negative_the_overview_needs_read_on_closing_shifts(self):
		self.refuse()
		with self.assertRaises(frappe.PermissionError):
			closing_overview.get_closing_shift_overview("POS-OS-1")
		with self.assertRaises(frappe.PermissionError):
			closing_overview.get_payment_reconciliation_details(frappe._dict(company="Mule City"))

	def test_negative_making_a_closing_needs_create_and_read_on_the_shift(self):
		self.refuse(("POS Closing Shift", "create"))
		with self.assertRaises(frappe.PermissionError):
			closing_creation.make_closing_shift_from_opening({"name": "POS-OS-1"})
		self.submit_printed_invoices.assert_not_called()

	def test_negative_submitting_a_closing_needs_submit(self):
		self.refuse(("POS Closing Shift", "read"), ("POS Closing Shift", "create"))
		with patch("frappe.get_doc") as get_doc:
			with self.assertRaises(frappe.PermissionError):
				closing_creation.submit_closing_shift(json.dumps({"doctype": "POS Closing Shift"}))
		get_doc.assert_not_called()

	def test_negative_a_submitted_closing_is_always_a_pos_closing_shift(self):
		self.refuse(("POS Closing Shift", "submit"))
		with patch("frappe.get_doc") as get_doc:
			closing_creation.submit_closing_shift(
				json.dumps({"doctype": "User", "email": "x@example.com", "owner": "Administrator"})
			)
		made = get_doc.call_args.args[0]
		self.assertEqual(made["doctype"], "POS Closing Shift")
		self.assertNotIn("owner", made)


class TestLegacyQuotations(unittest.TestCase):
	def test_negative_the_legacy_quotation_endpoint_saves_only_quotations(self):
		with (
			patch("frappe.has_permission", side_effect=refuse_unless({("Quotation", "create")})),
			patch("frappe.db.exists", return_value=False),
			patch("frappe.get_doc") as get_doc,
		):
			quotations.update_quotation({"doctype": "User", "email": "x@example.com"})
		self.assertEqual(get_doc.call_args.args[0]["doctype"], "Quotation")

	def test_negative_the_legacy_quotation_endpoints_need_quotation_permission(self):
		with (
			patch("frappe.has_permission", side_effect=refuse_unless(set())),
			patch("frappe.db.exists", return_value=True),
			patch("frappe.get_doc") as get_doc,
		):
			for call in (
				lambda: quotations.update_quotation({"name": "SAL-QTN-1"}),
				lambda: quotations.submit_quotation({"name": "SAL-QTN-1"}),
				lambda: quotations.submit_quotation({}),
			):
				with self.assertRaises(frappe.PermissionError):
					call()
		get_doc.return_value.save.assert_not_called()
