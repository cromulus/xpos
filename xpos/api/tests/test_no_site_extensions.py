"""XPOS on a plain ERPNext site: no app registers a till extension.

Every ``xpos_*`` hook is unregistered for these tests (``frappe.get_hooks``
answers nothing for them), so XPOS runs on its stock defaults: taxes through
ERPNext's party resolution (Tax Rule, else the POS Profile's template), its own
savepoint preview, Repeat Invoice with the lines as sold, no site fields, no
card reader app unless one is installed, and a boot site map with only XPOS's
own tax methods. And no XPOS server file names a site app.
"""

import os
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import flt

import xpos
from xpos.api import party_taxes, site_hooks
from xpos.api.invoices import _build_invoice_doc, preview_invoice

_real_get_hooks = frappe.get_hooks


def _no_xpos_hooks(hook=None, *args, **kwargs):
	"""frappe.get_hooks as on a site where no app extends the till."""
	if isinstance(hook, str) and hook.startswith("xpos_"):
		return []
	return _real_get_hooks(hook, *args, **kwargs)


class NoExtensions(IntegrationTestCase):
	def setUp(self):
		patcher = patch("frappe.get_hooks", side_effect=_no_xpos_hooks)
		patcher.start()
		self.addCleanup(patcher.stop)


class TestNoSiteAppIsNamed(IntegrationTestCase):
	def test_no_server_file_names_a_site_app(self):
		root = os.path.dirname(xpos.__file__)
		offenders = []
		for folder, dirs, files in os.walk(root):
			dirs[:] = [d for d in dirs if d not in ("tests", "public", "node_modules", "__pycache__")]
			for name in files:
				if name.endswith((".py", ".json", ".js", ".html")):
					path = os.path.join(folder, name)
					with open(path, encoding="utf-8", errors="ignore") as handle:
						if "mulecity_erpnext" in handle.read():
							offenders.append(os.path.relpath(path, root))
		self.assertEqual(offenders, [])

	def test_the_site_map_is_not_a_dispatcher(self):
		"""The map only names methods: nothing in site_hooks is callable over HTTP."""
		self.assertFalse(
			[fn for fn in frappe.whitelisted if getattr(fn, "__module__", "") == site_hooks.__name__]
		)


class TestBootWithoutExtensions(NoExtensions):
	def test_the_boot_map_has_only_xpos_own_tax_methods(self):
		self.assertEqual(site_hooks.site_map(), dict(site_hooks.SITE_DEFAULTS))

	def test_the_boot_carries_the_map(self):
		from xpos.startup.boot import extend_bootinfo

		bootinfo = frappe._dict()
		extend_bootinfo(bootinfo)
		self.assertEqual(bootinfo.xpos_site, dict(site_hooks.SITE_DEFAULTS))
		self.assertEqual(bootinfo.xpos_customer_tax_exempt_reasons, [])

	def test_no_site_fields(self):
		self.assertEqual(site_hooks.order_line_fields(), ())
		self.assertEqual(site_hooks.order_line_server_fields(), ())
		self.assertEqual(
			site_hooks.customer_fields(),
			{"search": [], "codes": None, "since": None, "tax_exempt_reason": None},
		)

	def test_repeat_keeps_the_lines_as_sold(self):
		self.assertIsNone(site_hooks.repeat_lines(frappe._dict(items=[]), None))

	def test_card_reader_app_is_an_installed_one_or_none(self):
		app = site_hooks.payment_terminal_app()
		self.assertIn(app, (None, *[a for a in ("pay_ng", "payments") if a in frappe.get_installed_apps()]))


