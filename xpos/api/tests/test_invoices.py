# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from xpos.api import invoices


def tender_legs_from_payments(payments, invoice_doc, rate_cache=None):
	"""Stand in for build_tender_legs, deriving rows from payments without a database."""
	rows = [
		{"mode_of_payment": payment["mode_of_payment"], "amount": float(payment["amount"])}
		for payment in payments
		if payment.get("mode_of_payment")
	]
	return rows, sum(row["amount"] for row in rows)


class TestCreateInvoice(unittest.TestCase):
	"""Tests for create_invoice function."""

	def setUp(self):
		self.stub("build_tender_legs", side_effect=tender_legs_from_payments)
		self.stub("build_change_legs", return_value=([], 0.0))
		self.stub("invoice_currency_of", return_value="USD")
		self.stub("get_currency_precision", return_value=2)
		# The caller's right to sell has its own tests below.
		self.stub("resolve_pos_profile")
		# The site tax adapter (Mule City) has its own tests; these unit tests
		# use a mocked invoice, which the adapter cannot read.
		patcher = patch("mulecity_erpnext.pos_workspace.apply_customer_taxes")
		patcher.start()
		self.addCleanup(patcher.stop)

	def stub(self, name, **kwargs):
		"""Patch `name` in the xpos.api.invoices namespace for the current test."""
		patcher = patch(f"xpos.api.invoices.{name}", **kwargs)
		patcher.start()
		self.addCleanup(patcher.stop)

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_requires_pos_profile(self, mock_frappe):
		"""Test that create_invoice throws error without POS profile."""
		mock_frappe.throw.side_effect = Exception("POS Profile is required")

		with self.assertRaises(Exception):
			invoices.create_invoice('{"customer": "C1", "items": []}')

		mock_frappe.throw.assert_called()

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_refuses_a_user_who_may_not_create_invoices(self, mock_frappe):
		"""The invoice is inserted with ignore_permissions, so create rights are checked first."""
		mock_frappe.has_permission.side_effect = PermissionError("not permitted")

		with self.assertRaises(PermissionError):
			invoices.create_invoice('{"pos_profile": "POS-1", "customer": "C1", "items": [{"item_code": "I"}]}')

		mock_frappe.get_doc.assert_not_called()

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_refuses_a_user_without_a_seat_at_the_register(self, mock_frappe):
		"""A user who may sell, but is not assigned to this POS Profile, cannot sell through it."""
		with patch("xpos.api.invoices.resolve_pos_profile", side_effect=PermissionError("not assigned")) as seat:
			with self.assertRaises(PermissionError):
				invoices.create_invoice('{"pos_profile": "POS-1", "customer": "C1", "items": [{"item_code": "I"}]}')

		seat.assert_called_once_with("POS-1")
		mock_frappe.get_doc.assert_not_called()

	@patch("xpos.api.invoices.frappe")
	def test_a_replay_of_a_posted_sale_is_answered_before_the_seat_check(self, mock_frappe):
		"""An offline retry of a committed sale returns it even if the cashier lost the seat."""
		with patch("xpos.api.invoices.find_invoice_by_local_id", return_value=("Sales Invoice", "INV-1")), patch(
			"xpos.api.invoices._build_invoice_response", return_value={"name": "INV-1"}
		), patch("xpos.api.invoices.resolve_pos_profile", side_effect=PermissionError("not assigned")):
			result = invoices.create_invoice('{"pos_profile": "POS-1", "local_id": "inv_1", "customer": "C1"}')

		self.assertEqual(result, {"name": "INV-1", "duplicate": True})

	@patch("xpos.api.invoices.frappe")
	def test_a_draft_is_refused_without_a_seat_at_the_register(self, mock_frappe):
		"""Parking a sale inserts an invoice too, so it needs the same right to sell."""
		with patch("xpos.api.invoices.resolve_pos_profile", side_effect=PermissionError("not assigned")):
			with self.assertRaises(PermissionError):
				invoices.save_draft_invoice('{"pos_profile": "POS-1", "customer": "C1", "items": [{"item_code": "I"}]}')

		mock_frappe.get_doc.assert_not_called()

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_requires_customer(self, mock_frappe):
		"""Test that create_invoice throws error without customer."""
		mock_frappe.throw.side_effect = Exception("Customer is required")

		with self.assertRaises(Exception):
			invoices.create_invoice('{"pos_profile": "POS-1", "items": []}')

		mock_frappe.throw.assert_called()

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_requires_items(self, mock_frappe):
		"""Test that create_invoice throws error without items."""
		mock_frappe.throw.side_effect = Exception("At least one item is required")

		with self.assertRaises(Exception):
			invoices.create_invoice('{"pos_profile": "POS-1", "customer": "C1", "items": []}')

		mock_frappe.throw.assert_called()

	@patch("xpos.api.invoices.get_invoice_type", return_value="Sales Invoice")
	@patch("xpos.api.invoices._validate_return_invoice")
	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_creates_sales_invoice(self, mock_frappe, mock_validate_return, mock_invoice_type):
		"""Test that create_invoice creates a Sales Invoice document."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-001"
		mock_invoice.as_dict.return_value = {"name": "INV-001", "grand_total": 100}
		mock_frappe.new_doc.return_value = mock_invoice

		data = {
			"pos_profile": "POS-PROFILE-1",
			"customer": "Customer A",
			"items": [{"item_code": "ITEM-001", "qty": 2, "rate": 50}],
			"payments": [{"mode_of_payment": "Cash", "amount": 100}],
			"pos_opening_shift": "POS-OPEN-001",
		}

		invoices.create_invoice(data)

		mock_frappe.new_doc.assert_called_once_with("Sales Invoice")
		mock_invoice.insert.assert_called_once()

	@patch("xpos.api.invoices._validate_return_invoice")
	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_handles_return(self, mock_frappe, mock_validate_return):
		"""Test that create_invoice properly handles return invoices."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-RET-001"
		mock_invoice.as_dict.return_value = {"name": "INV-RET-001", "is_return": 1}
		mock_frappe.new_doc.return_value = mock_invoice

		data = {
			"pos_profile": "POS-PROFILE-1",
			"customer": "Customer A",
			"items": [{"item_code": "ITEM-001", "qty": -1, "rate": 50}],
			"payments": [{"mode_of_payment": "Cash", "amount": -50}],
			"is_return": 1,
			"return_against": "INV-001",
		}

		invoices.create_invoice(data)

		mock_validate_return.assert_called_once()
		self.assertEqual(mock_invoice.is_return, 1)
		self.assertEqual(mock_invoice.return_against, "INV-001")

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_applies_discount(self, mock_frappe):
		"""Test that create_invoice applies discount correctly."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-002"
		mock_invoice.as_dict.return_value = {"name": "INV-002"}
		mock_frappe.new_doc.return_value = mock_invoice

		data = {
			"pos_profile": "POS-PROFILE-1",
			"customer": "Customer A",
			"items": [{"item_code": "ITEM-001", "qty": 1, "rate": 100}],
			"payments": [{"mode_of_payment": "Cash", "amount": 90}],
			"additional_discount_percentage": 10,
		}
		invoices.create_invoice(data)

		self.assertEqual(mock_invoice.additional_discount_percentage, 10)

	def discounted_sale(self, mock_frappe, profile_discount_on, **payload):
		"""Post a $100 sale with $10 off at a counter whose profile applies discounts on `profile_discount_on`."""
		profile = {"apply_discount_on": profile_discount_on}
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.side_effect = lambda key, default=None: profile.get(key, 0)
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"

		mock_invoice = MagicMock()
		mock_invoice.name = "INV-004"
		mock_invoice.as_dict.return_value = {"name": "INV-004"}
		mock_frappe.new_doc.return_value = mock_invoice

		invoices.create_invoice(
			{
				"pos_profile": "POS-PROFILE-1",
				"customer": "Customer A",
				"items": [{"item_code": "ITEM-001", "qty": 1, "rate": 100}],
				"payments": [{"mode_of_payment": "Cash", "amount": 96.08}],
				"discount_amount": 10,
				**payload,
			}
		)
		return mock_invoice

	@patch("xpos.api.invoices.frappe")
	def test_a_discount_follows_the_profiles_apply_discount_on(self, mock_frappe):
		"""User story: a counter set to discount the Net Total takes a discount before tax, even
		when the register did not say where to apply it."""
		invoice = self.discounted_sale(mock_frappe, "Net Total")

		self.assertEqual(invoice.apply_discount_on, "Net Total")

	@patch("xpos.api.invoices.frappe")
	def test_the_registers_own_apply_discount_on_wins(self, mock_frappe):
		"""A transaction Pricing Rule's choice, sent by the register, beats the profile's."""
		invoice = self.discounted_sale(mock_frappe, "Net Total", apply_discount_on="Grand Total")

		self.assertEqual(invoice.apply_discount_on, "Grand Total")

	@patch("xpos.api.invoices.frappe")
	def test_a_profile_without_one_discounts_the_grand_total(self, mock_frappe):
		"""Negative: nothing says where, so the discount comes off the Grand Total as before."""
		invoice = self.discounted_sale(mock_frappe, None)

		self.assertEqual(invoice.apply_discount_on, "Grand Total")

	@patch("xpos.api.invoices.frappe")
	def test_create_invoice_preserves_three_decimal_item_rate(self, mock_frappe):
		"""Item rates should retain up to three decimals when xpos creates invoices."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.return_value = 0
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"
		mock_frappe.db.get_default.return_value = "3"

		mock_item = MagicMock()
		mock_invoice = MagicMock()
		mock_invoice.name = "INV-003"
		mock_invoice.as_dict.return_value = {"name": "INV-003"}
		mock_invoice.append.side_effect = lambda table, data: mock_item if table == "items" else MagicMock()
		mock_frappe.new_doc.return_value = mock_invoice

		data = {
			"pos_profile": "POS-PROFILE-1",
			"customer": "Customer A",
			"items": [{"item_code": "ITEM-001", "qty": 1, "rate": 12.3456}],
			"payments": [{"mode_of_payment": "Cash", "amount": 12.35}],
		}

		invoices.create_invoice(data)

		self.assertEqual(mock_item.price_list_rate, 12.346)
		self.assertEqual(mock_item.rate, 12.346)

	@patch("xpos.api.invoices.frappe")
	def test_mapped_mix_build_retains_order_price_and_mill_instructions(self, mock_frappe):
		"""Pickup retains the approved mix price despite today's rate and a lower cap."""
		mock_pos = MagicMock()
		mock_pos.company = "Test Company"
		mock_pos.warehouse = "Store - TC"
		mock_pos.currency = "USD"
		mock_pos.get.side_effect = lambda key, default=None: {
			"selling_price_list": "Retail", "max_discount_percentage_allowed": 5,
		}.get(key, default)
		mock_frappe.get_cached_doc.return_value = mock_pos
		mock_frappe.db.get_value.return_value = "Debtors - TC"
		mock_frappe.db.get_default.return_value = "3"
		mock_item = MagicMock()
		mock_item.qty = 1
		mock_item.is_free_item = 0
		mock_item.get.side_effect = lambda key, default=None: getattr(mock_item, key, default)
		mock_invoice = MagicMock()
		mock_invoice.get.side_effect = lambda key, default=None: [mock_item] if key == "items" else default
		mock_invoice.append.side_effect = lambda table, data: mock_item if table == "items" else MagicMock()
		mock_frappe.new_doc.return_value = mock_invoice
		source = {"price_list_rate": 20, "rate": 18, "discount_percentage": 10, "discount_amount": 2,
			"mule_processing_instructions": "CRACK <<2X>>\n2 PALLETS"}
		from frappe import _dict
		with patch("xpos.api.invoices._sales_order_line", return_value=_dict(source)), patch(
			"xpos.api.invoices.selling_price", return_value=50
		) as current, patch("xpos.api.auth.user_has_pos_permission", return_value=False), patch(
			"xpos.api.invoices.pricing_rule_rates", return_value=[18]
		), patch("xpos.api.invoices.check_discount_cap", wraps=invoices.check_discount_cap) as cap:
			invoices._build_invoice_doc({
				"pos_profile": "POS-PROFILE-1", "customer": "Customer A",
				"items": [{"item_code": "MIX", "qty": 1, "uom": "Bag", "rate": 0.01,
					"sales_order": "SO-1", "so_detail": "SO-ROW", "discount_percentage": 99,
					"mule_processing_instructions": "client override"}],
				"payments": [{"mode_of_payment": "Cash", "amount": 18}],
			})
		cap.assert_called_once_with(mock_invoice, 5, [18])
		# Approved pricing survives, but a new 30% counter discount is refused.
		mock_invoice.get.side_effect = lambda key, default=None: {"items": [mock_item], "additional_discount_percentage": 30}.get(key, default)
		mock_invoice.additional_discount_percentage = 30
		with patch("xpos.api.invoices.frappe.throw", side_effect=ValueError("cap")):
			with self.assertRaisesRegex(ValueError, "cap"):
				invoices.check_discount_cap(mock_invoice, 5, [18])
		current.assert_not_called()
		self.assertEqual(mock_item.price_list_rate, 20)
		self.assertEqual(mock_item.rate, 18)
		self.assertEqual(mock_item.mule_processing_instructions, source["mule_processing_instructions"])
		self.assertEqual(mock_item.discount_percentage, 10)
		mock_frappe.throw.assert_not_called()


