/** A library repeat order has an explicit size; product-grid taps still add one unit. */
import { call } from "@/services/api";
import type { POSItem } from "@/types/pos.types";

export interface CustomerMixChoice {
	name: string;
	bom: string;
	order_default: { qty: number; uom: string };
}

export async function customerMixItem(row: CustomerMixChoice, profile: string, customer: string) {
	const size = row.order_default;
	if (!row.bom || !size || !Number.isFinite(size.qty) || size.qty <= 0)
		throw new Error("Review this mix's recipe and order size before adding it.");
	// The same native Item, customer pricing and UOM conversion as the product dialog.
	const item = await call<POSItem>("xpos.api.items.get_item_detail", {
		item_code: row.name, pos_profile: profile, customer,
	});
	const unit = await call<{ uom: string; conversion_factor: number; rate: number }>("xpos.api.items.get_sale_unit", {
		item_code: row.name, pos_profile: profile, customer, uom: size.uom,
	});
	if (item.item_code !== row.name || unit.uom !== size.uom || !(unit.conversion_factor > 0))
		throw new Error("This mix's order unit needs review before adding it.");
	return { item: { ...item, ...unit, bom_no: row.bom }, qty: size.qty };
}
