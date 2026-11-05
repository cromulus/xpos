import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerMixItem } from "@/services/customerMixCart";
import { call } from "@/services/api";
vi.mock("@/services/api", () => ({ call: vi.fn() }));
const mix = { name: "CF-1", bom: "BOM-1", order_default: { qty: 40, uom: "Bag" } };
describe("repeat mix order", () => {
	beforeEach(() => vi.resetAllMocks());
	it("keeps the recipe, 40 bags, native conversion and customer's price", async () => {
		vi.mocked(call).mockResolvedValueOnce({ item_code: "CF-1", stock_uom: "Pound", is_made_to_order: 1 })
			.mockResolvedValueOnce({ uom: "Bag", conversion_factor: 50, rate: 12.5 });
		const result = await customerMixItem(mix, "Till", "Buyer");
		expect(result).toEqual({ qty: 40, item: { item_code: "CF-1", bom_no: "BOM-1", stock_uom: "Pound", is_made_to_order: 1, uom: "Bag", conversion_factor: 50, rate: 12.5 } });
		expect(call).toHaveBeenLastCalledWith("xpos.api.items.get_sale_unit", { item_code: "CF-1", pos_profile: "Till", customer: "Buyer", uom: "Bag" });
	});
	it("refuses a missing conversion instead of selling 40 pounds as 40 bags", async () => {
		vi.mocked(call).mockResolvedValueOnce({ item_code: "CF-1" }).mockResolvedValueOnce({ uom: "Bag", conversion_factor: 0 });
		await expect(customerMixItem(mix, "Till", "Buyer")).rejects.toThrow("unit needs review");
	});
});