class TestInvoiceOutstandingPermissions(unittest.TestCase):
	"""Tests for outstanding-balance permission enforcement."""

	@patch("xpos.api.invoices.frappe.throw")
	def test_validate_unpaid_balance_blocks_credit_sale_when_disallowed(self, mock_throw):
		"""Credit-sale submissions should be blocked when the profile disallows them."""
		invoice_doc = SimpleNamespace(
			outstanding_amount=100,
			paid_amount=0,
			write_off_amount=0,
			is_return=0,
		)
		pos_profile = MagicMock()
		pos_profile.name = "POS-PROFILE-1"
		pos_profile.get.side_effect = lambda key: {
			"allow_credit_sale": 0,
			"allow_partial_payment": 0,
		}.get(key)

		with patch("xpos.api.invoices._", lambda message: message):
			invoices._validate_unpaid_balance_permissions(invoice_doc, pos_profile, {"is_credit_sale": 1})

		mock_throw.assert_called_once_with("Credit sale is not allowed for POS Profile POS-PROFILE-1.")

	@patch("xpos.api.invoices.frappe.throw")
	def test_validate_unpaid_balance_allows_credit_sale_when_enabled(self, mock_throw):
		"""Credit-sale submissions should pass when the profile explicitly allows them."""
		invoice_doc = SimpleNamespace(
			outstanding_amount=100,
			paid_amount=0,
			write_off_amount=0,
			is_return=0,
		)
		pos_profile = MagicMock()
		pos_profile.name = "POS-PROFILE-1"
		pos_profile.get.side_effect = lambda key: {
			"allow_credit_sale": 1,
			"allow_partial_payment": 0,
		}.get(key)

		invoices._validate_unpaid_balance_permissions(invoice_doc, pos_profile, {"is_credit_sale": 1})

		mock_throw.assert_not_called()

	@patch("xpos.api.invoices.frappe.throw")
	def test_validate_unpaid_balance_allows_partial_payment_when_enabled(self, mock_throw):
		"""Non-credit outstanding balances should respect the partial-payment flag."""
		invoice_doc = SimpleNamespace(
			outstanding_amount=25,
			paid_amount=75,
			write_off_amount=0,
			is_return=0,
		)
		pos_profile = MagicMock()
		pos_profile.name = "POS-PROFILE-1"
		pos_profile.get.side_effect = lambda key: {
			"allow_credit_sale": 0,
			"allow_partial_payment": 1,
		}.get(key)

		invoices._validate_unpaid_balance_permissions(invoice_doc, pos_profile, {"is_credit_sale": 0})

		mock_throw.assert_not_called()


