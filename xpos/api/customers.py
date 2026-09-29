# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import json
import re

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, today

from xpos.api.profiles import resolve_pos_profile
from xpos.utils import row_value


# Columns get_customers always returns; search fields add to these.
_CUSTOMER_LIST_COLUMNS = (
	"name",
	"customer_name",
	"mobile_no",
	"email_id",
	"customer_group",
	"territory",
	"default_currency",
	"image",
	"tax_id",
	"customer_type",
	"gender",
	# The till taxes a customer offline by their category (Mule City, MuleCity-ispl).
	"tax_category",
)
# Shown on the picker row already, so left out of the description.
_SHOWN_ON_ROW = ("name", "customer_name", "mobile_no", "email_id", "mule_filepro_alias_codes")
_SEARCHABLE_TYPES = ("Data", "Link", "Select", "Small Text", "Phone", "Read Only")


def _customer_search_fields() -> list[str]:
	"""Customer's configured search_fields that are real, text-like columns.

	Only names the DocType's own meta vouches for reach the SQL, so a stale or
	odd entry in the setting is skipped rather than breaking the search.
	"""
	meta = frappe.get_meta("Customer")
	configured = meta.search_fields
	if not isinstance(configured, str):
		return []
	fields = []
	for fieldname in (f.strip() for f in configured.split(",")):
		df = meta.get_field(fieldname) if fieldname else None
		if df and df.fieldtype in _SEARCHABLE_TYPES and fieldname not in fields:
			fields.append(fieldname)
	return fields


def _search_description(customer: dict, fields: list[str]) -> str:
	"""The search-field values desk shows under a customer, in configured order."""
	# Search configuration is broader than useful counter identification.
	seen = {str(customer.get(f) or "").casefold() for f in _SHOWN_ON_ROW}
	values = []
	for field in fields:
		value = str(customer.get(field) or "").strip()
		if field in (*_SHOWN_ON_ROW, "customer_group", "territory", "primary_address") or not value or value.casefold() in seen:
			continue
		seen.add(value.casefold())
		values.append(value)
	return ", ".join(values)


