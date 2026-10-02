"""Delivery priced by the site, added to the sale as one line (Mule City, MuleCity-6nb1).

Why
    A site may charge delivery by its own rule (Mule City: a customer's standing
    charge, else one-way miles from the store banded by the load's weight). XPOS
    must not know that rule, so the site supplies it through hooks, as it names
    its made-to-order items (``xpos_made_to_order_items``). ERPNext skips Shipping
    Rules on POS sales, so the charge rides as an ordinary line: the site's
    delivery item, qty 1, rate = the quote, description = the quote's.

What (site hooks, all optional; with none, XPOS offers no quoted delivery)
    * ``xpos_delivery_policy()`` -> dict: the pricing inputs the till caches to
      price offline (``rate_per_mile``, ``round_to``, ``local_miles``,
      ``local_charge``, ``bands: [{min_lb, pct}]``) and ``item_code``, the
      delivery line's item.
    * ``xpos_delivery_quote(customer, address, weight_lb)`` -> ``{amount (None
      when the clerk must type it), source (exception|standing|miles|none), rule,
      miles, miles_source, band, description}``.
    * ``xpos_delivery_customers(customer_names)`` -> ``{name: {standing_charge,
      no_charge, addresses: [{name, title, address_line1, address_line2, city,
      state, pincode, miles, miles_source, is_primary_address,
      is_shipping_address}]}}``, one batch for the customer search rows the till
      caches offline (the offline picker shows, searches and preselects by
      these, MuleCity-qajl.4).
    * ``xpos_delivery_typed_miles(address_doc, miles)``: record miles a clerk typed
      at the till while offline on a new Address, before it is inserted.
    * ``xpos_walk_in_customers()`` -> [customer]: the site's walk-in accounts,
      besides every POS Profile's default customer (Mule City: Walk-In Customer
      and FilePro's CASH 338). A delivery never goes to them (Bill 2026-10-01
      22:52, MuleCity-qajl): the till hides "Add delivery" and the server
      refuses a sale to them that carries a delivery.
    * ``xpos_add_delivery_address(customer, address_line1, city, state, pincode,
      ...)`` -> the cached address shape plus ``address_display``,
      ``miles_pending`` and ``quote``: add (or find) the customer's delivery
      address at the till; ``xpos.api.customers.add_delivery_address`` calls it.
      Optional ``latitude``/``longitude`` (the point a typeahead pick resolved)
      are passed only when the till has them.
    * ``xpos_address_autocomplete(text, session_token)`` -> ``[{place_id,
      description}]`` and ``xpos_address_resolve(place_id, session_token)`` ->
      ``{address_line1, address_line2, city, county, state, pincode, country,
      latitude, longitude, validated, formatted_address, place_id,
      delivery_miles}``: the add-address form's street typeahead (Mule City:
      address_lookup.autocomplete / resolve, Google Places proxied by the site,
      MuleCity-p644). ``xpos.api.customers.address_autocomplete`` /
      ``address_resolve`` call them; with none, the till types the address.

How
    ``quote_delivery`` weighs the cart as ERPNext weighs a sale (``total_weight
    = weight_per_unit x stock_qty``) so the online quote uses the server's
    weight. An address added while the till was offline arrives with the sale
    (``xpos_new_shipping_address``); ``resolve_new_shipping_address`` makes it,
    once, before the sale is built. A sale priced from miles that were not the
    site's own lookup gets a Comment naming both, for review; its delivery line
    keeps its amount.
"""

import frappe
from frappe import _
from frappe.utils import cint, cstr, flt

POLICY_HOOK = "xpos_delivery_policy"
QUOTE_HOOK = "xpos_delivery_quote"
CUSTOMERS_HOOK = "xpos_delivery_customers"
TYPED_MILES_HOOK = "xpos_delivery_typed_miles"
WALK_IN_HOOK = "xpos_walk_in_customers"
ADD_ADDRESS_HOOK = "xpos_add_delivery_address"
AUTOCOMPLETE_HOOK = "xpos_address_autocomplete"
RESOLVE_HOOK = "xpos_address_resolve"
# Miles the site looked up itself; anything else was typed and is flagged.
LOOKED_UP_MILES = "routes"


def _last_hook(name: str):
	"""The site's implementation of a single-answer hook (the last app wins), or None."""
	methods = frappe.get_hooks(name)
	return frappe.get_attr(methods[-1]) if methods else None