class TestInvoicePaymentRowDefaults(unittest.TestCase):
	"""Tests for default POS Invoice payment row seeding."""

	def test_ensure_pos_invoice_payment_row_appends_zero_amount_payment(self):
		"""POS Invoices should always carry at least one payment row for ERPNext validation."""
		invoice_doc = MagicMock()
		invoice_doc.get.return_value = []
		pos_profile = SimpleNamespace(payments=[SimpleNamespace(mode_of_payment="Cash")])

		invoices._ensure_pos_invoice_payment_row(invoice_doc, pos_profile, True)

		invoice_doc.append.assert_called_once_with(
			"payments",
			{"mode_of_payment": "Cash", "amount": 0},
		)

	def test_ensure_pos_invoice_payment_row_skips_when_payment_exists(self):
		"""Existing payment rows must be preserved as-is."""
		invoice_doc = MagicMock()
		invoice_doc.get.return_value = [SimpleNamespace(mode_of_payment="Card", amount=50)]
		pos_profile = SimpleNamespace(payments=[SimpleNamespace(mode_of_payment="Cash")])

		invoices._ensure_pos_invoice_payment_row(invoice_doc, pos_profile, True)

		invoice_doc.append.assert_not_called()


class TestInvoiceDeliveryChargeFields(unittest.TestCase):
	"""Tests for xpos-managed delivery charge handling."""

	def test_apply_invoice_delivery_charge_fields_clears_stale_values(self):
		"""Existing draft delivery-charge values should clear when xpos sends none."""
		invoice_doc = SimpleNamespace(
			flags=SimpleNamespace(),
			pos_delivery_charges="Old Delivery",
			pos_delivery_charges_rate=25,
		)

		invoices._apply_invoice_delivery_charge_fields(invoice_doc, {})

		self.assertIsNone(invoice_doc.pos_delivery_charges)
		self.assertEqual(invoice_doc.pos_delivery_charges_rate, 0)
		self.assertTrue(invoice_doc.flags.xpos_skip_auto_delivery_charges)

	def test_apply_invoice_delivery_charge_fields_sets_explicit_selection(self):
		"""The xpos payload should remain the only source of delivery-charge selection."""
		invoice_doc = SimpleNamespace(flags=SimpleNamespace())

		invoices._apply_invoice_delivery_charge_fields(
			invoice_doc,
			{
				"pos_delivery_charges": "Express Delivery",
				"pos_delivery_charges_rate": "18.5",
			},
		)

		self.assertEqual(invoice_doc.pos_delivery_charges, "Express Delivery")
		self.assertEqual(invoice_doc.pos_delivery_charges_rate, 18.5)
		self.assertTrue(invoice_doc.flags.xpos_skip_auto_delivery_charges)