@frappe.whitelist()
def get_customers(
	search_term: str = "", limit: int = 20, pos_profile: str = None, preload: int = 0, with_metadata: int = 0
):
	"""Search customers by name, mobile, email, tax ID, or Customer's search fields.

	The Customer DocType's standard ``search_fields`` (Customize Form) are searched
	and shown too, as desk's customer dropdown does, so a site can make any code
	that tells same-named customers apart findable and visible. A customer whose
	ID or search-field value equals the term exactly is listed first.

	If a POS Profile is provided, respects customer group restrictions.
	"""
	extra_fields = _customer_search_fields()
	meta = frappe.get_meta("Customer")
	# Mule's business classification is independent of ERPNext Company/Individual.
	if meta.has_field("mule_customer_kind") and "mule_customer_kind" not in extra_fields:
		extra_fields.append("mule_customer_kind")
	conditions = "c.disabled = 0"
	values = {"limit": max(1, min(cint(limit), 100000))}
	order_by = "c.customer_name ASC, c.name ASC"
	join = ""
	limit_sql = "LIMIT %(limit)s"
	if pos_profile:
		profile = frappe.get_cached_doc("POS Profile", pos_profile)
		if cint(preload):
			configured = profile.get("xpos_customer_preload_limit")
			values["limit"] = max(0, cint(configured if configured is not None else 5000))
			if not values["limit"]:
				limit_sql = ""
		ranking = profile.get("xpos_customer_order") or "Alphabetical"
		metrics = {
			"Most Recent Purchase": "last_purchase",
			"Most Revenue": "revenue",
			"Most Transactions": "transactions",
		}
		if isinstance(ranking, str) and ranking in metrics:
			# Count original POS tickets, not their consolidated Sales Invoice a second time.
			join = """LEFT JOIN (
				SELECT customer,
				MAX(CASE WHEN is_return = 0 THEN TIMESTAMP(posting_date, posting_time) END) AS last_purchase,
				SUM(base_net_total) AS revenue,
				SUM(CASE WHEN is_return = 0 THEN 1 ELSE 0 END) AS transactions
				FROM (
				 SELECT customer, posting_date, posting_time, is_return, base_net_total
				 FROM `tabSales Invoice` WHERE docstatus = 1 AND company = %(company)s AND IFNULL(is_consolidated, 0) = 0
				 UNION ALL
				 SELECT customer, posting_date, posting_time, is_return, base_net_total
				 FROM `tabPOS Invoice` WHERE docstatus = 1 AND company = %(company)s
				) sales GROUP BY customer
			) history ON history.customer = c.name"""
			values["company"] = profile.company
			order_by = f"history.{metrics[ranking]} DESC, {order_by}"

	if pos_profile:
		try:
			pos = frappe.get_cached_doc("POS Profile", pos_profile)
			customer_groups = pos.get("customer_groups")
			if customer_groups:
				allowed_groups = []
				for cg in customer_groups:
					group_name = row_value(cg, "customer_group")
					if group_name:
						allowed_groups.extend(_get_child_groups("Customer Group", group_name))
				if allowed_groups:
					allowed_groups = list(set(allowed_groups))
					group_params = {}
					for idx, g in enumerate(allowed_groups):
						group_params[f"grp_{idx}"] = g
					in_clause = ", ".join([f"%(grp_{i})s" for i in range(len(allowed_groups))])
					conditions += f" AND c.customer_group IN ({in_clause})"
					values.update(group_params)
		except Exception:
			pass

	if search_term:
		search_term = search_term.strip()
		phone_condition = ""
		phone_digits = re.sub(r"\D", "", search_term)
		if len(phone_digits) >= 4:
			# Imported phones live on Contacts, not necessarily Customer.mobile_no.
			phone_condition = """ OR
			 REGEXP_REPLACE(IFNULL(c.mobile_no, ''), '[^0-9]', '') LIKE %(phone)s
			 OR EXISTS (
			 SELECT 1 FROM `tabDynamic Link` dl
			 JOIN `tabContact Phone` cp ON cp.parent = dl.parent
			 WHERE dl.parenttype = 'Contact' AND dl.link_doctype = 'Customer'
			 AND dl.link_name = c.name
			 AND REGEXP_REPLACE(cp.phone, '[^0-9]', '') LIKE %(phone)s
			 )"""
			values["phone"] = f"%{phone_digits}%"
		conditions += """ AND (
			c.name LIKE %(search)s
			OR c.customer_name LIKE %(search)s
			OR c.mobile_no LIKE %(search)s
			OR c.email_id LIKE %(search)s
			OR c.tax_id LIKE %(search)s
			{extra_like}
			{phone_condition}
		)""".format(
			extra_like="".join(f" OR c.`{f}` LIKE %(search)s" for f in extra_fields),
			phone_condition=phone_condition,
		)
		values["search"] = f"%{search_term}%"
		# Exact hits first: typing a short code must not bury that customer under
		# every phone number or ID that merely contains it.
		exact = " OR ".join(f"c.`{f}` = %(exact)s" for f in ("name", "customer_name", *extra_fields))
		order_by = f"CASE WHEN {exact} THEN 0 ELSE 1 END, {order_by}"
		values["exact"] = search_term

	extra_columns = "".join(f", c.`{f}`" for f in extra_fields if f not in _CUSTOMER_LIST_COLUMNS)
	# Preserve the historical relationship date; ERP import creation is not tenure.
	if meta.has_field("mule_customer_since"):
		extra_columns += ", c.mule_customer_since AS xpos_customer_since"
	selected_limit = values["limit"]
	if cint(with_metadata) and limit_sql:
		values["limit"] += 1  # One extra row distinguishes a full selection from a capped one.
	# Every _CUSTOMER_LIST_COLUMNS name is selected: listing a column there
	# without selecting it left tax_category off the synced rows (MuleCity-ispl).
	list_columns = ", ".join(f"c.`{column}`" for column in _CUSTOMER_LIST_COLUMNS)
	customers = frappe.db.sql(  # nosemgrep: frappe-sql-format-injection — conditions built from validated allowed-field lists, values parameterized
		f"""
		SELECT
			{list_columns}
			{extra_columns}
		FROM `tabCustomer` c
		{join}
		WHERE {conditions}
		ORDER BY {order_by}
		{limit_sql}
		""",
		values,
		as_dict=True,
	)
	_enrich_picker_customers(customers, profile.company if pos_profile else None)
	for customer in customers:
		customer["xpos_search_description"] = _search_description(customer, extra_fields)

	if cint(with_metadata):
		complete = not limit_sql or len(customers) <= selected_limit
		return {"customers": customers if complete else customers[:selected_limit], "complete": complete}
	return customers