class TestSiteMapMerging(IntegrationTestCase):
	def test_extensions_merge_and_junk_is_dropped(self):
		maps = {
			"a": lambda: {"mix": {"quote": "a.quote"}, "tax_context": "a.tax_context"},
			"b": lambda: {"mix": {"check": "b.check"}, "bad": object(), "flag": True},
		}

		def hooks(hook=None, *args, **kwargs):
			return ["a", "b"] if hook == site_hooks.SITE_EXTENSIONS_HOOK else []

		with (
			patch("frappe.get_hooks", side_effect=hooks),
			patch("frappe.get_attr", side_effect=lambda p: maps[p]),
		):
			merged = site_hooks.site_map()
		self.assertEqual(merged["mix"], {"quote": "a.quote", "check": "b.check"})
		self.assertEqual(merged["tax_context"], "a.tax_context")
		self.assertEqual(merged["tax_contexts"], site_hooks.SITE_DEFAULTS["tax_contexts"])
		self.assertTrue(merged["flag"])
		self.assertNotIn("bad", merged)

	def test_a_failed_extension_is_left_out_and_named(self):
		"""One app's broken map drops only that map, and the till is told the map is incomplete."""

		def broken():
			raise RuntimeError("site flag lookup failed")

		maps = {"a": lambda: {"vfd": {"context": "a.vfd.context"}}, "b": broken}

		def hooks(hook=None, *args, **kwargs):
			return ["a", "b"] if hook == site_hooks.SITE_EXTENSIONS_HOOK else []

		with (
			patch("frappe.get_hooks", side_effect=hooks),
			patch("frappe.get_attr", side_effect=lambda p: maps[p]),
			patch("frappe.log_error") as log_error,
		):
			merged = site_hooks.site_map()
		self.assertEqual(merged["vfd"], {"context": "a.vfd.context"})
		self.assertEqual(merged["extension_errors"], ["b"])
		log_error.assert_called_once()

	def test_negative_a_whole_map_has_no_extension_errors(self):
		def hooks(hook=None, *args, **kwargs):
			return ["a"] if hook == site_hooks.SITE_EXTENSIONS_HOOK else []

		with (
			patch("frappe.get_hooks", side_effect=hooks),
			patch("frappe.get_attr", return_value=lambda: {"flag": True}),
		):
			self.assertNotIn("extension_errors", site_hooks.site_map())

	def test_several_apps_on_a_single_answer_hook_the_last_wins_and_the_log_says_so(self):
		used = []

		def hooks(hook=None, *args, **kwargs):
			return ["site.taxes", "later_app.taxes"] if hook == site_hooks.APPLY_TAXES_HOOK else []

		site_hooks._warned.clear()
		logger = patch("frappe.logger")
		with (
			patch("frappe.get_hooks", side_effect=hooks),
			patch("frappe.get_attr", side_effect=lambda path: lambda doc: used.append(path)),
			logger as get_logger,
		):
			site_hooks.apply_taxes("DOC")
			site_hooks.apply_taxes("DOC")
		self.assertEqual(used, ["later_app.taxes", "later_app.taxes"])
		warning = get_logger.return_value.warning
		warning.assert_called_once()
		self.assertIn("later_app.taxes is used", warning.call_args.args[0])
		self.assertIn("site.taxes", warning.call_args.args[0])

	def test_a_site_hook_wins_over_the_default(self):
		calls = []

		def hooks(hook=None, *args, **kwargs):
			return ["site.taxes"] if hook == site_hooks.APPLY_TAXES_HOOK else []

		with (
			patch("frappe.get_hooks", side_effect=hooks),
			patch("frappe.get_attr", return_value=lambda doc: calls.append(doc)),
			patch.object(party_taxes, "apply_party_taxes") as default,
		):
			site_hooks.apply_taxes("DOC")
		self.assertEqual(calls, ["DOC"])
		default.assert_not_called()


