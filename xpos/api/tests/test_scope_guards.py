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
_REAL_GET_DOC = frappe.get_doc


def fake_get_doc(opening=None, made=None):
	"""A frappe.get_doc stand-in: the opening shift, ``made`` for a new document, the real thing otherwise.

	Frappe's own lookups (System Settings for now_datetime) must stay real: a
	mock there is cached in Redis and cannot be pickled.
	"""

	def get_doc(*args, **kwargs):
		if args and isinstance(args[0], dict):
			return made(args[0]) if callable(made) and not isinstance(made, MagicMock) else made
		if args and args[0] == "POS Opening Shift" and opening is not None:
			return opening
		return _REAL_GET_DOC(*args, **kwargs)

	return get_doc


def new_doc_payload(get_doc_mock):
	"""The dict the last new document was built from (frappe.get_doc(dict))."""
	return [call.args[0] for call in get_doc_mock.call_args_list if call.args and isinstance(call.args[0], dict)][-1]


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
		made = []
		with patch("frappe.get_doc", side_effect=fake_get_doc(made=lambda d: made.append(d) or MagicMock())):
			with self.assertRaises(frappe.PermissionError):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "company": "Other Co"}))
		self.assertEqual(made, [])

	def test_negative_a_new_invoice_for_a_customer_outside_the_profile_is_refused(self):
		made = []
		with patch("frappe.get_doc", side_effect=fake_get_doc(made=lambda d: made.append(d) or MagicMock())):
			with self.assertRaises(frappe.PermissionError):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "customer": "Insider"}))
		self.assertEqual(made, [])

	def test_negative_a_new_invoice_cannot_name_its_owner(self):
		made_docs = []

		def make(data):
			made_docs.append(data)
			raise Applied

		with patch("frappe.get_doc", side_effect=fake_get_doc(made=make)):
			with self.assertRaises(Applied):
				creation.update_invoice(json.dumps({"pos_profile": PROFILE.name, "owner": "boss@mulecity.com"}))
		(made,) = made_docs
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

		for target, kwargs in (
			("frappe.get_doc", {"side_effect": fake_get_doc(self.opening, self.closing)}),
			("xpos.api.shifts.can_close_shift", {"return_value": True}),
			("xpos.api.shifts.user_may_use_profile", {"return_value": False}),
			("xpos.api.shifts.get_invoice_type", {"return_value": "Sales Invoice"}),
			("xpos.api.shifts._get_shift_invoices", {"return_value": []}),
			("xpos.api.shifts.get_shift_till_payments", {"return_value": []}),
			("xpos.api.shifts._get_shift_tax_summary", {"return_value": []}),
			(
				"xpos.api.shifts.get_shift_expected_amounts",
				{"return_value": {"Cash": {"amount": 400, "currency": "USD"}, "Card": {"amount": 75, "currency": "USD"}}},
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
				"grand_total": 99999,
				"net_total": 99999,
				"total_quantity": 999,
				"posting_date": "2020-01-01",
				"period_end_date": "2020-01-01 23:00:00",
				# The till claims 300 was expected and counted: no shortage. It leaves Card out.
				"payment_reconciliation": [
					{"mode_of_payment": "Cash", "opening_amount": 999, "expected_amount": 300,
						"closing_amount": 300, "difference": 0},
				],
			}
		)
		rows = {row["mode_of_payment"]: row for table, row in self.appended if table == "payment_reconciliation"}
		cash = rows["Cash"]
		self.assertEqual(
			(cash["expected_amount"], cash["closing_amount"], cash["difference"], cash["opening_amount"]),
			(400, 300, -100, 100),
		)
		# A mode the till left out is counted as 0, not dropped.
		self.assertEqual((rows["Card"]["closing_amount"], rows["Card"]["difference"]), (0, -75))
		closing = new_doc_payload(frappe.get_doc)
		self.assertEqual(
			(closing["pos_profile"], closing["company"], closing["user"]),
			("Other Till", "Mule City", frappe.session.user),
		)
		self.assertEqual((closing["grand_total"], closing["net_total"], closing["total_quantity"]), (0, 0, 0))
		self.assertNotEqual(str(closing["posting_date"]), "2020-01-01")

	def test_negative_a_synced_closing_cannot_count_a_mode_twice(self):
		self.user_may_use_profile.return_value = True
		with self.assertRaises(frappe.ValidationError):
			shifts.create_closing_shift(
				{
					"pos_opening_shift": "POS-OS-1",
					"payment_reconciliation": [
						{"mode_of_payment": "Cash", "closing_amount": 300},
						{"mode_of_payment": "Cash", "closing_amount": 100},
					],
				}
			)
		self.closing.insert.assert_not_called()

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

	def desk_submit(self, payload, exists=False, may_close=True):
		opening = SimpleNamespace(
			name="POS-OS-1",
			pos_profile="Mule City Retail",
			company="Mule City",
			period_start_date="2026-11-12 07:00:00",
			user="pos@mulecity.com",
			balance_details=[SimpleNamespace(mode_of_payment="Cash", amount=100)],
		)
		made = MagicMock()
		appended = []
		made.append.side_effect = lambda table, row: appended.append((table, row))
		invoices = [frappe._dict(name="ACC-SINV-1", grand_total=50, net_total=45, customer="Greenview",
			posting_date="2026-11-12", is_return=0)]
		with (
			patch("frappe.db.exists", return_value=exists),
			patch("frappe.get_doc", side_effect=fake_get_doc(opening, made)) as get_doc,
			patch("xpos.api.shifts.user_may_use_profile", return_value=may_close),
			patch("xpos.api.shifts.can_close_shift", return_value=True),
			patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice"),
			patch("xpos.api.shifts._get_shift_invoices", return_value=invoices),
			patch("xpos.api.shifts._get_shift_tax_summary", return_value=[]),
			patch("xpos.api.shifts.get_shift_till_payments", return_value=[]),
			patch(
				"xpos.api.shifts.get_shift_expected_amounts",
				return_value={"Cash": {"amount": 400, "currency": "USD"}, "Card": {"amount": 75, "currency": "USD"}},
			),
		):
			closing_creation.submit_closing_shift(json.dumps(payload))
		return new_doc_payload(get_doc), made, appended

	def test_negative_a_submitted_closing_is_always_a_new_pos_closing_shift(self):
		self.refuse(("POS Closing Shift", "submit"), ("POS Opening Shift", "read"))
		doc, made, _rows = self.desk_submit(
			{"doctype": "User", "email": "x@example.com", "owner": "Administrator", "pos_opening_shift": "POS-OS-1"}
		)
		self.assertEqual(doc["doctype"], "POS Closing Shift")
		self.assertNotIn("owner", doc)
		self.assertNotIn("email", doc)
		made.insert.assert_called_once_with()
		made.submit.assert_called_once_with()

	def test_negative_a_saved_closing_cannot_be_resubmitted_through_the_endpoint(self):
		self.refuse(("POS Closing Shift", "submit"), ("POS Opening Shift", "read"))
		with self.assertRaises(frappe.PermissionError):
			self.desk_submit({"name": "POS-CS-1", "pos_opening_shift": "POS-OS-1"}, exists=True)

	def test_negative_a_desk_closing_needs_read_on_its_opening_shift(self):
		self.refuse(("POS Closing Shift", "submit"))
		with self.assertRaises(frappe.PermissionError):
			self.desk_submit({"pos_opening_shift": "POS-OS-1"})

	def test_negative_a_desk_closing_needs_the_right_to_close_that_shift(self):
		self.refuse(("POS Closing Shift", "submit"), ("POS Opening Shift", "read"))
		with self.assertRaises(frappe.PermissionError):
			self.desk_submit({"pos_opening_shift": "POS-OS-1"}, may_close=False)

	def test_negative_a_desk_closing_takes_only_the_counts(self):
		self.refuse(("POS Closing Shift", "submit"), ("POS Opening Shift", "read"))
		doc, _made, appended = self.desk_submit(
			{
				"pos_opening_shift": "POS-OS-1",
				"pos_profile": "Other Till",
				"company": "Other Co",
				"user": "boss@mulecity.com",
				"grand_total": 99999,
				"net_total": 99999,
				"total_quantity": 999,
				"posting_date": "2020-01-01",
				"pos_transactions": [{"sales_invoice": "ACC-SINV-FORGED", "grand_total": 99999}],
				"taxes": [{"account_head": "Forged", "amount": 1}],
				"payment_reconciliation": [
					{"mode_of_payment": "Cash", "opening_amount": 999, "expected_amount": 300, "closing_amount": 300},
				],
			}
		)
		self.assertEqual(
			(doc["pos_profile"], doc["company"], doc["user"], doc["grand_total"], doc["net_total"], doc["total_quantity"]),
			("Mule City Retail", "Mule City", frappe.session.user, 50, 45, 1),
		)
		self.assertNotEqual(str(doc["posting_date"]), "2020-01-01")
		for field in ("pos_transactions", "taxes", "payment_reconciliation"):
			self.assertNotIn(field, doc)
		self.assertEqual(
			[row["sales_invoice"] for table, row in appended if table == "pos_transactions"], ["ACC-SINV-1"]
		)
		self.assertEqual([row for table, row in appended if table == "taxes"], [])
		rows = {row["mode_of_payment"]: row for table, row in appended if table == "payment_reconciliation"}
		self.assertEqual(
			(rows["Cash"]["opening_amount"], rows["Cash"]["expected_amount"], rows["Cash"]["difference"]),
			(100, 400, -100),
		)
		self.assertEqual(rows["Card"]["closing_amount"], 0)