def _enrich_picker_customers(customers, company):
	"""Batch row context; never issue a query for every customer in the picker."""
	if not customers:
		return
	by_name = {row["name"]: row for row in customers}
	phones = frappe.db.sql("""
		SELECT DISTINCT dl.link_name, cp.phone
		FROM `tabDynamic Link` dl
		JOIN `tabContact Phone` cp ON cp.parent = dl.parent
		WHERE dl.parenttype = 'Contact' AND dl.link_doctype = 'Customer'
		AND dl.link_name IN %(names)s
		ORDER BY dl.link_name, cp.is_primary_mobile_no DESC, cp.idx, cp.phone
	""", {"names": list(by_name)}, as_dict=True)
	for phone in phones:
		row = by_name[phone["link_name"]]
		row.setdefault("xpos_phone_numbers", []).append(phone["phone"])
		if not row.get("mobile_no"):
			row["mobile_no"] = phone["phone"]
	# Linked profile records are the authority for imported contact completeness.
	profiles = frappe.db.sql("""
		SELECT c.name,
		EXISTS (SELECT 1 FROM `tabDynamic Link` dl
		 JOIN `tabAddress` a ON a.name = dl.parent
		 WHERE dl.link_doctype = 'Customer' AND dl.link_name = c.name
		 AND dl.parenttype = 'Address' AND IFNULL(a.disabled, 0) = 0
		 AND TRIM(IFNULL(a.address_line1, '')) != '') AS has_address,
		EXISTS (SELECT 1 FROM `tabDynamic Link` dl
		 JOIN `tabContact Email` ce ON ce.parent = dl.parent
		 WHERE dl.link_doctype = 'Customer' AND dl.link_name = c.name
		 AND dl.parenttype = 'Contact'
		 AND TRIM(IFNULL(ce.email_id, '')) != '') AS has_email
		FROM `tabCustomer` c WHERE c.name IN %(names)s
	""", {"names": list(by_name)}, as_dict=True)
	for profile in profiles:
		row = by_name[profile["name"]]
		row["xpos_has_address"] = bool(profile["has_address"])
		row["xpos_has_email"] = bool(profile["has_email"] or str(row.get("email_id") or "").strip())
		row["xpos_has_phone"] = bool(str(row.get("mobile_no") or "").strip())
	if not company:
		return
	# Use permission-aware reads and company currency; returns reduce net sales.
	# Exclude consolidated Sales Invoices to avoid counting POS tickets twice.
	if not all(frappe.has_permission(dt, "read") for dt in ("Sales Invoice", "POS Invoice")):
		return
	currency = frappe.get_cached_value("Company", company, "default_currency")
	for row in customers:
		row.update(xpos_sales_12mo=0, xpos_sales_currency=currency)
	for doctype in ("Sales Invoice", "POS Invoice"):
		filters = {"customer": ["in", list(by_name)], "company": company,
			"docstatus": 1, "posting_date": ["between", [add_months(today(), -12), today()]]}
		if doctype == "Sales Invoice":
			filters["is_consolidated"] = 0
		for sale in frappe.get_list(doctype, filters=filters,
			fields=["customer", {"SUM": "base_net_total", "as": "sales"}], group_by="customer", limit_page_length=0):
			by_name[sale["customer"]]["xpos_sales_12mo"] += flt(sale["sales"])


