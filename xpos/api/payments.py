# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
POS Payments API.

- Phone payment requests
- Customer credit retrieval & redemption
- Outstanding invoice lookup
- Unallocated payment lookup
- Payment entry creation
- Payments on account (a customer paying toward what they owe)
"""

import json

import frappe
from frappe import _
from frappe.utils import flt, nowdate

from xpos.api.utilities import can_settle_outstanding


@frappe.whitelist()
def get_available_credit(customer: str, company: str) -> list[dict]:
	"""Return all available credit (outstanding returns + unallocated advances) for a customer."""
	if not customer or not company:
		return []

	credits = []

	unallocated = frappe.db.sql(
		"""
		SELECT
			pe.name AS credit_origin,
			(pe.paid_amount - pe.total_allocated_amount) AS total_credit,
			'Payment Entry' AS type,
			pe.posting_date
		FROM `tabPayment Entry` pe
		WHERE pe.party_type = 'Customer'
			AND pe.party = %(customer)s
			AND pe.company = %(company)s
			AND pe.docstatus = 1
			AND pe.payment_type = 'Receive'
			AND (pe.paid_amount - pe.total_allocated_amount) > 0
		ORDER BY pe.posting_date ASC
		""",
		{"customer": customer, "company": company},
		as_dict=True,
	)
	credits.extend(unallocated)

	credit_notes = frappe.db.sql(
		"""
		SELECT
			si.name AS credit_origin,
			ABS(si.outstanding_amount) AS total_credit,
			'Sales Invoice' AS type,
			si.posting_date
		FROM `tabSales Invoice` si
		WHERE si.customer = %(customer)s
			AND si.company = %(company)s
			AND si.docstatus = 1
			AND si.is_return = 1
			AND si.outstanding_amount < 0
		ORDER BY si.posting_date ASC
		""",
		{"customer": customer, "company": company},
		as_dict=True,
	)
	credits.extend(credit_notes)

	return credits


@frappe.whitelist()
def get_outstanding_invoices(
	customer: str | None = None,
	company: str | None = None,
	currency: str | None = None,
	pos_profile: str | None = None,
	page_start: int = 0,
	page_length: int = 20,
	search_term: str | None = None,
) -> list[dict]:
	"""Fetch submitted invoices that still carry a balance."""
	if not customer and not can_settle_outstanding(pos_profile):
		frappe.throw(
			_("You are not permitted to list unpaid invoices across customers."),
			frappe.PermissionError,
		)

	filters = {
		"docstatus": 1,
		"outstanding_amount": [">", 0],
		"is_return": 0,
	}

	if customer:
		filters["customer"] = customer
	if company:
		filters["company"] = company
	if currency:
		filters["currency"] = currency

	or_filters = None
	if search_term:
		pattern = f"%{search_term.strip()}%"
		or_filters = {
			"name": ["like", pattern],
			"customer": ["like", pattern],
			"customer_name": ["like", pattern],
		}

	invoices = frappe.get_list(
		"Sales Invoice",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"posting_date",
			"grand_total",
			"paid_amount",
			"outstanding_amount",
			"currency",
			"status",
		],
		limit_start=page_start,
		limit_page_length=page_length,
		order_by="posting_date asc",
	)

	return invoices


@frappe.whitelist()
def get_unallocated_payments(
	customer: str, company: str, currency: str | None = None, mode_of_payment: str | None = None
) -> list[dict]:
	"""Returns unallocated payments, journal entries, and credit notes for a customer."""
	payments = []

	pe_filters = {
		"party_type": "Customer",
		"party": customer,
		"company": company,
		"docstatus": 1,
		"payment_type": "Receive",
		"unallocated_amount": [">", 0],
	}
	if mode_of_payment:
		pe_filters["mode_of_payment"] = mode_of_payment

	pe_list = frappe.get_list(
		"Payment Entry",
		filters=pe_filters,
		fields=[
			"name",
			"posting_date",
			"paid_amount",
			"unallocated_amount",
			"mode_of_payment",
			"paid_to_account_currency as currency",
		],
	)
	for pe in pe_list:
		pe["type"] = "Payment Entry"
		payments.append(pe)

	cn_list = frappe.db.sql(
		"""
		SELECT
			name, posting_date, grand_total,
			ABS(outstanding_amount) AS unallocated_amount,
			currency
		FROM `tabSales Invoice`
		WHERE customer = %(customer)s
			AND company = %(company)s
			AND docstatus = 1
			AND is_return = 1
			AND outstanding_amount < 0
		ORDER BY posting_date ASC
		""",
		{"customer": customer, "company": company},
		as_dict=True,
	)
	for cn in cn_list:
		cn["type"] = "Credit Note"
		payments.append(cn)

	return payments


def stamp_till_payment(pe, pos_profile: str | None, pos_opening_shift: str, typed_cashier: str | None = None) -> None:
	"""Mark a Payment Entry taken at the till so the shift's close counts it (MuleCity-49ue).

	``reference_no`` is the POS Opening Shift: the tag ``shifts.get_shift_till_payments``
	(and the desk closing's ``get_payments_entries``) reads. ``pos_cashier`` follows the
	invoice rule (``invoices.apply_pos_cashier``): a named login records its full name; on
	the shared login the typed initials must be on the profile's cashier list. A shared-login
	payment with no initials typed (the Receive on Account and Settle dialogs don't ask yet)
	is saved without, and counts under "(none)" on the close sheet.
	"""
	from xpos.api.invoices import apply_pos_cashier, is_shared_login, normalize_initials

	pe.reference_no = pos_opening_shift
	if not pos_profile or not frappe.get_meta("Payment Entry").has_field("pos_cashier"):
		return
	pos = frappe.get_cached_doc("POS Profile", pos_profile)
	if is_shared_login(pos, frappe.session.user) and not normalize_initials(typed_cashier):
		return
	apply_pos_cashier(pe, pos, typed_cashier)


def create_payment_entry(data: str | dict) -> dict:
	"""Create (and optionally submit) a Payment Entry for a customer."""
	if isinstance(data, str):
		data = json.loads(data)

	customer = data.get("customer")
	company = data.get("company")
	amount = flt(data.get("amount"))
	mode_of_payment = data.get("mode_of_payment")

	if not all([customer, company, amount, mode_of_payment]):
		frappe.throw(_("Customer, Company, Amount, and Mode of Payment are required"))

	from erpnext.accounts.doctype.sales_invoice.sales_invoice import (
		get_bank_cash_account,
	)

	account_details = get_bank_cash_account(mode_of_payment, company)

	pe = frappe.new_doc("Payment Entry")
	pe.payment_type = "Receive"
	pe.party_type = "Customer"
	pe.party = customer
	pe.company = company
	pe.paid_amount = amount
	pe.received_amount = amount
	pe.mode_of_payment = mode_of_payment
	pe.paid_to = account_details.get("account")
	pe.posting_date = nowdate()
	pe.reference_no = data.get("reference_no", "POS Payment")
	pe.reference_date = nowdate()
	if data.get("pos_opening_shift"):
		stamp_till_payment(pe, data.get("pos_profile"), data["pos_opening_shift"], data.get("pos_cashier"))

	if data.get("reference_doctype") and data.get("reference_name"):
		pe.append(
			"references",
			{
				"reference_doctype": data["reference_doctype"],
				"reference_name": data["reference_name"],
				"allocated_amount": amount,
			},
		)

	pe.insert(ignore_permissions=True)

	if data.get("submit"):
		pe.submit()

	return {
		"name": pe.name,
		"paid_amount": pe.paid_amount,
		"status": "Submitted" if pe.docstatus == 1 else "Draft",
	}


@frappe.whitelist()
def settle_outstanding_invoice(
	invoice: str,
	amount: float,
	mode_of_payment: str,
	pos_opening_shift: str,
	pos_profile: str | None = None,
	pos_cashier: str | None = None,
) -> dict:
	"""Collect payment against a past submitted invoice from the POS.

	This is the credit-sale half of open tabs: the sale is already submitted, so it
	is settled with a Payment Entry rather than by loading a cart.
	"""
	if not can_settle_outstanding(pos_profile):
		frappe.throw(
			_("You are not permitted to settle outstanding invoices."),
			frappe.PermissionError,
		)

	if not pos_opening_shift:
		frappe.throw(_("An open shift is required to settle an invoice."))

	if not frappe.db.exists("Sales Invoice", invoice):
		frappe.throw(_("Sales Invoice {0} does not exist").format(invoice))

	invoice_doc = frappe.get_doc("Sales Invoice", invoice)

	if invoice_doc.docstatus != 1:
		frappe.throw(_("Only a submitted invoice can be settled."))

	outstanding_amount = flt(invoice_doc.outstanding_amount)
	if outstanding_amount <= 0:
		frappe.throw(_("Invoice {0} has nothing outstanding.").format(invoice))

	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("Payment amount must be greater than zero."))

	if amount > outstanding_amount + 0.009:
		frappe.throw(
			_("Payment of {0} exceeds the {1} outstanding on invoice {2}.").format(
				amount, outstanding_amount, invoice
			)
		)

	result = create_payment_entry(
		{
			"customer": invoice_doc.customer,
			"company": invoice_doc.company,
			"amount": amount,
			"mode_of_payment": mode_of_payment,
			"reference_doctype": "Sales Invoice",
			"reference_name": invoice,
			"reference_no": pos_opening_shift,
			"pos_opening_shift": pos_opening_shift,
			"pos_profile": pos_profile,
			"pos_cashier": pos_cashier,
			"submit": True,
		}
	)

	return {
		"payment_entry": result.get("name"),
		"allocated_amount": amount,
		"outstanding_after": flt(frappe.db.get_value("Sales Invoice", invoice, "outstanding_amount")),
	}


@frappe.whitelist()
def receive_on_account(
	customer: str,
	amount: float,
	mode_of_payment: str,
	pos_opening_shift: str,
	pos_profile: str | None = None,
	pos_cashier: str | None = None,
) -> dict:
	"""Take a payment toward what a customer owes, the standard ERPNext way.

	One Payment Entry (Receive, Customer), allocated by ERPNext's own "Get
	Outstanding Invoices" + "Allocate Payment Amount" (oldest first); what is
	left over stays an unallocated advance for Payment Reconciliation. Gated
	like ``settle_outstanding_invoice``, which settles a single ticket.
	"""
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_outstanding_reference_documents
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	if not can_settle_outstanding(pos_profile):
		frappe.throw(_("You are not permitted to take payments on account."), frappe.PermissionError)
	if not pos_opening_shift:
		frappe.throw(_("An open shift is required to take a payment on account."))
	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("Payment amount must be greater than zero."))
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} does not exist").format(customer))

	company = frappe.db.get_value("POS Profile", pos_profile, "company") if pos_profile else None
	company = company or frappe.defaults.get_user_default("Company")

	pe = frappe.new_doc("Payment Entry")
	pe.payment_type = "Receive"
	pe.party_type = "Customer"
	pe.party = customer
	pe.company = company
	pe.posting_date = nowdate()
	pe.mode_of_payment = mode_of_payment
	pe.paid_to = get_bank_cash_account(mode_of_payment, company).get("account")
	pe.paid_amount = amount
	pe.received_amount = amount
	stamp_till_payment(pe, pos_profile, pos_opening_shift, pos_cashier)
	pe.reference_date = nowdate()
	pe.setup_party_account_field()
	pe.set_missing_values()

	outstanding = get_outstanding_reference_documents(
		{
			"posting_date": nowdate(),
			"company": company,
			"party_type": "Customer",
			"party": customer,
			"party_account": pe.paid_from,
			"get_outstanding_invoices": True,
		},
		validate=True,
	) or []
	for ref in outstanding:
		if flt(ref.get("outstanding_amount")) <= 0:
			continue
		pe.append(
			"references",
			{
				"reference_doctype": ref.get("voucher_type"),
				"reference_name": ref.get("voucher_no"),
				"due_date": ref.get("due_date"),
				"total_amount": ref.get("invoice_amount"),
				"outstanding_amount": ref.get("outstanding_amount"),
				"payment_term": ref.get("payment_term"),
				"account": ref.get("account"),
			},
		)
	pe.allocate_amount_to_references(amount, paid_amount_change=True, allocate_payment_amount=True)
	pe.references = [row for row in pe.references if flt(row.allocated_amount) > 0]
	pe.insert(ignore_permissions=True)
	pe.submit()

	return {
		"payment_entry": pe.name,
		"allocated": [
			{"reference_doctype": r.reference_doctype, "reference_name": r.reference_name, "allocated_amount": flt(r.allocated_amount)}
			for r in pe.references
		],
		"unallocated_amount": flt(pe.unallocated_amount),
	}


@frappe.whitelist()
def create_payment_request(doc: str | dict) -> dict | None:
	"""Creates a phone payment request."""
	if isinstance(doc, str):
		doc = json.loads(doc)

	for pay in doc.get("payments", []):
		if pay.get("type") == "Phone":
			if flt(pay.get("amount")) <= 0:
				frappe.throw(_("Payment amount cannot be less than or equal to 0"))

			if not doc.get("contact_mobile"):
				frappe.throw(_("Please enter the phone number first"))

			payment_gateway_account = frappe.db.get_value(
				"Payment Gateway Account",
				{"payment_account": pay.get("account")},
				"name",
			)

			existing = frappe.db.exists(
				{
					"doctype": "Payment Request",
					"reference_doctype": "Sales Invoice",
					"reference_name": doc.get("name"),
					"payment_gateway_account": payment_gateway_account,
				}
			)

			if existing:
				pr = frappe.get_doc("Payment Request", existing)
				pr.request_phone_payment()
				return pr.as_dict()

			from erpnext.accounts.doctype.payment_request.payment_request import (
				make_payment_request,
			)

			args = {
				"dt": "Sales Invoice",
				"dn": doc.get("name"),
				"recipient_id": doc.get("contact_mobile"),
				"mode_of_payment": pay.get("mode_of_payment"),
				"payment_gateway_account": payment_gateway_account,
				"payment_request_type": "Inward",
				"party_type": "Customer",
				"party": doc.get("customer"),
				"return_doc": True,
			}

			try:
				pr = make_payment_request(**args)
				pr.submit()
				return pr.as_dict()
			except Exception as e:
				frappe.log_error(f"Payment request creation failed: {e}", "X POS Payment Request")
				frappe.throw(_("Failed to create payment request: {0}").format(str(e)))

	return None
