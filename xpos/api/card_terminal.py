# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Pay by Card on a card terminal, through the ``payments`` app's terminal framework.

The register saves the sale as a draft carrying a 0.00 row for the terminal's
Mode of Payment, then asks the payments app to collect the card balance on a
paired reader (``payments.transactions.service.start_terminal_payment``). Once
the processor confirms the capture, the payments app fills in the card row and
submits this same draft: the register never submits a card sale itself, so a
card sale is never queued for ``create_invoice`` and never posted twice.

Everything here is off unless the payments app is installed and a terminal
gateway (Stripe Settings) maps a Mode of Payment for the company and a paired
Payment Terminal is assigned to the register's POS Profile. Registers without
it keep taking cards as before (a manual card tender).
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from xpos.api.delivery import note_typed_miles, resolve_new_shipping_address
from xpos.api.exchange import get_currency_precision
from xpos.api.invoices import (
	_build_invoice_doc,
	_build_invoice_response,
	apply_pos_cashier,
	check_expected_total,
	check_may_sell,
	enforce_stock_availability,
	find_invoice_by_local_id,
)
from xpos.api.tender import invoice_currency_of
from xpos.api.utilities import get_invoice_type

LEDGER = "Payment Transaction Capture"
# Lines that bill a Sales Order carry its advance; the terminal framework takes cash and one card only.
ORDER_LINE_FIELDS = ("sales_order", "so_detail")


def payments_ready() -> bool:
	"""Whether the payments app's terminal framework is installed on this site."""
	return (
		"payments" in frappe.get_installed_apps()
		and bool(frappe.db.exists("DocType", LEDGER))
		and bool(frappe.db.exists("DocType", "Payment Terminal"))
	)


def card_modes(company: str | None) -> list[str]:
	"""The Modes of Payment a terminal gateway collects for ``company`` (empty when off)."""
	if not company or not payments_ready():
		return []
	try:
		from payments.integrations.erpnext import configured_terminal_modes
	except ImportError:
		return []
	return list(configured_terminal_modes(company))


def profile_terminals(pos_profile: str, user: str | None = None) -> list[dict]:
	"""Paired, enabled readers assigned to this POS Profile that ``user`` may use."""
	if not payments_ready() or not frappe.db.has_column("Payment Terminal", "pos_profile"):
		return []
	user = user or frappe.session.user
	rows = frappe.get_all(
		"Payment Terminal",
		filters={"disabled": 0, "pairing_status": "PAIRED", "pos_profile": pos_profile},
		fields=["name", "terminal_name", "allowed_users", "payment_gateway"],
		order_by="terminal_name asc",
	)
	return [
		{"name": row.name, "label": row.terminal_name or row.name}
		for row in rows
		if (not row.allowed_users or user in row.allowed_users.splitlines())
		and gateway_collects(row.payment_gateway)
	]


def gateway_collects(payment_gateway: str | None) -> bool:
	"""Whether the reader's gateway settings are enabled for terminal collection."""
	if not payment_gateway:
		return False
	try:
		from payments.transactions.drivers import controller_for

		controller = controller_for(payment_gateway)
	except Exception:
		return False
	if not getattr(controller, "supports_payment_terminal", False) or controller.get("disabled"):
		return False
	return not controller.meta.has_field("terminal_enabled") or bool(controller.get("terminal_enabled"))


@frappe.whitelist()
def get_card_terminal_config(pos_profile: str) -> dict:
	"""What the register needs to offer Pay by Card, or ``enabled: False``.

	``card_modes`` is returned even when no reader is paired: those modes are
	only ever filled in by the payments app, so the register never offers them
	as an ordinary tender button.
	"""
	off = {"enabled": False, "card_modes": [], "mode_of_payment": None, "terminals": []}
	if not pos_profile or not payments_ready():
		return off
	check_may_sell(pos_profile)
	company = frappe.get_cached_value("POS Profile", pos_profile, "company")
	modes = card_modes(company)
	if not modes:
		return off
	terminals = profile_terminals(pos_profile)
	return {
		"enabled": bool(terminals),
		"card_modes": modes,
		"mode_of_payment": modes[0],
		"terminals": terminals,
	}