@frappe.whitelist()
def get_customer_info(customer: str):
	"""
	Get detailed customer information including loyalty, addresses, balance, credit, and discount.
	"""
	if not customer:
		return None

	cust = frappe.get_cached_doc("Customer", customer)
	balance = get_customer_balance(customer)
	loyalty = get_loyalty_points(customer)

	addresses = frappe.get_all(
		"Dynamic Link",
		filters={
			"link_doctype": "Customer",
			"link_name": customer,
			"parenttype": "Address",
		},
		fields=["parent"],
	)
	address_names = [row_value(addr, "parent") for addr in addresses if row_value(addr, "parent")]
	address_list = []
	if address_names:
		address_docs = frappe.get_all(
			"Address",
			filters={"name": ["in", address_names]},
			fields=[
				"name",
				"address_title",
				"address_line1",
				"address_line2",
				"city",
				"state",
				"country",
				"pincode",
				"phone",
				"is_primary_address",
				"is_shipping_address",
			],
		)
		for a in address_docs:
			address_list.append(
				{
					"name": a.name,
					"address_title": a.address_title,
					"address_line1": a.address_line1,
					"address_line2": a.address_line2,
					"city": a.city,
					"state": a.state,
					"country": a.country,
					"pincode": a.pincode,
					"phone": a.phone,
					"is_primary_address": a.is_primary_address,
					"is_shipping_address": a.get("is_shipping_address", 0),
				}
			)

	pos_discount = flt(getattr(cust, "discount", 0))

	default_price_list = cust.default_price_list

	loyalty_program = None
	loyalty_program_name = cust.loyalty_program
	if loyalty_program_name:
		try:
			from erpnext.accounts.doctype.loyalty_program.loyalty_program import (
				get_loyalty_program_details_with_points,
			)

			lp_details = get_loyalty_program_details_with_points(customer, loyalty_program_name)
			loyalty_program = {
				"name": loyalty_program_name,
				"loyalty_points": (lp_details.get("loyalty_points", 0) if lp_details else 0),
				"conversion_factor": (lp_details.get("conversion_factor", 0) if lp_details else 0),
			}
		except Exception:
			loyalty_program = {
				"name": loyalty_program_name,
				"loyalty_points": loyalty,
				"conversion_factor": 0,
			}

	referral_code = getattr(cust, "referral_code", None)
	birthday = getattr(cust, "birthday", None)

	credit_limit = 0
	from erpnext.selling.doctype.customer.customer import get_credit_limit

	credit_limit = flt(get_credit_limit(customer, frappe.defaults.get_user_default("Company")))

	return {
		"name": cust.name,
		"customer_name": cust.customer_name,
		"mobile_no": cust.mobile_no,
		"email_id": cust.email_id,
		"customer_group": cust.customer_group,
		"territory": cust.territory,
		"default_currency": cust.default_currency,
		"default_price_list": default_price_list,
		"image": cust.image,
		"tax_id": cust.tax_id,
		"customer_type": cust.customer_type,
		"gender": getattr(cust, "gender", None),
		"balance": balance,
		"credit_limit": credit_limit,
		"loyalty_points": loyalty,
		"loyalty_program": loyalty_program,
		"discount": pos_discount,
		"referral_code": referral_code,
		"birthday": birthday,
		"addresses": address_list,
	}


# Mule City (mulecity_erpnext): why a customer is tax-exempt. Picking it sets
# the customer's Tax Category in that app's Customer validate. Sites without the
# field never see or accept it.
TAX_EXEMPT_REASON_FIELD = "mule_tax_exempt_reason"


def customer_tax_exempt_reasons() -> list[str]:
	"""The reasons this user may give a new customer, from the Customer field.

	Empty when the site has no such field, or when the field's permission level
	is one this user may not write (the desk form would drop their value too).
	"""
	meta = frappe.get_meta("Customer")
	df = meta.get_field(TAX_EXEMPT_REASON_FIELD)
	if not df or df.fieldtype != "Select" or df.permlevel not in meta.get_permlevel_access("write"):
		return []
	return [option for option in (df.options or "").split("\n") if option.strip()]


