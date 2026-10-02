# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from xpos.api import shifts


class TestGetOpeningData(unittest.TestCase):
	"""Tests for get_opening_data function."""

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_returns_pos_profiles_for_user(self, mock_frappe):
		"""Test that get_opening_data returns POS profiles assigned to user."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.sql.return_value = [
			{
				"name": "POS-PROFILE-1",
				"company": "Test Company",
				"currency": "USD",
				"warehouse": "Store - TC",
			}
		]
		mock_frappe.get_list.return_value = [
			{"parent": "POS-PROFILE-1", "mode_of_payment": "Cash", "default": 1}
		]

		result = shifts.get_opening_data()

		self.assertIn("pos_profiles", result)
		self.assertIn("companies", result)
		self.assertIn("payment_methods", result)
		self.assertEqual(len(result["pos_profiles"]), 1)
		self.assertEqual(result["pos_profiles"][0]["name"], "POS-PROFILE-1")

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_returns_empty_when_no_profiles(self, mock_frappe):
		"""Test that get_opening_data returns empty lists when user has no profiles."""
		mock_frappe.session.user = "newuser@test.com"
		mock_frappe.db.sql.return_value = []

		result = shifts.get_opening_data()

		self.assertEqual(result["pos_profiles"], [])
		self.assertEqual(result["companies"], [])
		self.assertEqual(result["payment_methods"], [])

	@patch("xpos.api.shifts.frappe")
	def test_get_opening_data_extracts_unique_companies(self, mock_frappe):
		"""Test that companies are deduplicated from multiple profiles."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.sql.return_value = [
			{"name": "POS-PROFILE-1", "company": "Test Company 1", "currency": "USD", "warehouse": "W1"},
			{"name": "POS-PROFILE-2", "company": "Test Company 1", "currency": "USD", "warehouse": "W2"},
			{"name": "POS-PROFILE-3", "company": "Test Company 2", "currency": "EUR", "warehouse": "W3"},
		]
		mock_frappe.get_list.return_value = []

		result = shifts.get_opening_data()

		company_names = [c["name"] for c in result["companies"]]
		self.assertEqual(len(company_names), 2)
		self.assertIn("Test Company 1", company_names)
		self.assertIn("Test Company 2", company_names)


class TestOpenShift(unittest.TestCase):
	"""Tests for open_shift function."""

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_open_shift_creates_new_shift(self, mock_frappe, mock_enrich):
		"""Test that open_shift creates a new POS Opening Shift."""
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-001"}
		mock_frappe.get_doc.return_value = mock_shift_doc
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.open_shift(
			pos_profile="POS-PROFILE-1",
			company="Test Company",
			balance_details='[{"mode_of_payment": "Cash", "opening_amount": 100}]',
		)

		mock_frappe.get_doc.assert_called_once()
		mock_shift_doc.insert.assert_called_once_with(ignore_permissions=True)
		self.assertIn("pos_opening_shift", result)

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_open_shift_handles_empty_balance(self, mock_frappe, mock_enrich):
		"""Test that open_shift works with no balance details."""
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-002"}
		mock_frappe.get_doc.return_value = mock_shift_doc
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.open_shift(
			pos_profile="POS-PROFILE-1",
			company="Test Company",
			balance_details="[]",
		)

		self.assertIn("pos_opening_shift", result)


