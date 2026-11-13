# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Fixtures for test_record_access, from upstream's test_profile_settings_hardening.

Upstream keeps these helpers in its profile-settings hardening tests (v2.11+),
which the fork does not carry; only what test_record_access needs is here
(MuleCity-0bsc).
"""

import frappe

COMPANY = "_Test Company"
PRICE_LIST = "_Test Price List"


def ensure(doctype, name, values):
	if not frappe.db.exists(doctype, name):
		frappe.get_doc({"doctype": doctype, **values}).insert(ignore_permissions=True)


def ensure_user(email, roles):
	if not frappe.db.exists("User", email):
		user = frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": email.split("@")[0], "send_welcome_email": 0}
		)
		user.insert(ignore_permissions=True)
	user = frappe.get_doc("User", email)
	user.add_roles(*roles)


def make_profile(name, warehouse="_Test Warehouse - _TC", users=(), **settings):
	"""A POS Profile without ERPNext's make_pos_profile, which deletes every other profile."""
	if frappe.db.exists("POS Profile", name):
		frappe.delete_doc("POS Profile", name, force=True, ignore_permissions=True)
	if not frappe.db.get_value("Mode of Payment Account", {"company": COMPANY, "parent": "Cash"}):
		cash = frappe.get_doc("Mode of Payment", "Cash")
		cash.append("accounts", {"company": COMPANY, "default_account": "Cash - _TC"})
		cash.save(ignore_permissions=True)
	pos = frappe.get_doc(
		{
			"doctype": "POS Profile",
			"name": name,
			"company": COMPANY,
			"currency": "INR",
			"cost_center": "_Test Cost Center - _TC",
			"income_account": "Sales - _TC",
			"expense_account": "_Test Account Cost for Goods Sold - _TC",
			"write_off_account": "_Test Write Off - _TC",
			"write_off_cost_center": "_Test Write Off Cost Center - _TC",
			"selling_price_list": PRICE_LIST,
			"warehouse": warehouse,
			"update_stock": 0,
			"payments": [{"mode_of_payment": "Cash", "default": 1}],
			"applicable_for_users": [{"user": "Administrator"}]
			+ [{"user": user, "pos_role": role, "discount_limit": limit} for user, role, limit in users],
			"allow_zero_rated_items": 0,
			"max_discount_percentage_allowed": 50,
		}
	)
	pos.update(settings)
	pos.flags.ignore_mandatory = True
	pos.insert(ignore_permissions=True)
	frappe.clear_cache(doctype="POS Profile")
	return pos


def setup_fixtures():
	frappe.db.set_single_value("POS Settings", "invoice_type", "Sales Invoice")
