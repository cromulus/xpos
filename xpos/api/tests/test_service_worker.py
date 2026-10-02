# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from xpos import pwa


class TestServiceWorkerScope(unittest.TestCase):
	"""The worker answers /xpos as well as /xpos/* (MuleCity-q8aq).

	Frappe redirects /xpos/ to /xpos, the page staff bookmark. A worker scoped /xpos/ never sees a
	navigation to /xpos, so an offline cold start there failed with "No internet". The worker is
	served from /xpos/sw.js, whose default maximum scope is /xpos/; registering it with scope /xpos
	needs Service-Worker-Allowed: /xpos.
	"""

	def _render(self, name):
		with tempfile.TemporaryDirectory() as build:
			with open(os.path.join(build, name), "wb") as handle:
				handle.write(b"// worker")
			request = SimpleNamespace(path=f"/xpos/{name}")
			with (
				patch("xpos.pwa.asset_dir", return_value=build),
				patch("xpos.pwa.frappe.local", SimpleNamespace(request=request)),
			):
				page = pwa.ServiceWorkerPage(f"xpos/{name}")
				self.assertTrue(page.can_render())
				with patch.object(pwa.ServiceWorkerPage, "build_response", side_effect=lambda data, headers: headers):
					return page.render()

	def test_scope_is_the_till_without_a_trailing_slash(self):
		self.assertEqual(pwa.SCOPE, "/xpos")

	def test_the_worker_may_take_the_xpos_scope(self):
		headers = self._render("sw.js")
		self.assertEqual(headers["Service-Worker-Allowed"], "/xpos")
		self.assertEqual(headers["Cache-Control"], "no-cache, no-store, must-revalidate")
		self.assertTrue(headers["Content-Type"].startswith("text/javascript"))

	def test_only_worker_files_are_served(self):
		request = SimpleNamespace(path="/xpos/index.html")
		with patch("xpos.pwa.frappe.local", SimpleNamespace(request=request)):
			self.assertIsNone(pwa.resolve())