class TestLegacyQuotations(unittest.TestCase):
	def test_negative_the_legacy_quotation_endpoint_saves_only_quotations(self):
		with (
			patch("frappe.has_permission", side_effect=refuse_unless({("Quotation", "create")})),
			patch("frappe.db.exists", return_value=False),
			patch("frappe.get_doc") as get_doc,
		):
			quotations.update_quotation({"doctype": "User", "email": "x@example.com"})
		self.assertEqual(get_doc.call_args.args[0]["doctype"], "Quotation")

	def test_negative_the_quotation_built_is_checked_as_a_document(self):
		"""Type-level create is not enough: the built Quotation (company, customer, User Permissions) is checked."""

		def has_permission(doctype=None, ptype="read", doc=None, *a, throw=False, **k):
			if doc is None:
				return True
			raise frappe.PermissionError("user permission")

		with (
			patch("frappe.has_permission", side_effect=has_permission),
			patch("frappe.db.exists", return_value=False),
			patch("frappe.get_doc") as get_doc,
		):
			for call in (
				lambda: quotations.update_quotation({"company": "Other Co", "party_name": "Insider"}),
				lambda: quotations.submit_quotation({"company": "Other Co", "party_name": "Insider"}),
			):
				with self.assertRaises(frappe.PermissionError):
					call()
		get_doc.return_value.save.assert_not_called()

	def test_negative_a_quotation_changed_into_one_the_user_may_not_have_is_refused(self):
		doc = MagicMock()
		checked = []

		def has_permission(doctype=None, ptype="read", doc=None, *a, throw=False, **k):
			checked.append(ptype)
			if len(checked) > 1:  # the check after update()
				raise frappe.PermissionError("changed company")
			return True

		with (
			patch("frappe.has_permission", side_effect=has_permission),
			patch("frappe.db.exists", return_value=True),
			patch("frappe.get_doc", return_value=doc),
		):
			with self.assertRaises(frappe.PermissionError):
				quotations.update_quotation({"name": "SAL-QTN-1", "company": "Other Co"})
		doc.update.assert_called_once()
		doc.save.assert_not_called()

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


