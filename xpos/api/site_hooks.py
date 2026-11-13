# Copyright (c) 2026, Ali Raxa and Contributors
# For license information, please see license.txt

"""Where a site app plugs into the till, and what XPOS does when none does.

XPOS never imports a site app. A site extends the till through these hooks
(declared in its own ``hooks.py``); every one has a stock default here, so XPOS
runs on a plain ERPNext site with no extension installed.

Single-answer hooks use ``last_hook``: the last installed app's function wins
(``apps.txt`` order; when several apps register one, the "xpos" log names the
winner), and ``None`` means "use the default". A site that adds a shared app
registering one of these after its own app must check which it wants. The defaults are *not* registered in
XPOS's own ``hooks.py``: "last app wins" follows ``apps.txt`` order, so a
default registered there could shadow a site's hook.

Server hooks (each value is a list of dotted function paths):

``xpos_apply_taxes(doc) -> None``
    Set the taxes of an invoice the till is building (sale, draft, preview).
    Default: ``xpos.api.party_taxes.apply_party_taxes`` (ERPNext's own party
    resolution: Tax Rule, else the POS Profile's template).
``xpos_preview_cart(doc) -> dict``
    What saving this unsaved invoice would post, without saving it. Default:
    ``preview_cart`` below (savepoint, run the save-time hooks, read, roll back).
``xpos_repeat_lines(doc, price_list) -> list[dict] | None``
    Replace the lines Repeat Invoice puts in the cart. Default: None (the
    lines as sold).
``xpos_order_line_fields -> list[str]`` (field names, not functions; all apps add up)
    Extra invoice line fields the cart sends and a pickup carries (e.g. a
    per-line compliance link).
``xpos_order_line_server_fields -> list[str]`` (field names; all apps add up)
    Sales Order Item fields a pickup's invoice line takes from the order
    itself, whatever the cart sent.
``xpos_customer_fields -> dict`` (last app wins; a function returning the dict)
    The site's Customer fields the till uses, each optional:
    ``search`` (list: also searched, matched exactly and returned),
    ``codes`` (the customer's other codes, shown on the picker row),
    ``since`` (a "customer since" date shown on the row),
    ``tax_exempt_reason`` (a Select field ``create_customer`` may set).
    Default: none. A field the site does not have is ignored.
``xpos_payment_terminal_app -> str`` (an app name, last wins)
    The app that provides the card-reader framework (``<app>.transactions``,
    ``<app>.integrations.erpnext``). Default: ``pay_ng`` or ``payments``,
    whichever is installed.
``xpos_site_extensions() -> dict`` (every app's map is merged, later wins)
    The boot ``xpos_site`` map the SPA reads (see ``site_map``).

The SPA never names a site app either: it reads method names from the boot
``xpos_site`` map (``siteMethod("<key>")``) and calls them as ordinary
whitelisted methods, so each keeps its own permission checks. There is no
server-side "call by key" endpoint: the map only says which existing method a
feature uses; it cannot make a method reachable that was not already.
"""

from __future__ import annotations

import frappe
from frappe.utils import flt

APPLY_TAXES_HOOK = "xpos_apply_taxes"
PREVIEW_CART_HOOK = "xpos_preview_cart"
REPEAT_LINES_HOOK = "xpos_repeat_lines"
ORDER_LINE_FIELDS_HOOK = "xpos_order_line_fields"
ORDER_LINE_SERVER_FIELDS_HOOK = "xpos_order_line_server_fields"
CUSTOMER_FIELDS_HOOK = "xpos_customer_fields"
PAYMENT_TERMINAL_APP_HOOK = "xpos_payment_terminal_app"
SITE_EXTENSIONS_HOOK = "xpos_site_extensions"

# Keys whose stock default is an XPOS method: the till always has one.
SITE_DEFAULTS = {
	"tax_context": "xpos.api.party_taxes.tax_context",
	"tax_contexts": "xpos.api.party_taxes.tax_contexts",
}


