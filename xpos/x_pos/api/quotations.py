import json

import frappe
from frappe.utils import getdate


def _map_delivery_dates(data: dict):
	"""Ensure mandatory delivery_date fields are populated."""

	def parse_date(value):
		if not value:
			return None
		try:
			return str(getdate(value))
		except Exception:
			return None

	if not data.get("delivery_date") and data.get("pos_delivery_date"):
		parsed = parse_date(data.get("pos_delivery_date"))
		if parsed:
			data["delivery_date"] = parsed

	for item in data.get("items", []):
		if not item.get("delivery_date"):
			delivery = item.get("delivery_date") or item.get("pos_delivery_date") or data.get("delivery_date")
			parsed = parse_date(delivery)
			if parsed:
				item["delivery_date"] = parsed


def _ensure_customer_fields(data):
	if not isinstance(data, dict):
		return

	if data.get("doctype") != "Quotation":
		return

	customer = data.get("customer") or data.get("party_name")
	if customer:
		data["customer"] = customer
		data["party_name"] = customer
		data.setdefault("customer_name", customer)

	data.setdefault("quotation_to", "Customer")


def _quotation_doc(data: dict, ptype: str):
	"""The Quotation the payload names, or a new one, once the caller holds ``ptype`` on it (mc63).

	The payload is always a Quotation: before mc63 its ``doctype`` was the
	client's, so with ``ignore_permissions`` any logged-in user could create any
	document (MuleCity-0bsc). Saving still skips link and child-table checks, as
	before, but only after Frappe's own permission on the Quotation.
	"""
	data["doctype"] = "Quotation"
	for field in ("owner", "creation", "modified_by", "docstatus"):
		data.pop(field, None)
	name = data.get("name")
	if name and frappe.db.exists("Quotation", name):
		doc = frappe.get_doc("Quotation", name)
		frappe.has_permission("Quotation", ptype, doc=doc, throw=True)
		doc.update(data)
		return doc
	frappe.has_permission("Quotation", "create", throw=True)
	if ptype != "write":
		frappe.has_permission("Quotation", ptype, throw=True)
	return frappe.get_doc(data)


@frappe.whitelist()
def update_quotation(data: str | dict):
	"""Create or update a Quotation document."""
	if isinstance(data, str):
		data = json.loads(data)
	_map_delivery_dates(data)
	_ensure_customer_fields(data)
	doc = _quotation_doc(data, "write")

	doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	doc.docstatus = 0
	doc.save()
	return doc


@frappe.whitelist()
def submit_quotation(order: str | dict):
	"""Submit quotation document."""
	if isinstance(order, str):
		order = json.loads(order)
	_map_delivery_dates(order)
	_ensure_customer_fields(order)
	doc = _quotation_doc(order, "submit")

	doc.flags.ignore_permissions = True
	frappe.flags.ignore_account_permission = True
	doc.save()
	doc.submit()

	return {"name": doc.name, "status": doc.docstatus}