class TestOpeningShiftOnTheCallersProfile(unittest.TestCase):
	"""open_shift and the offline sync's create_opening_shift (MuleCity-jn61).

	A shift opens only on a POS Profile the caller may use, in that profile's
	company, for the caller.
	"""

	def setUp(self):
		self.shift = MagicMock()
		self.shift.name = "POS-OS-7"
		self.shift.as_dict.return_value = {"name": "POS-OS-7"}
		self.real_cached = frappe.get_cached_doc
		for target, kwargs in (
			("frappe.get_doc", {"side_effect": fake_get_doc(made=self.shift)}),
			("frappe.session", {"new": frappe._dict(user="pos@mulecity.com")}),
			("frappe.db.exists", {"return_value": True}),
			("frappe.db.get_value", {"return_value": None}),
			(
				"frappe.get_cached_doc",
				{
					"side_effect": lambda doctype, *a, **k: (
						PROFILE if doctype == "POS Profile" else self.real_cached(doctype, *a, **k)
					)
				},
			),
			("xpos.api.profiles.user_may_use_profile", {"return_value": False}),
			("xpos.api.shifts._enrich_shift_data", {}),
		):
			patcher = patch(target, **kwargs)
			setattr(self, target.rsplit(".", 1)[-1], patcher.start())
			self.addCleanup(patcher.stop)

	def made(self):
		return [call.args[0] for call in self.get_doc.call_args_list if call.args and isinstance(call.args[0], dict)]

	def test_negative_open_shift_refuses_a_profile_the_user_is_not_on(self):
		with self.assertRaises(frappe.PermissionError):
			shifts.open_shift("Mule City Retail", "Mule City", "[]")
		self.assertEqual(self.made(), [])

	def test_negative_open_shift_refuses_another_company(self):
		self.user_may_use_profile.return_value = True
		with self.assertRaises(frappe.PermissionError):
			shifts.open_shift("Mule City Retail", "Other Co", "[]")
		self.assertEqual(self.made(), [])

	def test_open_shift_on_the_users_own_profile(self):
		self.user_may_use_profile.return_value = True
		shifts.open_shift("Mule City Retail", "Mule City", "[]")
		made = self.made()[-1]
		self.assertEqual(
			(made["pos_profile"], made["company"], made["user"]),
			("Mule City Retail", "Mule City", "pos@mulecity.com"),
		)
		self.shift.insert.assert_called_once()

	def test_negative_a_synced_opening_refuses_a_profile_the_user_is_not_on(self):
		data = {"pos_profile": "Mule City Retail", "company": "Mule City", "balance_details": []}
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift(json.dumps(data), local_id="local-1")
		self.assertEqual(self.made(), [])

	def test_negative_a_synced_opening_cannot_learn_another_tills_shift_by_its_local_id(self):
		self.get_value.return_value = "POS-OS-OTHER"
		data = {"pos_profile": "Mule City Retail", "company": "Mule City"}
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift(json.dumps(data), local_id="local-1")

	def test_negative_a_synced_opening_refuses_another_company(self):
		self.user_may_use_profile.return_value = True
		data = {"pos_profile": "Mule City Retail", "company": "Other Co"}
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift(json.dumps(data), local_id="local-1")
		self.assertEqual(self.made(), [])

	def test_negative_a_synced_opening_cannot_open_a_shift_for_someone_else(self):
		self.user_may_use_profile.return_value = True
		data = {"pos_profile": "Mule City Retail", "company": "Mule City", "user": "boss@mulecity.com"}
		with self.assertRaises(frappe.PermissionError):
			shifts.create_opening_shift(json.dumps(data), local_id="local-1")
		self.assertEqual(self.made(), [])

	def test_a_synced_opening_on_the_users_own_profile(self):
		self.user_may_use_profile.return_value = True
		data = {"pos_profile": "Mule City Retail", "company": "Mule City", "user": "pos@mulecity.com"}
		self.assertEqual(shifts.create_opening_shift(json.dumps(data), local_id="local-1"), {"name": "POS-OS-7"})
		made = self.made()[-1]
		self.assertEqual(
			(made["pos_profile"], made["company"], made["user"]),
			("Mule City Retail", "Mule City", "pos@mulecity.com"),
		)