def last_hook(name: str):
	"""The site's implementation of a single-answer hook (the last app wins), or None.

	"Last" is ``apps.txt`` order: an app installed after the site's own app that
	registers the same hook replaces it. When more than one app registers one,
	the log says which function won (once per worker), so a shared app installed
	later (e.g. a card reader app registering ``xpos_payment_terminal_app``) never
	replaces the site's choice silently.
	"""
	methods = frappe.get_hooks(name)
	if not methods:
		return None
	if len(methods) > 1:
		_warn_shadowed(name, tuple(methods))
	return frappe.get_attr(methods[-1])


_warned: set[tuple] = set()


def _warn_shadowed(name: str, methods: tuple) -> None:
	"""Log once that several apps answer a single-answer hook and only the last is used."""
	if (name, methods) in _warned:
		return
	_warned.add((name, methods))
	frappe.logger("xpos").warning(
		f"{name}: {len(methods)} apps register it; {methods[-1]} is used (last in apps.txt), "
		f"not {', '.join(methods[:-1])}"
	)


def hook_names(name: str) -> list[str]:
	"""Every value the installed apps give a list hook (field names), in order, once each."""
	return list(dict.fromkeys(value for value in frappe.get_hooks(name) or [] if value))


# --- taxes -----------------------------------------------------------------


def apply_taxes(doc) -> None:
	"""Set the taxes of an invoice the till is building: the site's rule, else ERPNext's."""
	site = last_hook(APPLY_TAXES_HOOK)
	if site:
		site(doc)
		return
	from xpos.api.party_taxes import apply_party_taxes

	apply_party_taxes(doc)


# --- preview ---------------------------------------------------------------

PREVIEW_SAVEPOINT = "xpos_pos_preview"


def preview_cart(doc) -> dict:
	"""What saving this unsaved POS invoice would post: the site's preview, else XPOS's."""
	site = last_hook(PREVIEW_CART_HOOK)
	if site:
		return site(doc)
	return default_preview_cart(doc)


def default_preview_cart(doc) -> dict:
	"""Run the steps a save runs before writing, read the result, roll back.

	``before_insert`` (new ticket), ``before_validate``, ``validate`` and
	``before_save`` run inside a savepoint: every ERPNext and site hook a save
	runs (pricing, taxes, a site's save-time line changes). Nothing is written,
	so no name is taken and no notification is sent. A rule that would refuse
	the save refuses the preview with the same message. Checks done only at
	write (mandatory fields, lengths) are not run; they can still refuse the
	save, which is safe.
	"""
	frappe.has_permission(doc.doctype, "create", throw=True)
	frappe.db.savepoint(PREVIEW_SAVEPOINT)
	try:
		is_new = doc.is_new() or not doc.get("name")
		doc.flags.ignore_permissions = True
		if is_new:
			doc.set("__islocal", True)
			doc._set_defaults()
		doc.set_user_and_timestamp()
		doc.set_docstatus()
		doc.check_if_latest()
		if is_new:
			doc.run_method("before_insert")
		doc.set_parent_in_children()
		doc.run_before_save_methods()
		return preview_summary(doc)
	finally:
		frappe.db.rollback(save_point=PREVIEW_SAVEPOINT)


def preview_summary(doc) -> dict:
	"""The lines and totals the register shows and charges for a previewed invoice."""
	return {
		"items": [
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"description": row.description,
				"qty": row.qty,
				"uom": row.uom,
				"stock_qty": row.stock_qty,
				"rate": row.rate,
				"amount": row.amount,
				"warehouse": row.warehouse,
			}
			for row in doc.items
		],
		"taxes": [
			{"description": row.description, "rate": row.rate, "tax_amount": row.tax_amount}
			for row in doc.taxes
		],
		"net_total": doc.net_total,
		"total_taxes_and_charges": doc.total_taxes_and_charges,
		"grand_total": doc.grand_total,
		"rounded_total": doc.rounded_total,
		# What the register must collect: an order picked up with an advance owes the rest.
		"total_advance": flt(doc.get("total_advance")),
		"amount_due": flt((doc.rounded_total or doc.grand_total) - flt(doc.get("total_advance")), 2),
	}


# --- repeat ----------------------------------------------------------------


def repeat_lines(doc, price_list):
	"""The site's lines for repeating *doc* (e.g. one made-to-order line), or None."""
	site = last_hook(REPEAT_LINES_HOOK)
	return site(doc, price_list) if site else None