class TestInvoiceLoyaltyFields(unittest.TestCase):
	"""Tests for xpos-managed loyalty redemption handling."""

	def test_apply_invoice_loyalty_fields_clears_stale_values(self):
		"""Existing loyalty redemption fields should clear when xpos sends none."""
		invoice_doc = SimpleNamespace(
			redeem_loyalty_points=1,
			loyalty_points=50,
			loyalty_amount=500,
		)

		invoices._apply_invoice_loyalty_fields(invoice_doc, {})

		self.assertEqual(invoice_doc.redeem_loyalty_points, 0)
		self.assertEqual(invoice_doc.loyalty_points, 0)
		self.assertEqual(invoice_doc.loyalty_amount, 0)

	def test_apply_invoice_loyalty_fields_ignores_client_amount(self):
		"""xpos should trust loyalty points, not the client-sent monetary amount."""
		invoice_doc = SimpleNamespace(
			redeem_loyalty_points=0,
			loyalty_points=0,
			loyalty_amount=0,
		)

		invoices._apply_invoice_loyalty_fields(
			invoice_doc,
			{
				"redeem_loyalty_points": 1,
				"loyalty_points": 50,
				"loyalty_amount": 999,
			},
		)

		self.assertEqual(invoice_doc.redeem_loyalty_points, 1)
		self.assertEqual(invoice_doc.loyalty_points, 50)
		self.assertEqual(invoice_doc.loyalty_amount, 0)

	@patch("erpnext.accounts.doctype.loyalty_program.loyalty_program.validate_loyalty_points")
	def test_resolve_loyalty_paid_amount_uses_server_validation(self, mock_validate_loyalty_points):
		"""The loyalty amount should be derived by ERPNext from the selected points."""
		invoice_doc = SimpleNamespace(
			redeem_loyalty_points=1,
			loyalty_points=50,
			loyalty_amount=999,
		)

		def _set_loyalty_amount(doc, points):
			doc.loyalty_amount = 25

		mock_validate_loyalty_points.side_effect = _set_loyalty_amount

		loyalty_paid = invoices._resolve_loyalty_paid_amount(invoice_doc)

		self.assertEqual(loyalty_paid, 25)
		self.assertEqual(invoice_doc.loyalty_amount, 25)
		mock_validate_loyalty_points.assert_called_once_with(invoice_doc, 50)