@frappe.whitelist()
def create_customer(
	customer_name: str,
	mobile_no: str = "",
	email_id: str = "",
	customer_group: str = None,
	territory: str = None,
	customer_type: str = "Individual",
	gender: str = None,
	tax_id: str = None,
	referral_code: str = None,
	birthday: str = None,
	company: str = None,
	pos_profile: str = None,
	address_line1: str = None,
	city: str = None,
	country: str = None,
	address_line2: str = None,
	state: str = None,
	pincode: str = None,
	mule_tax_exempt_reason: str = None,
):
	"""
	Create a new customer with optional address.
	"""
	if not customer_name:
		frappe.throw(_("Customer name is required"))

	# Validate before inserting the customer so a partial address is never lost.
	if any((address_line1, address_line2, city, state, pincode)) and not (
		(address_line1 or "").strip() and (city or "").strip()
	):
		frappe.throw(_("Street address and city are required to save an address"))

	if mule_tax_exempt_reason and mule_tax_exempt_reason not in customer_tax_exempt_reasons():
		frappe.throw(_("{0} is not a tax exemption reason you can set here").format(mule_tax_exempt_reason))

	if not customer_group:
		customer_group = (
			frappe.db.get_single_value("Selling Settings", "customer_group") or "All Customer Groups"
		)

	if not territory:
		territory = frappe.db.get_single_value("Selling Settings", "territory") or "All Territories"

	customer = frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": customer_name,
			"customer_type": customer_type or "Individual",
			"customer_group": customer_group,
			"territory": territory,
			"mobile_no": mobile_no,
			"email_id": email_id,
		}
	)

	# The insert below runs the Customer's normal validation, which sets the
	# Tax Category from the reason.
	if mule_tax_exempt_reason:
		customer.set(TAX_EXEMPT_REASON_FIELD, mule_tax_exempt_reason)

	if tax_id:
		customer.tax_id = tax_id
	if gender:
		customer.gender = gender
	if referral_code:
		try:
			customer.referral_code = referral_code
		except Exception:
			pass
	if birthday:
		try:
			customer.birthday = birthday
		except Exception:
			pass
	if company:
		customer.company = company

	customer.insert(ignore_permissions=True)

	if address_line1 and city:
		make_address(
			{
				"customer": customer.name,
				"address_line1": address_line1,
				"address_line2": address_line2,
				"state": state,
				"pincode": pincode,
				"city": city,
				"country": country or frappe.db.get_single_value("Global Defaults", "country"),
				"is_primary_address": 1,
			}
		)

	return {
		"name": customer.name,
		"customer_name": customer.customer_name,
		"mobile_no": customer.mobile_no,
		"email_id": customer.email_id,
		"customer_group": customer.customer_group,
		"territory": customer.territory,
	}


@frappe.whitelist()
def update_customer(customer: str, data: str | dict):
	"""
	Update an existing customer.
	"""
	if isinstance(data, str):
		data = json.loads(data)

	doc = frappe.get_doc("Customer", customer)

	updatable_fields = [
		"customer_name",
		"mobile_no",
		"email_id",
		"customer_group",
		"territory",
		"customer_type",
		"gender",
		"tax_id",
	]

	for field in updatable_fields:
		if field in data:
			doc.set(field, data[field])

	pos_fields = ["referral_code", "birthday", "discount"]
	for field in pos_fields:
		if field in data:
			try:
				doc.set(field, data[field])
			except Exception:
				pass

	doc.save(ignore_permissions=True)

	return {
		"name": doc.name,
		"customer_name": doc.customer_name,
		"mobile_no": doc.mobile_no,
		"email_id": doc.email_id,
	}


@frappe.whitelist()
def get_customer_addresses(customer: str):
	"""
	List all addresses for a customer.
	"""
	if not customer:
		return []

	links = frappe.get_all(
		"Dynamic Link",
		filters={
			"link_doctype": "Customer",
			"link_name": customer,
			"parenttype": "Address",
		},
		fields=["parent"],
	)

	address_names = [link.parent for link in links if link.parent]
	if not address_names:
		return []

	address_docs = frappe.get_all(
		"Address",
		filters={"name": ["in", address_names]},
		fields=[
			"name",
			"address_title",
			"address_line1",
			"address_line2",
			"city",
			"state",
			"country",
			"pincode",
			"phone",
			"is_primary_address",
			"is_shipping_address",
		],
	)

	addresses = []
	for a in address_docs:
		addresses.append(
			{
				"name": a.name,
				"address_title": a.address_title,
				"address_line1": a.address_line1,
				"address_line2": a.address_line2,
				"city": a.city,
				"state": a.state,
				"country": a.country,
				"pincode": a.pincode,
				"phone": a.phone,
				"is_primary_address": a.is_primary_address,
				"is_shipping_address": a.get("is_shipping_address", 0),
			}
		)

	return addresses


@frappe.whitelist()  # nosemgrep: overusing-args — args is a JSON-encoded dict from the client, standard Frappe pattern
def make_address(args: str | dict):
	"""
	Create a new address linked to a customer.
	"""
	if isinstance(args, str):
		args = json.loads(args)

	customer = args.get("customer")
	if not customer:
		frappe.throw(_("Customer is required to create an address"))

	address = frappe.get_doc(
		{
			"doctype": "Address",
			"address_title": args.get("address_title") or customer,
			"address_line1": args.get("address_line1"),
			"address_line2": args.get("address_line2"),
			"city": args.get("city"),
			"state": args.get("state"),
			"country": args.get("country") or frappe.db.get_single_value("Global Defaults", "country"),
			"pincode": args.get("pincode"),
			"phone": args.get("phone"),
			"is_primary_address": cint(args.get("is_primary_address", 0)),
			"is_shipping_address": cint(args.get("is_shipping_address", 0)),
		}
	)

	address.append(
		"links",
		{
			"link_doctype": "Customer",
			"link_name": customer,
		},
	)

	address.insert(ignore_permissions=True)

	return {
		"name": address.name,
		"address_title": address.address_title,
		"address_line1": address.address_line1,
		"city": address.city,
	}