# --- fields ----------------------------------------------------------------


def order_line_fields() -> tuple[str, ...]:
	"""Sales Order Item fields carried onto a pickup's invoice lines (site fields only)."""
	return tuple(hook_names(ORDER_LINE_FIELDS_HOOK))


def order_line_server_fields() -> tuple[str, ...]:
	"""Sales Order Item fields the order row is the authority for on a pickup's line."""
	return tuple(hook_names(ORDER_LINE_SERVER_FIELDS_HOOK))


def customer_fields() -> dict:
	"""The site's Customer fields for the till (``xpos_customer_fields``), only real ones.

	``{"search": [...], "codes": str|None, "since": str|None, "tax_exempt_reason": str|None}``.
	"""
	site = last_hook(CUSTOMER_FIELDS_HOOK)
	config = (site() if site else None) or {}
	meta = frappe.get_meta("Customer")

	def real(field):
		return field if field and meta.has_field(field) else None

	return {
		"search": [field for field in config.get("search") or [] if real(field)],
		"codes": real(config.get("codes")),
		"since": real(config.get("since")),
		"tax_exempt_reason": real(config.get("tax_exempt_reason")),
	}


# --- card reader -----------------------------------------------------------


def payment_terminal_app() -> str | None:
	"""The installed app that provides the card-reader framework, or None."""
	installed = frappe.get_installed_apps()
	chosen = frappe.get_hooks(PAYMENT_TERMINAL_APP_HOOK) or []
	if len(chosen) > 1:
		_warn_shadowed(PAYMENT_TERMINAL_APP_HOOK, tuple(chosen))
	for app in reversed(chosen):
		if app in installed:
			return app
	if chosen:
		return None
	for app in ("pay_ng", "payments"):
		if app in installed:
			return app
	return None


# --- the SPA's map ---------------------------------------------------------


def site_map() -> dict:
	"""The boot ``xpos_site`` map: feature flags and the whitelisted method each feature calls.

	Every ``xpos_site_extensions`` function returns a dict; they are merged in
	app order. Values are a dotted method path (str), a flag (bool / int), a
	list of field names, or a nested dict of those (``{"mix": {"quote": "..."}}``). XPOS's own defaults
	(``SITE_DEFAULTS``) are filled in where no site set the key.

	The merge is one level deep: a later app's top-level key replaces an earlier
	app's, and a later app's nested dict is merged key by key into an earlier
	one's, but anything deeper is replaced whole.

	An extension that raises is logged and left out; its path is listed in
	``extension_errors`` so the till knows the map is incomplete (a site app that
	wants one broken flag not to drop its other features registers them as
	separate functions).
	"""
	merged: dict = {}
	failed: list[str] = []
	for path in frappe.get_hooks(SITE_EXTENSIONS_HOOK) or []:
		try:
			extra = frappe.get_attr(path)() or {}
		except Exception:  # noqa: BLE001 - one app's broken extension must not break every login
			frappe.log_error(title="XPOS site extension failed", message=frappe.get_traceback())
			# The till then knows its map is incomplete: a feature that is off may only be
			# unknown, and a safety check it ran before keeps running (vfdOffline.ts).
			failed.append(path)
			continue
		for key, value in extra.items():
			if isinstance(value, dict) and isinstance(merged.get(key), dict):
				merged[key] = {**merged[key], **value}
			else:
				merged[key] = value
	for key, method in SITE_DEFAULTS.items():
		merged.setdefault(key, method)
	if failed:
		merged["extension_errors"] = failed
	# The picker shows and matches the site's customer codes field (xpos_customer_fields).
	codes = customer_fields()["codes"]
	if codes:
		merged.setdefault("customer_codes_field", codes)
	return _clean(merged)


def _clean(value):
	"""Only strings, numbers, booleans, and lists and dicts of them reach the boot."""
	if isinstance(value, dict):
		return {str(k): _clean(v) for k, v in value.items() if _allowed(v)}
	if isinstance(value, (list, tuple)):
		return [_clean(v) for v in value if _allowed(v)]
	return value


def _allowed(value) -> bool:
	return isinstance(value, (str, bool, int, float, dict, list, tuple)) or value is None
