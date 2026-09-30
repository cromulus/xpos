"""User stories for printing a POS ticket on ERPNext's network printer (MuleCity-g100).

Bill 2026-09-29: "xpos should only launch local print if: print server is down, and
ERPNext can't communicate with it, OR xpos itself is offline."

- A cashier with Print permission saves a sale while the print server is up: the
  ticket goes to the network printer and the till is told it printed.
- The print server is down: nothing is sent to it, and the till is told so, so it can
  print locally.
- A user without Print permission is refused; nothing prints anywhere.
- Any other print error (e.g. CUPS refuses the job) is raised, not turned into a
  local print.
"""

import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from xpos.api import printing
from xpos.api.printing import print_on_network_printer, print_server_reachable

PRINTER = SimpleNamespace(name="Mule City Ricoh", server_ip="10.0.0.5", port=631)


class TestPrintOnNetworkPrinter(unittest.TestCase):
	def call(self, **overrides):
		kwargs = {
			"doctype": "Sales Invoice",
			"name": "SINV-0001",
			"printer_setting": "Mule City Ricoh",
			"print_format": "Mule City Ticket",
			"no_letterhead": 1,
		}
		kwargs.update(overrides)
		return print_on_network_printer(**kwargs)

	def test_prints_when_the_print_server_is_up(self):
		with (
			patch.object(printing.frappe, "has_permission", return_value=True) as has_permission,
			patch.object(printing.frappe, "get_doc", return_value=PRINTER),
			patch.object(printing, "print_server_reachable", return_value=True) as reachable,
			patch.object(printing, "print_by_server") as print_by_server,
		):
			self.assertEqual(self.call(), {"status": "printed"})

		has_permission.assert_called_once_with("Sales Invoice", "print", "SINV-0001")
		reachable.assert_called_once_with("10.0.0.5", 631)
		print_by_server.assert_called_once_with(
			"Sales Invoice", "SINV-0001", "Mule City Ricoh", print_format="Mule City Ticket", no_letterhead=1
		)

	def test_blank_port_falls_back_to_cups_default(self):
		with (
			patch.object(printing.frappe, "has_permission", return_value=True),
			patch.object(printing.frappe, "get_doc", return_value=SimpleNamespace(server_ip="10.0.0.5", port=0)),
			patch.object(printing, "print_server_reachable", return_value=True) as reachable,
			patch.object(printing, "print_by_server"),
		):
			self.call()
		reachable.assert_called_once_with("10.0.0.5", 631)

	def test_print_server_down_reports_it_and_sends_nothing(self):
		with (
			patch.object(printing.frappe, "has_permission", return_value=True),
			patch.object(printing.frappe, "get_doc", return_value=PRINTER),
			patch.object(printing, "print_server_reachable", return_value=False),
			patch.object(printing, "print_by_server") as print_by_server,
		):
			self.assertEqual(self.call(), {"status": "print_server_unreachable"})
		print_by_server.assert_not_called()

	def test_without_print_permission_is_refused(self):
		with (
			patch.object(printing.frappe, "has_permission", return_value=False),
			patch.object(printing, "print_server_reachable") as reachable,
			patch.object(printing, "print_by_server") as print_by_server,
		):
			with self.assertRaises(frappe.PermissionError):
				self.call()
		reachable.assert_not_called()
		print_by_server.assert_not_called()

	def test_other_print_errors_propagate(self):
		with (
			patch.object(printing.frappe, "has_permission", return_value=True),
			patch.object(printing.frappe, "get_doc", return_value=PRINTER),
			patch.object(printing, "print_server_reachable", return_value=True),
			patch.object(printing, "print_by_server", side_effect=frappe.ValidationError("Printing failed")),
		):
			with self.assertRaises(frappe.ValidationError):
				self.call()


class TestPrintServerReachable(unittest.TestCase):
	def test_a_listening_server_is_reachable(self):
		with socket.socket() as server:
			server.bind(("127.0.0.1", 0))
			server.listen(1)
			self.assertTrue(print_server_reachable("127.0.0.1", server.getsockname()[1]))

	def test_a_closed_port_is_unreachable(self):
		with socket.socket() as probe:
			probe.bind(("127.0.0.1", 0))
			port = probe.getsockname()[1]
		# Nothing listens on the port once the probe socket is closed.
		self.assertFalse(print_server_reachable("127.0.0.1", port))

	def test_connect_uses_a_short_timeout(self):
		with patch.object(printing.socket, "create_connection", side_effect=TimeoutError) as connect:
			self.assertFalse(print_server_reachable("10.0.0.5", 631))
		connect.assert_called_once_with(("10.0.0.5", 631), timeout=printing.PRINT_SERVER_CONNECT_TIMEOUT)