def active_request(doctype: str, name: str) -> str | None:
	"""The payment obligation with a collection still unresolved on this sale, if any."""
	if not payments_ready():
		return None
	return frappe.db.get_value(
		LEDGER,
		{
			"record_type": "Request",
			"reference_doctype": doctype,
			"reference_name": name,
			"active_attempt": ["is", "set"],
		},
		"name",
	)


def _refuse_ineligible(data: dict) -> None:
	"""Sales the terminal framework cannot take: refunds, charges, orders, points."""
	if cint(data.get("is_return")):
		frappe.throw(_("A refund is not taken on the card reader. Use Return."))
	if cint(data.get("is_credit_sale")):
		frappe.throw(_("A sale charged On Account is not paid by card."))
	if data.get("pay_mode"):
		frappe.throw(_("Custom mix orders are not paid on the card reader yet. Use another tender."))
	if any(row.get(field) for row in data.get("items") or [] for field in ORDER_LINE_FIELDS):
		frappe.throw(_("A ticket that bills an order is not paid on the card reader yet. Use another tender."))
	if cint(data.get("redeem_loyalty_points")):
		frappe.throw(_("Loyalty points and a card reader payment cannot be combined."))
	if flt(data.get("write_off_amount")):
		frappe.throw(_("A write-off and a card reader payment cannot be combined."))
	if flt(data.get("change_amount")) or data.get("pos_change_legs"):
		frappe.throw(_("No change is given on a card reader sale. Take less cash."))


def _card_payments(data: dict, invoice_currency: str, modes: list[str], mode: str) -> list[dict]:
	"""The client's cash legs, then the card row at 0.00 (the payments app fills it in)."""
	rows = []
	for row in data.get("payments") or []:
		row_mode = row.get("mode_of_payment")
		if not row_mode or row_mode in modes:
			# The client never sets the card amount.
			continue
		if not flt(row.get("amount")) and not flt(row.get("pos_tender_amount")):
			continue
		if frappe.get_cached_value("Mode of Payment", row_mode, "type") != "Cash":
			frappe.throw(
				_("Only cash can be taken with a card reader payment; {0} cannot. Remove it or use another tender.").format(
					row_mode
				)
			)
		if (row.get("pos_tender_currency") or invoice_currency) != invoice_currency:
			frappe.throw(_("Foreign cash cannot be combined with a card reader payment."))
		rows.append(row)
	rows.append({"mode_of_payment": mode, "amount": 0})
	return rows


def card_balance(invoice_doc, mode: str) -> float:
	"""What the card must collect: the ticket total less the cash legs."""
	precision = get_currency_precision(invoice_currency_of(invoice_doc))
	total = flt(
		invoice_doc.grand_total
		if cint(invoice_doc.get("disable_rounded_total"))
		else invoice_doc.get("rounded_total") or invoice_doc.grand_total,
		precision,
	)
	cash = sum(flt(row.amount) for row in invoice_doc.get("payments") or [] if row.mode_of_payment != mode)
	return flt(total - cash, precision)


def _draft_response(invoice_doc, mode: str, doctype: str) -> dict:
	return {
		"name": invoice_doc.name,
		"doctype": doctype,
		"modified": str(invoice_doc.modified),
		"docstatus": invoice_doc.docstatus,
		"grand_total": invoice_doc.grand_total,
		"rounded_total": invoice_doc.get("rounded_total"),
		"card_amount": card_balance(invoice_doc, mode),
		"mode_of_payment": mode,
		"customer": invoice_doc.customer,
		"customer_name": invoice_doc.customer_name,
	}