class TestCheckOpenShift(unittest.TestCase):
	"""Tests for check_open_shift function."""

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_returns_existing_shift(self, mock_frappe, mock_enrich):
		"""Test that check_open_shift returns active shift for user."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.get_all.return_value = [
			{"name": "POS-OPEN-001", "pos_profile": "POS-PROFILE-1", "company": "Test Company"}
		]
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-001"}
		mock_frappe.get_doc.return_value = mock_shift_doc

		result = shifts.check_open_shift()

		self.assertIsNotNone(result)
		self.assertIn("pos_opening_shift", result)

	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_returns_none_when_no_active_shift(self, mock_frappe):
		"""Test that check_open_shift returns None when no active shift."""
		mock_frappe.session.user = "cashier@test.com"
		mock_frappe.db.get_all.return_value = []

		result = shifts.check_open_shift()

		self.assertIsNone(result)

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_check_open_shift_uses_provided_user(self, mock_frappe, mock_enrich):
		"""Test that check_open_shift can check for specific user."""
		mock_frappe.db.get_all.return_value = [
			{"name": "POS-OPEN-003", "pos_profile": "POS-PROFILE-2", "company": "Test Company"}
		]
		mock_shift_doc = MagicMock()
		mock_shift_doc.as_dict.return_value = {"name": "POS-OPEN-003"}
		mock_frappe.get_doc.return_value = mock_shift_doc

		shifts.check_open_shift(user="manager@test.com")

		mock_frappe.db.get_all.assert_called_once()
		call_args = mock_frappe.db.get_all.call_args
		self.assertEqual(call_args.kwargs["filters"]["user"], "manager@test.com")
		self.assertEqual(
			call_args.kwargs["or_filters"],
			[
				{"pos_closing_shift": ["is", "not set"]},
				{"pos_closing_shift": ""},
			],
		)


class MigratedSchemaMixin:
	"""Pretend the tender columns and the change leg table have been migrated.

	Both guards call ``frappe.db`` through ``xpos.api.exchange``, which patching
	``xpos.api.shifts.frappe`` does not reach, so they are replaced by name instead.
	"""

	def setUp(self):
		super().setUp()
		schema = patch.multiple(
			"xpos.api.shifts",
			payment_tender_fields_exist=lambda: True,
			change_leg_table_exists=lambda: True,
		)
		schema.start()
		self.addCleanup(schema.stop)


class TestShiftPaymentTotals(MigratedSchemaMixin, unittest.TestCase):
	"""Per-mode drawer totals, each denominated in that mode's own tender currency."""

	@patch("xpos.api.shifts.frappe")
	def test_tagged_rows_report_their_native_amount(self, mock_frappe):
		"""The canonical receipt: $100 in, $30 + 407,700 LBP out, so the drawer nets +$70."""
		mock_frappe.get_all.side_effect = [
			[
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash USD",
					"amount": 9000000,
					"pos_tender_currency": "USD",
					"pos_tender_amount": 100,
				}
			],
			[
				{"parent": "INV-001", "mode_of_payment": "Cash USD", "currency": "USD", "amount": 30},
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash LBP",
					"currency": "LBP",
					"amount": 407700,
				},
			],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 3107700}],
		)

		self.assertEqual(totals["Cash USD"], {"amount": 70.0, "currency": "USD"})
		self.assertEqual(totals["Cash LBP"], {"amount": -407700.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_untagged_rows_report_the_invoice_currency(self, mock_frappe):
		"""An untagged mode is collected in whatever currency the invoice is denominated in."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Card", "amount": 250}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 0}]
		)

		self.assertEqual(totals["Card"], {"amount": 250.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_change_legs_subtract_from_their_own_mode(self, mock_frappe):
		"""Change comes off the mode that handed it back, not off every mode used."""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Card", "amount": 300},
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 700},
			],
			[{"parent": "INV-001", "mode_of_payment": "Cash", "currency": "LBP", "amount": 100}],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals["Card"]["amount"], 300)
		self.assertEqual(totals["Cash"]["amount"], 600)

	@patch("xpos.api.shifts.frappe")
	def test_legacy_change_comes_off_the_cash_mode_only(self, mock_frappe):
		"""With no legs the whole change leaves the cash drawer, never the card terminal.

		The old pro-ration would have charged the card 30 of this 100.
		"""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Card", "amount": 300},
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 700},
			],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals["Card"]["amount"], 300)
		self.assertEqual(totals["Cash"]["amount"], 600)

	@patch("xpos.api.shifts.frappe")
	def test_single_cash_mode_matches_the_old_proration(self, mock_frappe):
		"""A one-mode invoice is arithmetically unchanged by dropping the pro-ration."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 500}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		# Old formula: 500 - 500 / 500 * 100.
		self.assertEqual(totals["Cash"]["amount"], 400)

	@patch("xpos.api.shifts.frappe")
	def test_legacy_change_falls_back_to_the_only_mode_used(self, mock_frappe):
		"""When the profile's cash mode was not used, a sole payment mode gave the change."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash Drawer", "amount": 500}],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice", [{"name": "INV-001", "currency": "LBP", "change_amount": 100}], "Cash"
		)

		self.assertEqual(totals, {"Cash Drawer": {"amount": 400.0, "currency": "LBP"}})

	@patch("xpos.api.shifts.frappe")
	def test_payment_totals_use_one_query_per_child_table(self, mock_frappe):
		"""Rows are fetched in one query each, not one query per invoice."""
		mock_frappe.get_all.side_effect = [
			[
				{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 100},
				{"parent": "INV-002", "mode_of_payment": "Cash", "amount": 200},
				{"parent": "INV-003", "mode_of_payment": "Card", "amount": 300},
			],
			[],
		]

		totals = shifts.get_shift_payment_totals(
			"Sales Invoice",
			[
				{"name": "INV-001", "currency": "LBP", "change_amount": 0},
				{"name": "INV-002", "currency": "LBP", "change_amount": 0},
				{"name": "INV-003", "currency": "LBP", "change_amount": 0},
			],
		)

		self.assertEqual(mock_frappe.get_all.call_count, 2)
		self.assertEqual(
			totals,
			{
				"Cash": {"amount": 300.0, "currency": "LBP"},
				"Card": {"amount": 300.0, "currency": "LBP"},
			},
		)


class TestShiftExpectedAmounts(MigratedSchemaMixin, unittest.TestCase):
	"""Tests that shift reconciliation figures are derived server-side."""

	@staticmethod
	def _opening(balance_details):
		opening = MagicMock()
		opening.name = "POS-OPEN-001"
		opening.pos_profile = "POS-PROFILE-1"
		opening.balance_details = [
			SimpleNamespace(mode_of_payment=mode, amount=amount, currency=currency)
			for mode, amount, currency in balance_details
		]
		return opening

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_deducts_cash_movements(self, mock_frappe):
		"""Cash taken out of the drawer lowers the expected cash on hand."""
		mock_frappe.get_all.side_effect = [
			[{"parent": "INV-001", "mode_of_payment": "Cash", "amount": 1000}],  # payments
			[],  # POS Change Leg
			[{"amount": 250}, {"amount": 150}],  # POS Cash Movement
			[],  # Payment Entries taken at the till
		]
		mock_frappe.db.get_value.return_value = "Cash"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash", 500, "LBP")]),
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 0}],
		)

		# 500 opening float + 1000 collected - 400 moved out
		self.assertEqual(expected["Cash"], {"amount": 1100.0, "currency": "LBP"})

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_includes_opening_float_for_unused_modes(self, mock_frappe):
		"""A mode with an opening float but no sales still reports that float."""
		mock_frappe.get_all.side_effect = [[], [], []]
		mock_frappe.db.get_value.return_value = "Cash LBP"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash LBP", 1000000, "LBP"), ("Cash USD", 200, "USD")]),
			"Sales Invoice",
			[],
		)

		self.assertEqual(
			expected,
			{
				"Cash LBP": {"amount": 1000000.0, "currency": "LBP"},
				"Cash USD": {"amount": 200.0, "currency": "USD"},
			},
		)

	@patch("xpos.api.shifts.frappe")
	def test_expected_amount_keeps_each_mode_in_its_own_currency(self, mock_frappe):
		"""The count sheet asks for $70 and -407,700 LBP separately, never a blended figure."""
		mock_frappe.get_all.side_effect = [
			[
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash USD",
					"amount": 9000000,
					"pos_tender_currency": "USD",
					"pos_tender_amount": 100,
				}
			],
			[
				{"parent": "INV-001", "mode_of_payment": "Cash USD", "currency": "USD", "amount": 30},
				{
					"parent": "INV-001",
					"mode_of_payment": "Cash LBP",
					"currency": "LBP",
					"amount": 407700,
				},
			],
			[],
			[],
		]
		mock_frappe.db.get_value.return_value = "Cash LBP"

		expected = shifts.get_shift_expected_amounts(
			self._opening([("Cash LBP", 1000000, "LBP"), ("Cash USD", 200, "USD")]),
			"Sales Invoice",
			[{"name": "INV-001", "currency": "LBP", "change_amount": 3107700}],
		)

		self.assertEqual(expected["Cash USD"], {"amount": 270.0, "currency": "USD"})
		self.assertEqual(expected["Cash LBP"], {"amount": 592300.0, "currency": "LBP"})


class TestCloseShift(unittest.TestCase):
	"""Tests for close_shift function."""

	@patch(
		"xpos.api.shifts.get_shift_expected_amounts",
		return_value={"Cash": {"amount": 400, "currency": "LBP"}},
	)
	@patch("xpos.api.shifts.frappe")
	def test_close_shift_ignores_client_supplied_expected_amount(self, mock_frappe, mock_expected):
		"""A client-sent expected_amount must not be able to mask a cash shortfall."""
		opening = MagicMock()
		opening.name = "POS-OPEN-001"
		opening.pos_profile = "POS-PROFILE-1"
		opening.company = "Test Company"
		opening.posting_date = "2026-01-15"
		opening.period_start_date = "2026-01-15 09:00:00"
		opening.user = "cashier@test.com"
		opening.balance_details = [SimpleNamespace(mode_of_payment="Cash", amount=100)]

		closing = MagicMock()
		closing.name = "POS-CLOSE-001"
		closing.as_dict.return_value = {"name": "POS-CLOSE-001"}
		appended = []
		closing.append.side_effect = lambda table, row: appended.append((table, row))

		mock_frappe.get_doc.side_effect = lambda *a, **kw: (
			opening if a and a[0] == "POS Opening Shift" else closing
		)
		mock_frappe.get_all.return_value = []
		mock_frappe.session.user = "cashier@test.com"

		shifts.close_shift(
			opening_shift="POS-OPEN-001",
			# Cashier claims 300 was expected and 300 counted, i.e. no variance.
			closing_details='[{"mode_of_payment": "Cash", "opening_amount": 999, '
			'"expected_amount": 300, "closing_amount": 300, "difference": 0}]',
		)

		rows = [row for table, row in appended if table == "payment_reconciliation"]
		self.assertEqual(len(rows), 1)
		# Server figure wins, exposing the 100 shortfall the client tried to hide.
		self.assertEqual(rows[0]["expected_amount"], 400)
		self.assertEqual(rows[0]["closing_amount"], 300)
		self.assertEqual(rows[0]["difference"], -100)
		self.assertEqual(rows[0]["opening_amount"], 100)
		self.assertEqual(rows[0]["currency"], "LBP")

	@patch("xpos.api.shifts.frappe")
	def test_close_shift_creates_closing_shift(self, mock_frappe):
		"""Test that close_shift creates POS Closing Shift."""
		# Setup mocks
		mock_opening_doc = MagicMock()
		mock_opening_doc.name = "POS-OPEN-001"
		mock_opening_doc.pos_profile = "POS-PROFILE-1"
		mock_opening_doc.company = "Test Company"
		mock_opening_doc.posting_date = "2026-01-15"
		mock_opening_doc.period_start_date = "2026-01-15 09:00:00"
		mock_opening_doc.user = "cashier@test.com"

		mock_closing_doc = MagicMock()
		mock_closing_doc.name = "POS-CLOSE-001"
		mock_closing_doc.as_dict.return_value = {"name": "POS-CLOSE-001"}

		def get_doc_side_effect(*args, **kwargs):
			if args[0] == "POS Opening Shift":
				return mock_opening_doc
			return mock_closing_doc

		mock_frappe.get_doc.side_effect = get_doc_side_effect
		mock_frappe.get_all.return_value = [
			{
				"name": "INV-001",
				"grand_total": 500,
				"net_total": 450,
				"total_taxes_and_charges": 50,
				"customer": "C1",
				"is_return": 0,
			}
		]
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.close_shift(
			opening_shift="POS-OPEN-001",
			closing_details='[{"mode_of_payment": "Cash", "expected_amount": 500, "closing_amount": 500}]',
		)

		self.assertIn("pos_closing_shift", result)

	@patch("xpos.api.shifts.frappe")
	def test_close_shift_handles_no_invoices(self, mock_frappe):
		"""Test that close_shift works when no invoices in shift."""
		mock_opening_doc = MagicMock()
		mock_opening_doc.name = "POS-OPEN-002"
		mock_opening_doc.pos_profile = "POS-PROFILE-1"
		mock_opening_doc.company = "Test Company"
		mock_opening_doc.posting_date = "2026-01-15"
		mock_opening_doc.period_start_date = "2026-01-15 09:00:00"
		mock_opening_doc.user = "cashier@test.com"

		mock_closing_doc = MagicMock()
		mock_closing_doc.name = "POS-CLOSE-002"
		mock_closing_doc.as_dict.return_value = {"name": "POS-CLOSE-002"}

		def get_doc_side_effect(*args, **kwargs):
			if args[0] == "POS Opening Shift":
				return mock_opening_doc
			return mock_closing_doc

		mock_frappe.get_doc.side_effect = get_doc_side_effect
		mock_frappe.get_all.return_value = []  # No invoices
		mock_frappe.session.user = "cashier@test.com"

		result = shifts.close_shift(
			opening_shift="POS-OPEN-002",
			closing_details="[]",
		)

		self.assertIn("pos_closing_shift", result)


def _matches(row: dict, filters: dict) -> bool:
	"""Evaluate the small subset of Frappe filters the shift queries use against a dict row."""
	for field, condition in filters.items():
		value = row.get(field)
		if not isinstance(condition, list):
			if value != condition:
				return False
			continue
		operator, operand = condition
		if operator == "is" and operand == "not set":
			if value not in (None, ""):
				return False
		elif operator == ">=":
			if value is None or value < operand:
				return False
		elif operator == "in":
			if value not in operand:
				return False
		else:
			raise AssertionError(f"unsupported filter {field}: {condition}")
	return True


class TestSecondShiftOnTheSameDay(unittest.TestCase):
	"""User story (MuleCity-oygn): Leslie closes her morning shift, opens a second shift on the
	same till and rings nothing. Close Shift for the second shift must show 0 invoices and 0.00,
	not the three invoices already counted in the first shift's closing."""

	# Three invoices from the first shift: linked to it and already in its closing.
	FIRST_SHIFT_INVOICES = tuple(
		{
			"name": f"ACC-SINV-2026-3825{n}",
			"docstatus": 1,
			"is_pos": 1,
			"pos_profile": "Mule City Retail",
			"owner": "leslie@mulecity.com",
			"posting_date": "2026-09-27",
			"creation": f"2026-09-27 10:0{n}:00",
			"pos_opening_shift": "POS-OS-26-0000003",
			"pos_closing_entry": "POS-CS-26-0000001",
			"grand_total": 14.94,
			"net_total": 14.0,
			"currency": "USD",
			"is_return": 0,
		}
		for n in (8, 9, 1)
	)

	def _second_shift(self):
		opening = MagicMock()
		opening.name = "POS-OS-26-0000004"
		opening.pos_profile = "Mule City Retail"
		opening.company = "Mule City Specialty Feeds"
		opening.posting_date = "2026-09-27"
		opening.period_start_date = "2026-09-27 11:00:00"
		opening.user = "leslie@mulecity.com"
		opening.balance_details = [SimpleNamespace(mode_of_payment="Cash", amount=150)]
		return opening

	def _fake_get_all(self, invoices):
		def get_all(doctype, filters=None, fields=None, **kwargs):
			if doctype in ("Sales Invoice", "POS Invoice"):
				return [row for row in invoices if _matches(row, filters or {})]
			return []

		return get_all

	@patch("xpos.api.shifts.get_shift_payment_totals", return_value={})
	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_empty_second_shift_summary_counts_no_invoices(self, mock_frappe, _doctype, _totals):
		"""The Close Shift sheet of an empty second shift shows no invoices and no sales."""
		mock_frappe.get_doc.return_value = self._second_shift()
		mock_frappe.get_all.side_effect = self._fake_get_all(self.FIRST_SHIFT_INVOICES)
		mock_frappe.db.has_column.return_value = True
		mock_frappe.db.get_value.return_value = "Cash"

		summary = shifts.get_shift_summary("POS-OS-26-0000004")

		self.assertEqual(summary["total_invoices"], 0)
		self.assertEqual(summary["grand_total"], 0)
		self.assertEqual(summary["invoices"], [])
		# Only the opening float is expected in the drawer.
		self.assertEqual(summary["expected_amounts"]["Cash"]["amount"], 150)

	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_empty_second_shift_closing_links_no_invoices(self, mock_frappe, _doctype):
		"""Closing the empty second shift saves no pos_transactions from the first shift."""
		closing = MagicMock()
		closing.name = "POS-CS-26-0000002"
		appended = []
		closing.append.side_effect = lambda table, row: appended.append((table, row))
		opening = self._second_shift()
		mock_frappe.get_doc.side_effect = lambda *a, **kw: (
			opening if a and a[0] == "POS Opening Shift" else closing
		)
		mock_frappe.get_all.side_effect = self._fake_get_all(self.FIRST_SHIFT_INVOICES)
		mock_frappe.db.has_column.return_value = True
		mock_frappe.session.user = "leslie@mulecity.com"

		result = shifts.close_shift(opening_shift="POS-OS-26-0000004", closing_details="[]")

		self.assertEqual(result["total_invoices"], 0)
		self.assertEqual(result["grand_total"], 0)
		self.assertEqual([row for table, row in appended if table == "pos_transactions"], [])

	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_unlinked_invoice_after_the_shift_opened_is_still_counted(self, mock_frappe, _doctype):
		"""Negative guard: an unlinked, unclosed invoice rung in this shift is still picked up."""
		unlinked = {
			**self.FIRST_SHIFT_INVOICES[0],
			"name": "ACC-SINV-2026-38300",
			"creation": "2026-09-27 11:05:00",
			"pos_opening_shift": None,
			"pos_closing_entry": None,
		}
		mock_frappe.get_all.side_effect = self._fake_get_all([*self.FIRST_SHIFT_INVOICES, unlinked])
		mock_frappe.db.has_column.return_value = True

		invoices = shifts._get_shift_invoices(self._second_shift(), "Sales Invoice", ["name"])

		self.assertEqual([row["name"] for row in invoices], ["ACC-SINV-2026-38300"])

	@patch("xpos.api.shifts.frappe")
	def test_linked_invoices_are_the_shift_invoices(self, mock_frappe):
		"""A shift with linked invoices returns exactly those, without the fallback."""
		opening = self._second_shift()
		opening.name = "POS-OS-26-0000003"
		mock_frappe.get_all.side_effect = self._fake_get_all(self.FIRST_SHIFT_INVOICES)
		mock_frappe.db.has_column.return_value = True

		invoices = shifts._get_shift_invoices(opening, "Sales Invoice", ["name"])

		self.assertEqual(len(invoices), 3)
		self.assertEqual(mock_frappe.get_all.call_count, 1)


class TestCloseSheetByCashier(unittest.TestCase):
	"""User story (Bill 2026-10-01, MuleCity-qajl.6): the shared counter login rings sales
	and returns under typed initials. The Close Shift sheet shows each cashier's sales and
	returns (count and total), and a "(none)" row for invoices saved without initials."""

	INVOICES = (
		{"name": "SINV-1", "grand_total": 21.35, "net_total": 20, "is_return": 0, "pos_cashier": "LE"},
		{"name": "SINV-2", "grand_total": 10.0, "net_total": 10, "is_return": 0, "pos_cashier": "BI"},
		{"name": "SINV-3", "grand_total": 5.0, "net_total": 5, "is_return": 0, "pos_cashier": "LE"},
		{"name": "SINV-4", "grand_total": -5.0, "net_total": -5, "is_return": 1, "pos_cashier": "LE"},
		{"name": "SINV-5", "grand_total": 7.5, "net_total": 7.5, "is_return": 0, "pos_cashier": None},
		{"name": "SINV-6", "grand_total": -1.07, "net_total": -1, "is_return": 1, "pos_cashier": ""},
	)

	def test_summary_reads_pos_cashier(self):
		self.assertIn("pos_cashier", shifts.SUMMARY_INVOICE_FIELDS)

	@patch("xpos.api.shifts.get_shift_till_payments", return_value=[])
	@patch("xpos.api.shifts._get_shift_tax_summary", return_value=[])
	@patch("xpos.api.shifts.get_shift_expected_amounts", return_value={})
	@patch("xpos.api.shifts.get_shift_payment_totals", return_value={})
	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_each_cashier_has_a_row_and_untagged_invoices_are_none(self, mock_frappe, *_):
		opening = MagicMock()
		opening.name = "POS-OS-26-0000002"
		opening.balance_details = []
		mock_frappe.get_doc.return_value = opening
		mock_frappe.get_all.return_value = [dict(row) for row in self.INVOICES]
		mock_frappe.db.get_value.return_value = "Cash"

		summary = shifts.get_shift_summary("POS-OS-26-0000002")

		self.assertEqual(
			summary["by_cashier"],
			[
				{"cashier": "BI", "sales_count": 1, "sales_total": 10.0, "returns_count": 0, "returns_total": 0.0,
				 "payments_count": 0, "payments_total": 0.0},
				{"cashier": "LE", "sales_count": 2, "sales_total": 26.35, "returns_count": 1, "returns_total": -5.0,
				 "payments_count": 0, "payments_total": 0.0},
				{"cashier": "(none)", "sales_count": 1, "sales_total": 7.5, "returns_count": 1, "returns_total": -1.07,
				 "payments_count": 0, "payments_total": 0.0},
			],
		)
		self.assertEqual(summary["returns_count"], 2)

	def test_an_empty_shift_has_no_rows(self):
		self.assertEqual(shifts.shift_totals_by_cashier([]), [])


class TestCloseTaxBreakdown(unittest.TestCase):
	"""User story (50i proof 2026-10-02, MuleCity-uimf): a shift with taxed and
	tax-exempt sales listed "NC Sales Tax Payable" twice on the close, once at
	0.00 from the 0% exempt/resale template rows. The close shows each tax
	account once, with what it collected."""

	ACCOUNT = "NC Sales Tax Payable - MCSF"

	@patch("xpos.api.shifts.frappe")
	def test_a_zero_rate_row_on_the_same_account_is_not_listed(self, mock_frappe):
		mock_frappe.get_all.return_value = [
			{"account_head": self.ACCOUNT, "rate": 0.0, "amount": 0.0},
			{"account_head": self.ACCOUNT, "rate": 6.75, "amount": 0.62},
		]
		summary = shifts._get_shift_tax_summary([{"name": "SINV-1"}, {"name": "SINV-2"}])
		self.assertEqual(summary, [{"account_head": self.ACCOUNT, "rate": 6.75, "amount": 0.62}])

	@patch("xpos.api.shifts.frappe")
	def test_negative_a_returned_tax_still_shows(self, mock_frappe):
		"""Only rows totalling nothing go: a shift of returns shows its negative tax."""
		mock_frappe.get_all.return_value = [{"account_head": self.ACCOUNT, "rate": 6.75, "amount": -0.07}]
		summary = shifts._get_shift_tax_summary([{"name": "SINV-RET-1"}])
		self.assertEqual(summary, [{"account_head": self.ACCOUNT, "rate": 6.75, "amount": -0.07}])


class TestTillPaymentsInTheShift(unittest.TestCase):
	"""User story (MuleCity-49ue, mc24 walk 2026-10-02): Leslie (LE on the shared counter login)
	takes $40 cash for a custom mix order paid now. That is an advance Payment Entry, not an
	invoice payment row, and the drawer is $40 over unless the close counts it. The Payment
	Entry carries the shift in ``reference_no`` (the desk closing's tag); the close sheet adds
	it to expected cash, lists it under "Payments received" and under LE, and the saved closing
	lists it in ``pos_payments``. The pickup invoice that later uses the advance has no cash
	row for it, so a later shift never counts that $40 again."""

	SHIFT = "POS-OS-26-0000009"
	ENTRIES = (
		{"name": "ACC-PAY-05006", "payment_type": "Receive", "mode_of_payment": "Cash",
		 "paid_amount": 40, "received_amount": 40, "paid_from_account_currency": "USD",
		 "paid_to_account_currency": "USD", "party": "Steve", "posting_date": "2026-10-02",
		 "pos_cashier": "LE"},
		{"name": "ACC-PAY-05007", "payment_type": "Receive", "mode_of_payment": "Card",
		 "paid_amount": 12.5, "received_amount": 12.5, "paid_from_account_currency": "USD",
		 "paid_to_account_currency": "USD", "party": "Ada", "posting_date": "2026-10-02",
		 "pos_cashier": None},
		{"name": "ACC-PAY-05008", "payment_type": "Pay", "mode_of_payment": "Cash",
		 "paid_amount": 5, "received_amount": 5, "paid_from_account_currency": "USD",
		 "paid_to_account_currency": "USD", "party": "Steve", "posting_date": "2026-10-02",
		 "pos_cashier": "LE"},
	)

	def _opening(self):
		opening = MagicMock()
		opening.name = self.SHIFT
		opening.pos_profile = "Mule City Retail"
		opening.company = "Mule City Specialty Feeds"
		opening.posting_date = "2026-10-02"
		opening.period_start_date = "2026-10-02 07:00:00"
		opening.user = "pos@mulecity.com"
		opening.balance_details = [SimpleNamespace(mode_of_payment="Cash", amount=150, currency="USD")]
		return opening

	def _fake_get_all(self, invoices=(), payment_rows=(), entries=None):
		entries = self.ENTRIES if entries is None else entries
		calls = []

		def get_all(doctype, filters=None, fields=None, **kwargs):
			calls.append((doctype, filters))
			if doctype == "Payment Entry":
				return [dict(row) for row in entries if row["payment_type"] in filters["payment_type"][1]
					and filters["reference_no"] == self.SHIFT]
			if doctype in ("Sales Invoice", "POS Invoice"):
				return [dict(row) for row in invoices]
			if doctype == "Sales Invoice Payment":
				return [dict(row) for row in payment_rows]
			return []

		get_all.calls = calls
		return get_all

	@patch("xpos.api.shifts.frappe")
	def test_till_payments_are_read_by_the_shift_tag_and_signed(self, mock_frappe):
		mock_frappe.get_all.side_effect = fake = self._fake_get_all()
		payments = shifts.get_shift_till_payments(self.SHIFT)
		(doctype, filters), = fake.calls
		self.assertEqual(doctype, "Payment Entry")
		self.assertEqual(filters, {"docstatus": 1, "reference_no": self.SHIFT,
			"payment_type": ["in", ["Receive", "Pay"]]})
		self.assertEqual([(p["name"], p["mode_of_payment"], p["amount"], p["pos_cashier"]) for p in payments], [
			("ACC-PAY-05006", "Cash", 40.0, "LE"),
			("ACC-PAY-05007", "Card", 12.5, None),
			("ACC-PAY-05008", "Cash", -5.0, "LE"),
		])
		self.assertEqual(shifts.till_payments_by_mode(payments), {
			"Cash": {"count": 2, "amount": 35.0, "currency": "USD"},
			"Card": {"count": 1, "amount": 12.5, "currency": "USD"},
		})

	@patch("xpos.api.shifts.frappe")
	def test_negative_no_shift_reads_nothing(self, mock_frappe):
		self.assertEqual(shifts.get_shift_till_payments(""), [])
		mock_frappe.get_all.assert_not_called()

	@patch("xpos.api.shifts.payment_tender_fields_exist", return_value=False)
	@patch("xpos.api.shifts.change_leg_table_exists", return_value=False)
	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_summary_expects_the_prepaid_cash_and_shows_it(self, mock_frappe, *_):
		"""$150 float + $10.37 ticket + $40 prepaid - $5 paid out = $195.37 cash; $12.50 card."""
		mock_frappe.get_doc.return_value = self._opening()
		mock_frappe.db.get_value.return_value = "Cash"
		mock_frappe.get_all.side_effect = self._fake_get_all(
			invoices=[{"name": "SINV-1", "currency": "USD", "grand_total": 10.37, "net_total": 10.37,
				"change_amount": 0, "is_return": 0, "pos_cashier": "BI"}],
			payment_rows=[{"parent": "SINV-1", "mode_of_payment": "Cash", "amount": 10.37}],
		)

		summary = shifts.get_shift_summary(self.SHIFT)

		self.assertEqual(round(summary["expected_amounts"]["Cash"]["amount"], 2), 195.37)
		self.assertEqual(summary["expected_amounts"]["Card"], {"amount": 12.5, "currency": "USD"})
		# The invoice legs alone, as before: what the tickets collected.
		self.assertEqual(summary["payment_summary"], {"Cash": {"amount": 10.37, "currency": "USD"}})
		self.assertEqual(summary["till_payments"]["Cash"], {"count": 2, "amount": 35.0, "currency": "USD"})
		self.assertEqual(
			[(r["cashier"], r["sales_count"], r["payments_count"], r["payments_total"]) for r in summary["by_cashier"]],
			[("BI", 1, 0, 0.0), ("LE", 0, 2, 35.0), ("(none)", 0, 1, 12.5)],
		)

	@patch("xpos.api.shifts.payment_tender_fields_exist", return_value=False)
	@patch("xpos.api.shifts.change_leg_table_exists", return_value=False)
	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_negative_a_pickup_using_the_advance_adds_no_cash(self, mock_frappe, *_):
		"""Friday's shift: the pickup ticket ($40, all paid by Tuesday's advance) has a $0 cash
		row and no Payment Entry tagged with Friday's shift, so only the float is expected."""
		mock_frappe.get_doc.return_value = self._opening()
		mock_frappe.db.get_value.return_value = "Cash"
		mock_frappe.get_all.side_effect = self._fake_get_all(
			invoices=[{"name": "SINV-2", "currency": "USD", "grand_total": 40, "net_total": 40,
				"change_amount": 0, "is_return": 0, "pos_cashier": "LE"}],
			payment_rows=[{"parent": "SINV-2", "mode_of_payment": "Cash", "amount": 0}],
			entries=(),
		)

		summary = shifts.get_shift_summary(self.SHIFT)

		self.assertEqual(summary["expected_amounts"]["Cash"]["amount"], 150)
		self.assertEqual(summary["till_payments"], {})

	@patch("xpos.api.shifts.can_close_shift", return_value=True)
	@patch("xpos.api.shifts.payment_tender_fields_exist", return_value=False)
	@patch("xpos.api.shifts.change_leg_table_exists", return_value=False)
	@patch("xpos.api.shifts.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.shifts.frappe")
	def test_the_saved_closing_expects_and_lists_the_till_payments(self, mock_frappe, *_):
		closing = MagicMock()
		closing.name = "POS-CS-26-0000009"
		appended = []
		closing.append.side_effect = lambda table, row: appended.append((table, row))
		opening = self._opening()
		mock_frappe.get_doc.side_effect = lambda *a, **kw: opening if a and a[0] == "POS Opening Shift" else closing
		mock_frappe.db.get_value.return_value = "Cash"
		mock_frappe.get_all.side_effect = self._fake_get_all()
		mock_frappe.session.user = "pos@mulecity.com"

		shifts.close_shift(self.SHIFT, '[{"mode_of_payment": "Cash", "closing_amount": 185}]')

		(cash,) = [row for table, row in appended if table == "payment_reconciliation"]
		self.assertEqual((cash["expected_amount"], cash["difference"]), (185.0, 0))
		self.assertEqual(
			[(row["payment_entry"], row["paid_amount"], row["customer"]) for table, row in appended
				if table == "pos_payments"],
			[("ACC-PAY-05006", 40.0, "Steve"), ("ACC-PAY-05007", 12.5, "Ada"), ("ACC-PAY-05008", -5.0, "Steve")],
		)


class TestOpeningFloat(unittest.TestCase):
	"""User story (MuleCity-88ck): Leslie types 150 in the Cash box under Opening Cash Balance
	and clicks Open Shift. The shift keeps Cash = 150 so Close Shift expects float + sales."""

	@patch("xpos.api.shifts._enrich_shift_data")
	@patch("xpos.api.shifts.frappe")
	def test_open_shift_keeps_the_typed_cash_float(self, mock_frappe, _enrich):
		shift = MagicMock()
		appended = []
		shift.append.side_effect = lambda table, row: appended.append((table, row))
		shift.as_dict.return_value = {"name": "POS-OS-26-0000004"}
		mock_frappe.get_doc.return_value = shift
		mock_frappe.session.user = "leslie@mulecity.com"

		shifts.open_shift(
			pos_profile="Mule City Retail",
			company="Mule City Specialty Feeds",
			balance_details='[{"mode_of_payment": "Cash", "opening_amount": 150}, '
			'{"mode_of_payment": "Credit Card", "opening_amount": 0}]',
		)

		self.assertEqual(
			appended,
			[
				("balance_details", {"mode_of_payment": "Cash", "amount": 150.0}),
				("balance_details", {"mode_of_payment": "Credit Card", "amount": 0.0}),
			],
		)
		shift.set.assert_not_called()

	@patch("xpos.api.shifts.frappe")
	def test_opening_data_lists_methods_in_pos_profile_order(self, mock_frappe):
		"""Cash (row 1 of the POS Profile payments table) is listed before Credit Card."""
		mock_frappe.session.user = "leslie@mulecity.com"
		mock_frappe.db.sql.return_value = [{"name": "Mule City Retail", "company": "MCSF"}]
		mock_frappe.get_list.return_value = []

		shifts.get_opening_data()

		self.assertEqual(mock_frappe.get_list.call_args.kwargs["order_by"], "parent asc, idx asc")


class TestShiftAmountCalculations(unittest.TestCase):
	"""Tests for shift amount calculation helpers."""

	def test_total_calculation_with_returns(self):
		"""Test that return invoices are properly calculated."""
		invoices = [
			{"grand_total": 100, "is_return": 0},
			{"grand_total": 200, "is_return": 0},
			{"grand_total": -50, "is_return": 1},  # Return
		]

		from frappe.utils import flt

		grand_total = sum(flt(inv["grand_total"]) for inv in invoices)
		returns_count = sum(1 for inv in invoices if inv.get("is_return"))

		self.assertEqual(grand_total, 250)  # 100 + 200 - 50
		self.assertEqual(returns_count, 1)


if __name__ == "__main__":
	unittest.main()