@frappe.whitelist()
def get_customer_credit(customer: str, company: str):
	"""
	Return all available credit (outstanding returns + unallocated advances) for a customer.
	"""
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


def get_allowed_sales_persons(pos_profile: str | None = None) -> list[str]:
	"""Sales Person names allow-listed on the POS Profile."""
	profile = resolve_pos_profile(pos_profile)
	return [
		name
		for name in (row_value(row, "sales_person") for row in profile.get("allowed_sales_persons") or [])
		if name
	]


@frappe.whitelist()
def sales_person_query(
	doctype: str, txt: str, searchfield: str, start: int, page_len: int, filters: dict | str, **kwargs
):
	"""Link query behind the POS sales person field."""
	filters = filters or {}
	if isinstance(filters, str):
		filters = json.loads(filters)
	pos_profile = filters.get("pos_profile") if isinstance(filters, dict) else None

	allowed = get_allowed_sales_persons(pos_profile)
	if not allowed:
		return []

	txt = (txt or "").strip()
	return frappe.get_all(
		"Sales Person",
		filters={"enabled": 1, "name": ["in", allowed]},
		or_filters=(
			{"name": ["like", f"%{txt}%"], "sales_person_name": ["like", f"%{txt}%"]} if txt else None
		),
		fields=["name"],
		order_by="name asc",
		offset=cint(start),
		limit=cint(page_len) or 20,
		as_list=True,
	)


@frappe.whitelist()
def get_sales_person_names(pos_profile: str | None = None):
	"""Enabled sales persons allowed for the given POS Profile."""
	allowed = get_allowed_sales_persons(pos_profile)
	if not allowed:
		return []

	return frappe.get_all(
		"Sales Person",
		filters={"enabled": 1, "name": ["in", allowed]},
		fields=["name", "sales_person_name"],
		order_by="name asc",
	)


def get_customer_balance(customer: str):
	"""Get outstanding balance for a customer."""
	balance = frappe.db.sql(
		"""
		SELECT SUM(debit - credit) AS balance
		FROM `tabGL Entry`
		WHERE party_type = 'Customer' AND party = %(customer)s AND docstatus = 1
		""",
		{"customer": customer},
		as_dict=True,
	)
	if not balance:
		return 0

	first_row = balance[0]
	if isinstance(first_row, dict):
		return flt(first_row.get("balance", 0))
	if isinstance(first_row, (list, tuple)) and first_row:
		return flt(first_row[0])
	return flt(first_row or 0)


def get_loyalty_points(customer: str):
	"""Get loyalty points balance for a customer."""
	try:
		points = frappe.db.sql(
			"""
			SELECT SUM(loyalty_points) AS points
			FROM `tabLoyalty Point Entry`
			WHERE customer = %(customer)s AND expiry_date >= CURDATE()
			""",
			{"customer": customer},
			as_dict=True,
		)
		return flt(points[0].get("points", 0)) if points else 0
	except Exception:
		return 0


@frappe.whitelist()
def get_loyalty_programs(company: str = None):
	"""Get all active loyalty programs for the given company."""
	filters = {}
	if company:
		filters["company"] = company

	programs = frappe.get_all(
		"Loyalty Program",
		filters=filters,
		fields=[
			"name",
			"loyalty_program_name",
			"company",
			"conversion_factor",
			"expiry_duration",
		],
		order_by="loyalty_program_name asc",
	)

	# Get tiers for each program
	for program in programs:
		tiers = frappe.get_all(
			"Loyalty Program Collection",
			filters={"parent": program["name"]},
			fields=["tier_name", "min_spent", "collection_factor"],
			order_by="min_spent asc",
		)
		program["tiers"] = tiers

	return programs