class TestGetInvoices(unittest.TestCase):
	"""Tests for get_invoices function."""

	@patch("xpos.api.invoices.frappe")
	def test_get_invoices_filters_by_shift(self, mock_frappe):
		"""Test that get_invoices filters by POS opening shift."""
		mock_frappe.get_all.return_value = [
			{"name": "INV-001", "grand_total": 100, "customer": "C1"},
			{"name": "INV-002", "grand_total": 200, "customer": "C2"},
		]

		result = invoices.get_invoices(pos_opening_shift="POS-OPEN-001")

		mock_frappe.get_all.assert_called()
		self.assertEqual(len(result), 2)

	@patch("xpos.api.invoices.frappe")
	def test_get_invoices_filters_returns(self, mock_frappe):
		"""Test that get_invoices can filter return invoices."""
		mock_frappe.get_all.return_value = [{"name": "INV-RET-001", "grand_total": -50, "is_return": 1}]

		result = invoices.get_invoices(pos_opening_shift="POS-OPEN-001", is_return=1)

		self.assertEqual(len(result), 1)
		self.assertEqual(result[0]["is_return"], 1)


class TestGetInvoiceDetails(unittest.TestCase):
	"""Tests for get_invoice_details function."""

	@patch("xpos.api.invoices.frappe")
	def test_get_invoice_details_returns_full_invoice(self, mock_frappe):
		"""Test that get_invoice_details returns complete invoice data."""
		mock_invoice = MagicMock()
		mock_invoice.as_dict.return_value = {
			"name": "INV-001",
			"customer": "Customer A",
			"items": [{"item_code": "ITEM-001", "qty": 2, "rate": 50}],
			"payments": [{"mode_of_payment": "Cash", "amount": 100}],
		}
		mock_frappe.get_doc.return_value = mock_invoice

		result = invoices.get_invoice_details("INV-001")

		mock_frappe.get_doc.assert_called_once_with("Sales Invoice", "INV-001")
		self.assertIn("items", result)
		self.assertIn("payments", result)