class TestSellingWithoutExtensions(NoExtensions):
	"""A cart is built, taxed and previewed with XPOS's own defaults."""

	def setUp(self):
		super().setUp()
		self.profile_name = frappe.db.get_value("POS Profile", {"disabled": 0}, "name")
		if not self.profile_name:
			self.skipTest("needs a POS Profile")
		self.profile = frappe.get_doc("POS Profile", self.profile_name)
		if not self.profile.selling_price_list:
			self.skipTest("the POS Profile has no selling price list")
		run = frappe.generate_hash(length=6)
		self.run = run
		self.customer = self._customer(f"XPOS Plain Site {run}", self._sale_group())
		self.item = (
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": f"XPOS-PLAIN-{run}",
					"item_name": "Plain site item",
					"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
					"stock_uom": "Nos",
					"is_stock_item": 0,
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": self.item,
				"price_list": self.profile.selling_price_list,
				"price_list_rate": 10,
			}
		).insert(ignore_permissions=True)

	def _sale_group(self):
		"""A leaf Customer Group this register sells to (any leaf when it has no limit)."""
		from xpos.api.customers import allowed_customer_groups

		allowed = allowed_customer_groups(self.profile)
		filters = {"is_group": 0, **({"name": ["in", allowed]} if allowed else {})}
		group = frappe.db.get_value("Customer Group", filters, "name")
		if not group:
			self.skipTest("the POS Profile sells to no leaf customer group")
		return group

	def _customer(self, name, group):
		return (
			frappe.get_doc(
				{
					"doctype": "Customer",
					"customer_name": name,
					"customer_group": group,
					"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
				}
			)
			.insert(ignore_permissions=True)
			.name
		)

	def cart(self):
		return {
			"pos_profile": self.profile_name,
			"customer": self.customer,
			"items": [{"item_code": self.item, "qty": 2, "rate": 10, "price_list_rate": 10}],
		}

	def test_taxes_come_from_erpnext_party_resolution(self):
		with patch.object(party_taxes, "apply_party_taxes", wraps=party_taxes.apply_party_taxes) as default:
			doc = _build_invoice_doc(self.cart())[0]
		default.assert_called_once()
		template, _category = party_taxes._party_template(self.profile, self.customer, None)
		self.assertEqual(doc.taxes_and_charges or None, template or None)

	def test_tax_context_is_the_buyers_resolved_template(self):
		context = party_taxes.tax_context(self.customer, self.profile_name)
		template, category = party_taxes._party_template(self.profile, self.customer, None)
		self.assertEqual(context["taxes_and_charges"], template)
		self.assertEqual(context["tax_category"], category)
		self.assertIsNone(context["tax_exempt_reason"])
		self.assertIn("", party_taxes.tax_contexts(self.profile_name))

	def test_preview_returns_the_totals_and_writes_nothing(self):
		before = frappe.db.count("Sales Invoice")
		summary = preview_invoice(frappe.as_json(self.cart()))
		self.assertEqual(frappe.db.count("Sales Invoice"), before)
		self.assertEqual(flt(summary["net_total"], 2), 20.0)
		self.assertEqual(
			flt(summary["grand_total"], 2), flt(summary["net_total"] + summary["total_taxes_and_charges"], 2)
		)
		self.assertEqual(summary["items"][0]["item_code"], self.item)
		self.assertNotIn("stored_grain", summary["items"][0])

	def test_negative_tax_context_refuses_a_customer_outside_the_registers_groups(self):
		from xpos.api.customers import allowed_customer_groups

		allowed = allowed_customer_groups(self.profile)
		if not allowed:
			self.skipTest("the POS Profile sells to every customer group")
		outside = frappe.db.get_value("Customer Group", {"is_group": 0, "name": ["not in", allowed]}, "name")
		if not outside:
			self.skipTest("no customer group outside the POS Profile's")
		stranger = self._customer(f"XPOS Plain Outside {self.run}", outside)
		with self.assertRaises(frappe.PermissionError):
			party_taxes.tax_context(stranger, self.profile_name)

	def test_negative_tax_context_refuses_a_register_the_caller_may_not_use(self):
		frappe.set_user("Guest")
		self.addCleanup(frappe.set_user, "Administrator")
		with self.assertRaises(frappe.PermissionError):
			party_taxes.tax_context(self.customer, self.profile_name)