@frappe.whitelist()
def register_customer_loyalty(customer: str, loyalty_program: str):
	"""Register a customer for a loyalty program.

	Args:
	            customer: Customer name/ID
	            loyalty_program: Loyalty Program name

	Returns:
	        Updated customer info with loyalty details
	"""
	if not customer:
		frappe.throw(_("Customer is required"))
	if not loyalty_program:
		frappe.throw(_("Loyalty Program is required"))

	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer))

	if not frappe.db.exists("Loyalty Program", loyalty_program):
		frappe.throw(_("Loyalty Program {0} not found").format(loyalty_program))

	cust_doc = frappe.get_doc("Customer", customer)

	if cust_doc.loyalty_program:
		if cust_doc.loyalty_program == loyalty_program:
			frappe.throw(_("Customer is already enrolled in {0}").format(loyalty_program))
		else:
			frappe.throw(
				_(
					"Customer is already enrolled in {0}. Please unenroll from the current program first."
				).format(cust_doc.loyalty_program)
			)

	cust_doc.loyalty_program = loyalty_program
	cust_doc.loyalty_program_tier = None
	cust_doc.save(ignore_permissions=True)

	lp = frappe.get_cached_doc("Loyalty Program", loyalty_program)

	return {
		"name": cust_doc.name,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": loyalty_program,
		"loyalty_program_name": lp.loyalty_program_name or loyalty_program,
		"conversion_factor": lp.conversion_factor,
		"loyalty_points": 0,
		"message": _("Successfully enrolled {0} in {1}").format(
			cust_doc.customer_name, lp.loyalty_program_name or loyalty_program
		),
	}


@frappe.whitelist()
def unenroll_customer_loyalty(customer: str):
	"""Remove a customer from their loyalty program.

	Args:
	    customer: Customer name/ID

	Returns:
	    Updated customer info
	"""
	if not customer:
		frappe.throw(_("Customer is required"))

	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer))

	cust_doc = frappe.get_doc("Customer", customer)

	if not cust_doc.loyalty_program:
		frappe.throw(_("Customer is not enrolled in any loyalty program"))

	old_program = cust_doc.loyalty_program
	cust_doc.loyalty_program = None
	cust_doc.loyalty_program_tier = None
	cust_doc.save(ignore_permissions=True)

	return {
		"name": cust_doc.name,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": None,
		"message": _("Successfully unenrolled {0} from {1}").format(cust_doc.customer_name, old_program),
	}


@frappe.whitelist()
def get_customer_loyalty_info(customer: str):
	"""Get detailed loyalty information for a customer.

	Args:
	    customer: Customer name/ID

	Returns:
	    Loyalty program details, points balance, and tier info
	"""
	if not customer:
		return None

	if not frappe.db.exists("Customer", customer):
		return None

	cust_doc = frappe.get_cached_doc("Customer", customer)

	if not cust_doc.loyalty_program:
		return {
			"enrolled": False,
			"customer": customer,
			"customer_name": cust_doc.customer_name,
			"loyalty_program": None,
		}

	lp = frappe.get_cached_doc("Loyalty Program", cust_doc.loyalty_program)

	points = get_loyalty_points(customer)

	conversion_factor = flt(lp.conversion_factor) or 1
	points_value = flt(points) * conversion_factor if conversion_factor else 0

	current_tier = cust_doc.loyalty_program_tier

	tiers = frappe.get_all(
		"Loyalty Program Collection",
		filters={"parent": lp.name},
		fields=["tier_name", "min_spent", "collection_factor"],
		order_by="min_spent asc",
	)

	return {
		"enrolled": True,
		"customer": customer,
		"customer_name": cust_doc.customer_name,
		"loyalty_program": lp.name,
		"loyalty_program_name": lp.loyalty_program_name or lp.name,
		"conversion_factor": conversion_factor,
		"loyalty_points": points,
		"points_value": points_value,
		"current_tier": current_tier,
		"tiers": tiers,
		"expiry_duration": lp.expiry_duration,
	}


def _get_child_groups(group_type: str, root: str):
	"""Get all child groups including self."""
	if not root:
		return []
	result = frappe.db.get_value(group_type, root, ["lft", "rgt"])
	if not result:
		return [root]
	lft, rgt = result
	return frappe.get_all(
		group_type,
		filters={"lft": [">=", lft], "rgt": ["<=", rgt]},
		pluck="name",
	)


@frappe.whitelist()
def get_customer_groups():
	"""Return list of customer group names for dropdown."""
	return frappe.get_all(
		"Customer Group",
		filters={"is_group": 0},
		pluck="name",
		order_by="name asc",
		limit_page_length=0,
	)
