# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from xpos.api import auth
from xpos.www import xpos as xpos_page


class TestXposPageCsrfToken(unittest.TestCase):
	"""The /xpos page must embed the token the session keeps, not a throwaway one."""

	def _context(self):
		return SimpleNamespace()

	@patch("xpos.www.xpos.get", return_value={})
	@patch("xpos.www.xpos.get_csrf_token", return_value="saved-token")
	@patch("xpos.www.xpos.frappe")
	def test_logged_in_page_uses_the_saved_session_token(self, mock_frappe, mock_get_token, _get):
		mock_frappe.session.user = "cashier@example.com"
		mock_frappe.local.lang = "en"
		context = self._context()

		xpos_page.get_context(context)

		self.assertEqual(context.csrf_token, "saved-token")
		mock_get_token.assert_called_once_with()
		mock_frappe.generate_hash.assert_not_called()

	@patch("xpos.www.xpos.get", return_value={})
	@patch("xpos.www.xpos.get_csrf_token")
	@patch("xpos.www.xpos.frappe")
	def test_guest_page_gets_no_token(self, mock_frappe, mock_get_token, _get):
		mock_frappe.session.user = "Guest"
		mock_frappe.local.lang = "en"
		context = self._context()

		xpos_page.get_context(context)

		self.assertEqual(context.csrf_token, "")
		mock_get_token.assert_not_called()


class TestGetCsrfToken(unittest.TestCase):
	@patch("xpos.api.auth.session_csrf_token", return_value="saved-token")
	@patch("xpos.api.auth.frappe")
	def test_returns_the_session_token(self, mock_frappe, mock_get_token):
		mock_frappe.session.user = "cashier@example.com"

		self.assertEqual(auth.get_csrf_token(), "saved-token")

	@patch("xpos.api.auth.session_csrf_token")
	@patch("xpos.api.auth.frappe")
	def test_refuses_guests(self, mock_frappe, mock_get_token):
		mock_frappe.session.user = "Guest"
		mock_frappe.AuthenticationError = frappe.AuthenticationError
		mock_frappe.throw.side_effect = frappe.AuthenticationError

		with self.assertRaises(frappe.AuthenticationError):
			auth.get_csrf_token()
		mock_get_token.assert_not_called()

	def test_is_whitelisted_for_get_only(self):
		self.assertIn(auth.get_csrf_token, frappe.whitelisted)
		self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[auth.get_csrf_token], ["GET"])


class TestXposPageIsNeverWebsiteCached(unittest.TestCase):
	"""The /xpos page carries per-user boot and CSRF data, so Frappe's shared page cache must skip it."""

	def test_module_opts_out_of_the_page_cache_and_sitemap(self):
		self.assertEqual(xpos_page.no_cache, 1)
		self.assertEqual(xpos_page.sitemap, 0)

	def test_both_xpos_routes_resolve_to_this_page(self):
		from xpos import hooks

		routes = {r["from_route"]: r["to_route"] for r in hooks.website_route_rules}
		self.assertEqual(routes["/xpos"], "xpos")
		self.assertEqual(routes["/xpos/<path:app_path>"], "xpos")

	@patch("xpos.www.xpos.get", return_value={})
	@patch("xpos.www.xpos.get_csrf_token", return_value="saved-token")
	def test_frappe_renderer_reads_no_cache_and_refuses_to_cache(self, _token, _get):
		from frappe.website.page_renderers.template_page import TemplatePage
		from frappe.website.utils import can_cache

		page = TemplatePage("xpos")
		self.assertTrue(page.can_render())
		page.init_context()
		page.set_pymodule()
		self.assertEqual(page.pymodule_name, "xpos.www.xpos")
		page.update_context()

		self.assertEqual(page.context.no_cache, 1)
		self.assertEqual(page.context.sitemap, 0)
		# With the site-level mitigation off, the page itself must still opt out.
		with (
			patch.dict(frappe.conf, {"disable_website_cache": 0, "developer_mode": 0}),
			patch.dict(frappe.flags, {"force_website_cache": False}),
		):
			self.assertTrue(can_cache(False))
			self.assertFalse(can_cache(page.context.no_cache))