@frappe.whitelist()
def get_delivery_policy() -> dict | None:
	"""The site's delivery policy plus the delivery line's item, or None when the site quotes no delivery."""
	policy_of = _last_hook(POLICY_HOOK)
	if not policy_of or not _last_hook(QUOTE_HOOK):
		return None
	policy = dict(policy_of() or {})
	item = frappe.db.get_value(
		"Item", policy.get("item_code"), ["name", "item_name", "stock_uom", "item_group"], as_dict=True
	)
	if not item:
		return None
	policy["item"] = {
		"item_code": item.name,
		"item_name": item.item_name,
		"stock_uom": item.stock_uom,
		"item_group": item.item_group,
	}
	# Cached with the policy, so the till hides "Add delivery" for them offline too.
	policy["walk_in_customers"] = walk_in_customers()
	return policy


def walk_in_customers() -> list[str]:
	"""Customers a delivery never goes to: every POS Profile's default customer and the site's own."""
	names = set(frappe.get_all("POS Profile", filters={"customer": ["is", "set"]}, pluck="customer"))
	for method in frappe.get_hooks(WALK_IN_HOOK):
		names.update(frappe.get_attr(method)() or [])
	return sorted(name for name in names if name)


def _delivery_item_code() -> str | None:
	policy_of = _last_hook(POLICY_HOOK)
	return (policy_of() or {}).get("item_code") if policy_of else None


def refuse_walk_in_delivery(data: dict) -> None:
	"""A delivery needs a real customer (Bill 2026-10-01 22:52, MuleCity-qajl).

	A sale (or parked tab, or preview) that carries a delivery, i.e. a shipping
	address (chosen or typed offline), delivery miles, or the site's delivery
	line, is refused when it has no customer or is the walk-in account. A day
	alone (``pos_delivery_date``) is not a delivery. Returns are let through: a
	FilePro-era walk-in sale with a delivery line can still be returned.
	"""
	if cint(data.get("is_return")):
		return
	delivery_item = _delivery_item_code()
	facts = [
		data.get("shipping_address_name"),
		data.get("xpos_new_shipping_address"),
		flt(data.get("pos_delivery_miles")) > 0,
		bool(delivery_item) and any((row or {}).get("item_code") == delivery_item for row in data.get("items") or []),
	]
	if not any(facts):
		return
	customer = cstr(data.get("customer")).strip()
	if customer and customer not in walk_in_customers():
		return
	frappe.throw(
		_("Delivery needs a named customer, not {0}. Choose the customer (or add them) before adding delivery.").format(
			customer or _("no customer")
		),
		frappe.ValidationError,
		title=_("No delivery for walk-in sales"),
	)


def cart_weight(items: list[dict], skip_item: str | None = None) -> float:
	"""The load's weight as ERPNext sums it: weight_per_unit x stock qty per line."""
	codes = {row.get("item_code") for row in items if row.get("item_code") and row.get("item_code") != skip_item}
	if not codes:
		return 0.0
	weights = dict(
		frappe.get_all("Item", filters={"name": ["in", list(codes)]}, fields=["name", "weight_per_unit"], as_list=True)
	)
	return sum(
		flt(weights.get(row.get("item_code"))) * flt(row.get("qty")) * (flt(row.get("conversion_factor")) or 1)
		for row in items
		if row.get("item_code") in codes
	)


@frappe.whitelist()
def quote_delivery(customer: str, address: str, items: str | list | None = None) -> dict:
	"""The site's delivery charge for this cart (``items``: item_code, qty, conversion_factor) to one address."""
	quote = _last_hook(QUOTE_HOOK)
	if not quote:
		frappe.throw(_("This site does not quote delivery"))
	items = frappe.parse_json(items) if isinstance(items, str) else (items or [])
	policy_of = _last_hook(POLICY_HOOK)
	delivery_item = (policy_of() or {}).get("item_code") if policy_of else None
	return quote(customer, address, cart_weight(items, delivery_item))


def customer_delivery(customer_names: list[str]) -> dict:
	"""{customer: delivery details} from the site, for the till's customer rows ({} without the hook)."""
	details_of = _last_hook(CUSTOMERS_HOOK)
	if not details_of or not customer_names:
		return {}
	return details_of(list(customer_names)) or {}


@frappe.whitelist()
def get_customer_delivery(customer: str) -> dict | None:
	"""One customer's delivery details, fresh (an address may have been added since the till cached it)."""
	frappe.has_permission("Customer", "read", customer, throw=True)
	return customer_delivery([customer]).get(customer)