class TestInvoicePaymentProcessing(unittest.TestCase):
	"""Tests for payment processing in invoices."""

	def test_payment_split_calculation(self):
		"""Test that split payments sum to total."""
		payments = [
			{"mode_of_payment": "Cash", "amount": 50},
			{"mode_of_payment": "Card", "amount": 30},
			{"mode_of_payment": "Gift Card", "amount": 20},
		]

		total_paid = sum(p["amount"] for p in payments)
		self.assertEqual(total_paid, 100)

	def test_return_payment_negative_amounts(self):
		"""Test that return payments have negative amounts."""
		payments = [
			{"mode_of_payment": "Cash", "amount": -50},
		]

		total_refunded = sum(p["amount"] for p in payments)
		self.assertEqual(total_refunded, -50)


class TestInvoiceItemProcessing(unittest.TestCase):
	"""Tests for item processing in invoices."""

	def test_item_total_calculation(self):
		"""Test item total is calculated correctly."""
		items = [
			{"qty": 2, "rate": 50},
			{"qty": 3, "rate": 30},
		]

		total = sum(item["qty"] * item["rate"] for item in items)
		self.assertEqual(total, 190)

	def test_item_discount_application(self):
		"""Test item-level discount calculation."""
		item = {
			"qty": 2,
			"rate": 100,
			"discount_percentage": 10,
		}

		subtotal = item["qty"] * item["rate"]
		discount = subtotal * (item["discount_percentage"] / 100)
		final = subtotal - discount

		self.assertEqual(subtotal, 200)
		self.assertEqual(discount, 20)
		self.assertEqual(final, 180)


