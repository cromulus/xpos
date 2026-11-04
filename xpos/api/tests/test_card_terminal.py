# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Pay by Card on a card reader (MuleCity-bjjv.3): the server half, without a site.

The payments app's terminal framework collects for a saved draft POS sale that
carries a 0.00 row for the reader's Mode of Payment. XPOS dropped every 0.00
row, so it could not save that draft; ``save_card_draft`` keeps it. A card sale
is never one the framework cannot take: no refund, charge, order, points,
write-off or change, and only cash beside the card.
"""

import unittest
from unittest.mock import patch

import frappe

from xpos.api import card_terminal, tender
from xpos.api.tests.test_tender import Doc, fake_precision, fake_rate

_patches = []


def _throw(message, exc=frappe.ValidationError, **_kwargs):
	raise exc(message)


def setUpModule():
	"""Run without a site: rounding, translation and throw need no request context."""
	for target, kwargs in (
		("frappe.get_system_settings", {"return_value": None}),
		("xpos.api.card_terminal._", {"new": lambda message: message}),
		("xpos.api.card_terminal.frappe.throw", {"new": _throw}),
	):
		_patches.append(patch(target, **kwargs))
		_patches[-1].start()


def tearDownModule():
	for active in reversed(_patches):
		active.stop()


def usd_invoice(**fields):
	return Doc(currency="USD", company="Mule City", posting_date="2026-11-03", **fields)


MODES = {
	"Cash": {"currency": None, "type": "Cash"},
	"Stripe Card": {"currency": None, "type": "Bank"},
	"Check": {"currency": None, "type": "Bank"},
}


class TestZeroCardRowIsKept(unittest.TestCase):
	def build(self, payments, keep=frozenset()):
		with (
			patch("xpos.api.tender.get_mode_tender_currencies", return_value=MODES),
			patch("xpos.api.tender.resolve_tender_rate", side_effect=fake_rate),
			patch("xpos.api.tender.get_currency_precision", side_effect=fake_precision),
		):
			return tender.build_tender_legs(payments, usd_invoice(), {}, keep)

	def test_zero_rows_are_still_dropped_by_default(self):
		"""Every existing caller (create_invoice, save_draft_invoice) is unchanged."""
		rows, total = self.build([{"mode_of_payment": "Cash", "amount": 0}, {"mode_of_payment": "Stripe Card", "amount": 0}])
		self.assertEqual(rows, [])
		self.assertEqual(total, 0)

	def test_the_card_row_is_kept_at_zero_beside_cash(self):
		rows, total = self.build(
			[{"mode_of_payment": "Cash", "amount": 10}, {"mode_of_payment": "Stripe Card", "amount": 0}],
			frozenset({"Stripe Card"}),
		)
		self.assertEqual(rows, [{"mode_of_payment": "Cash", "amount": 10.0}, {"mode_of_payment": "Stripe Card", "amount": 0.0}])
		self.assertEqual(total, 10.0)

	def test_only_the_named_mode_is_kept(self):
		rows, _total = self.build(
			[{"mode_of_payment": "Cash", "amount": 0}, {"mode_of_payment": "Stripe Card", "amount": 0}],
			frozenset({"Stripe Card"}),
		)
		self.assertEqual([row["mode_of_payment"] for row in rows], ["Stripe Card"])


class TestIneligibleSales(unittest.TestCase):
	def refused(self, **data):
		with self.assertRaises(frappe.ValidationError):
			card_terminal._refuse_ineligible({"items": [{"item_code": "BAG"}], **data})

	def test_refund_is_refused(self):
		self.refused(is_return=1)

	def test_on_account_charge_is_refused(self):
		self.refused(is_credit_sale=True)

	def test_mix_order_is_refused(self):
		self.refused(pay_mode="now")

	def test_ticket_billing_an_order_is_refused(self):
		self.refused(items=[{"item_code": "MIX", "so_detail": "abc", "sales_order": "SO-1"}])

	def test_points_write_off_and_change_are_refused(self):
		self.refused(redeem_loyalty_points=1)
		self.refused(write_off_amount=0.5)
		self.refused(change_amount=2)
		self.refused(pos_change_legs=[{"mode_of_payment": "Cash", "amount": 2}])

	def test_a_plain_sale_passes(self):
		card_terminal._refuse_ineligible({"items": [{"item_code": "BAG", "qty": 1}], "payments": []})


class TestCardPayments(unittest.TestCase):
	def payments(self, rows):
		with patch.object(
			card_terminal.frappe, "get_cached_value", side_effect=lambda _dt, mode, _f: MODES[mode]["type"]
		):
			return card_terminal._card_payments({"payments": rows}, "USD", ["Stripe Card"], "Stripe Card")

	def test_cash_legs_then_the_card_row_at_zero(self):
		rows = self.payments([{"mode_of_payment": "Cash", "amount": 10}])
		self.assertEqual(rows, [{"mode_of_payment": "Cash", "amount": 10}, {"mode_of_payment": "Stripe Card", "amount": 0}])

	def test_a_card_amount_sent_by_the_client_is_ignored(self):
		"""Only the payments app fills in the card row, after the processor confirms the capture."""
		rows = self.payments([{"mode_of_payment": "Stripe Card", "amount": 99}])
		self.assertEqual(rows, [{"mode_of_payment": "Stripe Card", "amount": 0}])

	def test_zero_cash_legs_are_dropped(self):
		rows = self.payments([{"mode_of_payment": "Cash", "amount": 0}])
		self.assertEqual(rows, [{"mode_of_payment": "Stripe Card", "amount": 0}])

	def test_a_check_beside_the_card_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			self.payments([{"mode_of_payment": "Check", "amount": 5}])

	def test_foreign_cash_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			self.payments([{"mode_of_payment": "Cash", "amount": 5, "pos_tender_currency": "LBP"}])


class TestCardBalance(unittest.TestCase):
	def balance(self, **fields):
		doc = Doc(currency="USD", grand_total=42.74, rounded_total=42.75, disable_rounded_total=0, **fields)
		with patch("xpos.api.card_terminal.get_currency_precision", return_value=2):
			return card_terminal.card_balance(doc, "Stripe Card")

	def test_the_card_takes_the_rounded_total_less_cash(self):
		payments = [Doc(mode_of_payment="Cash", amount=10), Doc(mode_of_payment="Stripe Card", amount=0)]
		self.assertEqual(self.balance(payments=payments), 32.75)

	def test_without_rounding_the_grand_total(self):
		doc = Doc(currency="USD", grand_total=42.74, rounded_total=42.75, disable_rounded_total=1, payments=[])
		with patch("xpos.api.card_terminal.get_currency_precision", return_value=2):
			self.assertEqual(card_terminal.card_balance(doc, "Stripe Card"), 42.74)


class TestFeatureIsOffWithoutTheTerminalFramework(unittest.TestCase):
	def test_no_payments_app_means_no_card_modes(self):
		with patch("xpos.api.card_terminal.payments_ready", return_value=False):
			self.assertEqual(card_terminal.card_modes("Mule City"), [])
			self.assertEqual(card_terminal.profile_terminals("Mule City Retail", "pos@example.com"), [])
			self.assertFalse(card_terminal.has_card_payment_history("Sales Invoice", "SINV-1"))
			self.assertIsNone(card_terminal.active_request("Sales Invoice", "SINV-1"))
			self.assertEqual(card_terminal.pending_card_sales("POS-OS-1"), [])

	def test_config_is_disabled_without_the_framework(self):
		with patch("xpos.api.card_terminal.payments_ready", return_value=False):
			config = card_terminal.get_card_terminal_config("Mule City Retail")
		self.assertEqual(config, {"enabled": False, "card_modes": [], "mode_of_payment": None, "terminals": []})


class TestEndpoints(unittest.TestCase):
	def test_draft_save_is_post_only_and_whitelisted(self):
		self.assertIn(card_terminal.save_card_draft, frappe.whitelisted)
		self.assertIn(card_terminal.get_card_terminal_config, frappe.whitelisted)
		self.assertNotIn(card_terminal.assert_no_pending_card_payment, frappe.whitelisted)
		self.assertNotIn(card_terminal.pending_card_sales, frappe.whitelisted)


class TestTheRegistersReaderPicksTheCardMode(unittest.TestCase):
	"""MuleCity-bjjv.5: with Stripe and Square both mapped for the company, the
	draft's card row is the mode of the register's own reader, not whichever
	gateway's mode sorts first."""

	def config(self, modes, terminals):
		with (
			patch("xpos.api.card_terminal.payments_ready", return_value=True),
			patch("xpos.api.card_terminal.check_may_sell"),
			patch("xpos.api.card_terminal.frappe.get_cached_value", return_value="Mule City"),
			patch("xpos.api.card_terminal.card_modes", return_value=modes),
			patch("xpos.api.card_terminal.profile_terminals", return_value=terminals),
		):
			return card_terminal.get_card_terminal_config("Mule City Retail")

	def test_a_stripe_reader_beside_a_square_gateway_uses_stripe_card(self):
		reader = {"name": "T-1", "label": "Counter", "mode_of_payment": "Stripe Card"}
		config = self.config(["Square Card", "Stripe Card"], [reader])
		self.assertEqual(
			config,
			{
				"enabled": True,
				"card_modes": ["Square Card", "Stripe Card"],
				"mode_of_payment": "Stripe Card",
				"terminals": [reader],
			},
		)

	def test_a_square_reader_uses_square_card(self):
		reader = {"name": "T-2", "label": "Counter", "mode_of_payment": "Square Card"}
		self.assertEqual(self.config(["Square Card", "Stripe Card"], [reader])["mode_of_payment"], "Square Card")

	def test_no_reader_keeps_the_modes_hidden_and_pay_by_card_off(self):
		config = self.config(["Stripe Card"], [])
		self.assertEqual((config["enabled"], config["card_modes"]), (False, ["Stripe Card"]))

	def test_a_reader_whose_gateway_maps_no_mode_for_the_company_is_not_offered(self):
		config = self.config(["Stripe Card"], [{"name": "T-3", "label": "Other", "mode_of_payment": None}])
		self.assertEqual((config["enabled"], config["terminals"]), (False, []))

	def test_terminal_mode_reads_the_gateway_metadata(self):
		class Settings:
			def get_terminal_metadata(self, terminal):
				return {"mode_of_payment": "Square Card", "company": "Mule City"}

		self.assertEqual(card_terminal.terminal_mode(Settings()), "Square Card")
		self.assertIsNone(card_terminal.terminal_mode(object()))