def resolve_new_shipping_address(data: dict) -> None:
	"""Make the address a clerk typed at the till while offline, and ship the sale there.

	Called by create_invoice and save_draft_invoice before the sale is built (never
	by preview). A replayed sale finds the address it made the first time: the same
	customer, street and town.
	"""
	refuse_walk_in_delivery(data)
	new = data.get("xpos_new_shipping_address")
	customer = data.get("customer")
	if not new or data.get("shipping_address_name") or not customer:
		return
	line1, city = cstr(new.get("address_line1")).strip(), cstr(new.get("city")).strip()
	if not line1 or not city:
		frappe.throw(_("Street address and city are required to save an address"))
	add = _last_hook(ADD_ADDRESS_HOOK)
	if add and cstr(new.get("state")).strip() and cstr(new.get("pincode")).strip():
		# The till's add-address form (mc23) sends the whole address: made as the
		# till's own add is (normally already replayed before this sale; this is
		# the fallback when that replay did not happen).
		data["shipping_address_name"] = add(**_add_address_args(customer, new))["name"]
		return
	existing = frappe.db.sql(
		"""SELECT a.name FROM `tabAddress` a JOIN `tabDynamic Link` dl ON dl.parent = a.name
		WHERE dl.parenttype = 'Address' AND dl.link_doctype = 'Customer' AND dl.link_name = %(customer)s
		AND a.address_line1 = %(line1)s AND a.city = %(city)s LIMIT 1""",
		{"customer": customer, "line1": line1, "city": city},
	)
	if existing:
		data["shipping_address_name"] = existing[0][0]
		return
	address = frappe.get_doc(
		{
			"doctype": "Address",
			"address_title": customer,
			"address_type": "Shipping",
			"address_line1": line1,
			"address_line2": new.get("address_line2"),
			"city": city,
			"state": new.get("state"),
			"pincode": new.get("pincode"),
			"country": new.get("country") or frappe.db.get_single_value("Global Defaults", "country"),
			"links": [{"link_doctype": "Customer", "link_name": customer}],
		}
	)
	miles = flt(new.get("miles"))
	if miles > 0:
		for method in frappe.get_hooks(TYPED_MILES_HOOK):
			frappe.get_attr(method)(address, miles)
	address.insert(ignore_permissions=True)
	data["shipping_address_name"] = address.name


def _add_address_args(customer: str, new: dict) -> dict:
	"""An address typed offline, as the site's add-address hook takes it (miles flagged manual_offline)."""
	return {
		"customer": customer,
		"address_line1": new.get("address_line1"),
		"city": new.get("city"),
		"state": new.get("state"),
		"pincode": new.get("pincode"),
		"address_line2": new.get("address_line2") or None,
		"title": new.get("title") or None,
		"delivery_miles": flt(new.get("miles")) or None,
		"miles_source": "manual_offline",
		"local_id": new.get("local_id") or None,
		# A point the till resolved from a typeahead pick, when it has one (MuleCity-p644).
		**point_args(new.get("latitude"), new.get("longitude")),
	}


def point_args(latitude, longitude) -> dict:
	"""``{latitude, longitude}`` for the add-address hook, or {} when the till has no point.

	Left out rather than None, so a site hook without these parameters still works.
	"""
	if latitude in (None, "") or longitude in (None, ""):
		return {}
	return {"latitude": flt(latitude), "longitude": flt(longitude)}


def note_typed_miles(invoice_doc, data: dict) -> None:
	"""Flag a sale whose delivery was priced from typed miles: a Comment with the typed and current miles."""
	quote = data.get("xpos_delivery") or {}
	source = quote.get("miles_source")
	if quote.get("source") != "miles" or not source or source == LOOKED_UP_MILES:
		return
	address = invoice_doc.get("shipping_address_name") or quote.get("address")
	details = customer_delivery([invoice_doc.customer]).get(invoice_doc.customer) or {}
	now = next((row.get("miles") for row in details.get("addresses") or [] if row.get("name") == address), None)
	message = _("Delivery priced at the till from {0} mi typed there ({1}) to {2}").format(
		flt(quote.get("miles")), source, address or _("an address")
	)
	if now is not None:
		message += _("; the address now has {0} mi. The sale is not repriced.").format(flt(now))
	# A parked tab saved again (or paid) is flagged once.
	if frappe.db.exists("Comment", {"reference_doctype": invoice_doc.doctype, "reference_name": invoice_doc.name,
			"comment_type": "Comment", "content": message}):
		return
	invoice_doc.add_comment("Comment", message)