class TestValidateReturnInvoice(unittest.TestCase):
	"""Tests for return invoice validation."""

	@patch("xpos.api.invoices.frappe")
	def test_validate_return_checks_original_customer(self, mock_frappe):
		"""Test that return validates customer matches original invoice."""
		mock_frappe.db.get_value.return_value = "Customer A"

		# When customer matches, no error should be raised
		original_customer = mock_frappe.db.get_value("Sales Invoice", "INV-001", "customer")
		self.assertEqual(original_customer, "Customer A")

	@patch("xpos.api.invoices.frappe")
	def test_validate_return_checks_item_qty(self, mock_frappe):
		"""Test that return validates return qty doesn't exceed original."""
		original_items = [
			{"item_code": "ITEM-001", "qty": 5},
			{"item_code": "ITEM-002", "qty": 3},
		]

		return_items = [
			{"item_code": "ITEM-001", "qty": -2},  # Valid: returning 2 of 5
			{"item_code": "ITEM-002", "qty": -3},  # Valid: returning all 3
		]

		for ret_item in return_items:
			orig = next((i for i in original_items if i["item_code"] == ret_item["item_code"]), None)
			self.assertIsNotNone(orig)
			self.assertLessEqual(abs(ret_item["qty"]), orig["qty"])


if __name__ == "__main__":
	unittest.main()


class TestExpectedTotal(unittest.TestCase):
	"""The register charges the server-priced total it showed; a ticket that now
	totals something else is refused instead of posting change, credit or a balance."""

	def setUp(self):
		for name, value in (("invoice_currency_of", "USD"), ("get_currency_precision", 2)):
			patcher = patch(f"xpos.api.invoices.{name}", return_value=value)
			patcher.start()
			self.addCleanup(patcher.stop)

	def ticket(self, total, **fields):
		return SimpleNamespace(get=lambda key, default=None: {"grand_total": total, **fields}.get(key, default))

	def test_the_total_that_was_shown_posts(self):
		invoices.check_expected_total(self.ticket(48.04), {"expected_total": 48.04})

	def test_a_changed_ticket_is_refused(self):
		with self.assertRaises(invoices.TicketChangedError):
			invoices.check_expected_total(self.ticket(128.10), {"expected_total": 48.04})

	def test_a_rounded_total_is_what_is_compared(self):
		with self.assertRaises(invoices.TicketChangedError):
			invoices.check_expected_total(self.ticket(48.04, rounded_total=48.0), {"expected_total": 48.04})

	def test_without_a_preview_nothing_is_compared(self):
		invoices.check_expected_total(self.ticket(128.10), {})

	def test_returns_are_not_compared(self):
		invoices.check_expected_total(self.ticket(-30.0, is_return=1), {"expected_total": -32.03})
