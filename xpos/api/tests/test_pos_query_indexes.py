"""The POS hot-path indexes are actually created on migrate.

Why: the after_migrate hook ran add_pos_query_indexes.execute on every
migrate, but it only logged has_index, so no site had any of these indexes
(found on Mule City production, 2026-09-29).
"""

import unittest
from unittest.mock import patch

from xpos.patches import add_pos_query_indexes as patch_module


class TestEnsureIndex(unittest.TestCase):
	def _run(self, *, table=True, present=False, missing=()):
		with (
			patch.object(patch_module.frappe.db, "table_exists", return_value=table, create=True),
			patch.object(patch_module.frappe.db, "has_index", return_value=present, create=True),
			patch.object(patch_module, "missing_columns", return_value=list(missing)),
			patch.object(patch_module.frappe.db, "add_index", create=True) as add_index,
		):
			result = patch_module.ensure_index("Bin", ["item_code", "warehouse"], "item_code_warehouse")
		return result, add_index

	def test_a_missing_index_is_created(self):
		result, add_index = self._run()
		add_index.assert_called_once_with("Bin", ["item_code", "warehouse"], "item_code_warehouse")
		self.assertTrue(result.startswith("created"))

	def test_an_existing_index_is_left_alone(self):
		result, add_index = self._run(present=True)
		add_index.assert_not_called()
		self.assertTrue(result.startswith("present"))

	def test_a_missing_table_or_column_is_skipped_not_an_error(self):
		for kwargs in ({"table": False}, {"missing": ("uom",)}):
			with self.subTest(**kwargs):
				result, add_index = self._run(**kwargs)
				add_index.assert_not_called()
				self.assertTrue(result.startswith("skipped"))

	def test_execute_ensures_every_listed_index(self):
		with (
			patch.object(patch_module, "ensure_index", return_value="ok") as ensure,
			patch.object(patch_module, "drop_index", return_value="ok"),
		):
			patch_module.execute()
		self.assertEqual(ensure.call_count, len(patch_module.INDEXES))
