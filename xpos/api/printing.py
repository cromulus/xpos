# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""Print POS documents on an ERPNext network printer (Mule City, MuleCity-g100).

Bill 2026-09-29: XPOS prints through ERPNext; the till prints locally only when
XPOS itself is offline, or when ERPNext cannot reach the print server. Frappe's
``print_by_server`` has no quick way to tell "print server unreachable" from any
other failure, and a dead CUPS host can hold the request for a long time. So this
endpoint checks the print server first, with a short timeout, and reports that one
case as a status the till acts on. Every other failure raises as usual, so the
cashier sees the error and can reprint instead of getting a silent local copy.
"""

import socket

import frappe
from frappe import _
from frappe.utils import cint
from frappe.utils.print_format import print_by_server

#: Seconds to wait for the print server to accept a connection.
PRINT_SERVER_CONNECT_TIMEOUT = 3
#: CUPS' port, used when the printer record leaves it blank.
DEFAULT_CUPS_PORT = 631


def print_server_reachable(server_ip: str, port: int) -> bool:
	"""Whether a TCP connection to the print server opens within the timeout."""
	try:
		with socket.create_connection((server_ip, port), timeout=PRINT_SERVER_CONNECT_TIMEOUT):
			return True
	except OSError:
		return False


@frappe.whitelist()
def print_on_network_printer(
	doctype: str,
	name: str,
	printer_setting: str,
	print_format: str | None = None,
	no_letterhead: int = 0,
) -> dict:
	"""Print ``doctype``/``name`` on the network printer ``printer_setting``.

	Returns ``{"status": "printed"}``, or ``{"status": "print_server_unreachable"}``
	when the print server does not answer (the till then prints locally). Raises
	``frappe.PermissionError`` without Print permission on the document; any other
	error (missing printer record, bad print format, CUPS error) propagates.
	"""
	if not frappe.has_permission(doctype, "print", name):
		frappe.throw(_("Not permitted to print {0} {1}").format(doctype, name), frappe.PermissionError)

	printer = frappe.get_doc("Network Printer Settings", printer_setting)
	if not print_server_reachable(printer.server_ip, cint(printer.port) or DEFAULT_CUPS_PORT):
		return {"status": "print_server_unreachable"}

	print_by_server(
		doctype,
		name,
		printer_setting,
		print_format=print_format or None,
		no_letterhead=cint(no_letterhead),
	)
	return {"status": "printed"}