@frappe.whitelist(methods=["POST"])
def save_card_draft(data: str | dict) -> dict:
	"""Save the cart as the draft sale a card reader payment collects for.

	The same cart checks as ``create_invoice`` (seat at the register, price lock,
	discount cap, cashier initials, stock, the previewed total), without the
	submission: the payments app submits the draft once the card is captured.
	Saving again updates the same draft (by name, or by the cart's ``local_id``),
	so a retry never starts a second sale. A cart whose card payment is still
	unresolved is returned as saved, untouched; one the payments app has already
	posted answers ``submitted: True``.
	"""
	data = dict(json.loads(data) if isinstance(data, str) else data)
	pos_profile = data.get("pos_profile")
	check_may_sell(pos_profile)
	pos = frappe.get_cached_doc("POS Profile", pos_profile)

	modes = card_modes(pos.company)
	if not modes:
		frappe.throw(_("Card reader payments are not set up for this register."))
	mode = data.get("card_mode") or modes[0]
	if mode not in modes:
		frappe.throw(_("{0} is not a card reader Mode of Payment.").format(mode))

	doctype = get_invoice_type()
	local_id = data.get("local_id")

	# A card sale the payments app already posted: a lost response or a reload.
	existing = find_invoice_by_local_id(local_id, pos.warehouse)
	if existing:
		dt, name = existing
		doc = frappe.get_doc(dt, name)
		doc.check_permission("read")
		return {**_build_invoice_response(doc), "doctype": dt, "submitted": True}

	if not data.get("name") and local_id:
		data["name"] = frappe.db.get_value(doctype, {"xpos_local_id": local_id, "docstatus": 0}, "name")
		data.pop("modified", None)

	if data.get("name") and frappe.db.exists(doctype, data["name"]):
		draft = frappe.get_doc(doctype, data["name"])
		if draft.docstatus == 1 and draft.get("payment_transaction"):
			draft.check_permission("read")
			return {**_build_invoice_response(draft), "doctype": doctype, "submitted": True}
		if draft.docstatus == 0 and active_request(doctype, draft.name):
			# Frozen while the reader may be collecting; resume it as it is.
			if draft.pos_profile != pos_profile:
				raise frappe.PermissionError
			return {**_draft_response(draft, mode, doctype), "active": True}

	_refuse_ineligible(data)

	invoice_currency = data.get("currency") or pos.currency or frappe.get_cached_value(
		"Company", pos.company, "default_currency"
	)
	data["payments"] = _card_payments(data, invoice_currency, modes, mode)
	for key in ("change_amount", "pos_change_legs", "write_off_amount", "is_credit_sale"):
		data.pop(key, None)

	resolve_new_shipping_address(data)
	invoice_doc, pos, doctype, is_existing_draft = _build_invoice_doc(
		data, local_id, keep_zero_modes=frozenset({mode})
	)
	apply_pos_cashier(invoice_doc, pos, data.get("pos_cashier"))
	if is_existing_draft:
		invoice_doc.save(ignore_permissions=True)
	else:
		invoice_doc.insert(ignore_permissions=True)
	note_typed_miles(invoice_doc, data)

	enforce_stock_availability(invoice_doc)
	check_expected_total(invoice_doc, data)

	if not any(row.mode_of_payment == mode for row in invoice_doc.payments):
		frappe.throw(_("The card row was not kept on the draft sale."))
	if flt(invoice_doc.get("change_amount")) or flt(invoice_doc.get("write_off_amount")):
		frappe.throw(_("No change is given on a card reader sale. Take less cash."))
	if card_balance(invoice_doc, mode) <= 0:
		frappe.throw(_("The cash covers this sale; finish it with Pay, not the card reader."))

	return _draft_response(invoice_doc, mode, doctype)


def has_card_payment_history(doctype: str, name: str) -> bool:
	"""Whether the payments app holds an obligation for this sale (kept, never deleted)."""
	if not payments_ready():
		return False
	return bool(
		frappe.db.exists(
			LEDGER, {"record_type": "Request", "reference_doctype": doctype, "reference_name": name}
		)
	)


def pending_card_sales(opening_shift: str) -> list[str]:
	"""Draft sales of this shift whose card reader payment is still unresolved."""
	if not payments_ready():
		return []
	doctype = get_invoice_type()
	drafts = frappe.get_all(
		doctype, filters={"pos_opening_shift": opening_shift, "docstatus": 0}, pluck="name"
	)
	return [name for name in drafts if active_request(doctype, name)]


def assert_no_pending_card_payment(opening_shift: str) -> None:
	"""Refuse to close a shift while a card reader may still be collecting for one of its sales."""
	pending = pending_card_sales(opening_shift)
	if pending:
		frappe.throw(
			_(
				"A card payment is still in progress for {0}. Finish or cancel it on the register before closing the shift."
			).format(", ".join(pending)),
			title=_("Card payment in progress"),
		)
