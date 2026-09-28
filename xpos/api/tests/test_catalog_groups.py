"""The cashier browses useful permitted categories, not only the profile umbrella."""
import unittest
from unittest.mock import patch
from xpos.api.items import get_item_groups


class TestCatalogGroups(unittest.TestCase):
	def test_profile_umbrella_exposes_categories_and_sellable_leaves(self):
		from frappe import _dict
		with patch("xpos.api.items.frappe") as api:
			api.get_cached_doc.return_value = _dict(item_groups=[_dict(item_group="Mule City Counter")])
			api.db.get_value.return_value = (2, 30)
			def groups(doctype, **kwargs):
				filters = kwargs["filters"]
				if filters.get("name") == ["in", ["Mule City Counter"]]:
					return [{"name": "Mule City Counter", "parent_item_group": "All Item Groups"}]
				if filters.get("is_group") == 1:
					self.assertEqual(filters["lft"], [">", 2])
					self.assertEqual(filters["rgt"], ["<", 30])
					return [{"name": "Feed", "parent_item_group": "Mule City Counter"}]
				if kwargs.get("pluck"):
					return ["House Mixes", "Retail"]
				return [{"name": name} for name in filters["name"][1]]
			api.get_all.side_effect = groups
			result = get_item_groups("Till")
			self.assertEqual([g["name"] for g in result["parent_groups"]], ["Feed"])
			self.assertEqual({g["name"] for g in result["groups"]}, {"House Mixes", "Retail"})

	def test_leaf_only_profile_keeps_its_group(self):
		from frappe import _dict
		with patch("xpos.api.items.frappe") as api:
			api.get_cached_doc.return_value = _dict(item_groups=[_dict(item_group="Retail")])
			api.db.get_value.return_value = (4, 5)
			api.get_all.side_effect = [[{"name": "Retail"}], [], ["Retail"], [{"name": "Retail"}]]
			self.assertEqual(get_item_groups("Till")["parent_groups"], [{"name": "Retail"}])
