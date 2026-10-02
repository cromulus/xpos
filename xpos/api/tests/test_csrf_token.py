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


class TestGetSessionBoot(unittest.TestCase):
	"""A till that started offline from the app shell asks for its boot and token before writing (MuleCity-q8aq)."""

	@patch("xpos.api.auth.session_csrf_token", return_value="saved-token")
	@patch("xpos.api.auth.session_boot", return_value={"user": {"name": "cashier@example.com"}})
	@patch("xpos.api.auth.frappe")
	def test_returns_the_session_boot_and_saved_token(self, mock_frappe, mock_boot, mock_token):
		mock_frappe.session.user = "cashier@example.com"

		self.assertEqual(
			auth.get_session_boot(),
			{"boot": {"user": {"name": "cashier@example.com"}}, "csrf_token": "saved-token"},
		)
		mock_boot.assert_called_once_with()
		mock_token.assert_called_once_with()

	@patch("xpos.api.auth.session_csrf_token")
	@patch("xpos.api.auth.session_boot")
	@patch("xpos.api.auth.frappe")
	def test_refuses_guests(self, mock_frappe, mock_boot, mock_token):
		"""An expired session is a Guest: refused, so the till shows its login and keeps the queue."""
		mock_frappe.session.user = "Guest"
		mock_frappe.AuthenticationError = frappe.AuthenticationError
		mock_frappe.throw.side_effect = frappe.AuthenticationError

		with self.assertRaises(frappe.AuthenticationError):
			auth.get_session_boot()
		mock_boot.assert_not_called()
		mock_token.assert_not_called()

	def test_is_whitelisted_for_get_only(self):
		self.assertIn(auth.get_session_boot, frappe.whitelisted)
		self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func[auth.get_session_boot], ["GET"])

	def test_the_page_and_the_endpoint_build_the_boot_the_same_way(self):
		"""Both use frappe.sessions.get and the saved session token, so an offline-started till ends up
		with what a fresh /xpos load would have given it."""
		from frappe import sessions

		self.assertIs(auth.session_boot, sessions.get)
		self.assertIs(xpos_page.get, sessions.get)
		self.assertIs(auth.session_csrf_token, sessions.get_csrf_token)
		self.assertIs(xpos_page.get_csrf_token, sessions.get_csrf_token)


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
		if not page.can_render():
			# www/xpos.html is the frontend build's output; a bench that has not built it still
			# has the page module, which is what decides caching.
			import os

			page.app = "xpos"
			page.app_path = frappe.get_app_path("xpos")
			page.file_dir = "www"
			page.template_path = os.path.join("www", "xpos.html")
			page.basepath = os.path.join(page.app_path, "www")
			page.basename = os.path.join(page.basepath, "xpos")
			page.filename = "xpos.html"
			page.name = "xpos"
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
