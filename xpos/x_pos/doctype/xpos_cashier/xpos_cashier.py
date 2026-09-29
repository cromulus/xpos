# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class XPOSCashier(Document):
	"""One row of a POS Profile's cashier list (Mule City, MuleCity-fb00.2).

	Several cashiers share one register login; each types their initials at Pay
	and ``xpos.api.invoices.apply_pos_cashier`` checks them against these rows.
	"""

	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		cashier_name: DF.Data
		initials: DF.Data
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
	# end: auto-generated types

	pass
