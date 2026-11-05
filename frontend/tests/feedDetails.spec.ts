import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import FeedDetails from "@/components/FeedDetails.vue";
import type { FeedDetails as Details } from "@/types/feedDetails";
import type { MixPull } from "@/utils/mixPull";
const details: Details = {
	item: "MIX", item_name: "Goat mix", bom: "BOM-1", recipe_lb: 50,
	composition: [{ item_code: "CORN", item_name: "Corn", lbs: 40, share_pct: 80 }, { item_code: "SBM", item_name: "Soybean meal", lbs: 10, share_pct: 20 }],
	guaranteed_analysis: { protein_pct: 12, fat_pct: 0, fiber_pct: null },
	calculated_analysis: { protein_pct: 15.4, fat_pct: 2.5, fiber_pct: null },
	original_run: { pounds: 2000, bags: 40 },
};
const pull: MixPull = {
	asked_lb: 1000, pulled_lb: 1020, loads: 2,
	comparison: { bom: "BOM-1", ingredients: [{ item_code: "CORN", item_name: "Corn", recipe_lb: 800, planned_lb: 820 }, { item_code: "SBM", item_name: "Soybean meal", recipe_lb: 200, planned_lb: 200 }],
		recipe_analysis: { protein_pct: 10, fat_pct: 0, fiber_pct: null }, planned_analysis: { protein_pct: 9.8, fat_pct: 0, fiber_pct: null } },
};
describe("Feed detailed view", () => {
	it("keeps recorded guarantees, calculated nutrition and missing values distinct", () => {
		const view = mount(FeedDetails, { props: { details } });
		const guarantee = view.get('[data-testid="guaranteed-analysis"]').text();
		expect(guarantee).toContain("Recorded FilePro product analysis");
		expect(guarantee).toContain("12"); expect(guarantee).not.toContain("15.4");
		expect(guarantee).toContain("Fat %0"); expect(guarantee).toContain("Fiber %Unknown");
		expect(view.get('[data-testid="recipe-analysis"]').text()).toContain("15.4");
		expect(view.text()).toContain("Last recorded run: 2,000 lb");
		expect(view.text()).toContain("40 bags");
		expect(view.find('[data-testid="order-comparison"]').exists()).toBe(false);
	});
	it("shows whole-order scaled ingredients and the current pull deviations", () => {
		const view = mount(FeedDetails, { props: { details, order: true, orderSize: "20 Bag", pull } });
		expect(view.text()).toContain("This order · 20 Bag");
		expect(view.text()).toContain("Original recipe scaled to 1,000 lb");
		expect(view.get('[data-testid="ingredient-deviation"]').text()).toContain("Corn800820+20");
		expect(view.get('[data-testid="nutrition-deviation"]').text()).toContain("Protein %109.8-2%");
		expect(view.get('[data-testid="nutrition-deviation"]').text()).toContain("Fat %000%");
		expect(view.get('[data-testid="nutrition-deviation"]').text()).toContain("Fiber %UnknownUnknownUnknown");
	});
	it("hides old comparisons while the current cart is recalculated or refused", async () => {
		const view = mount(FeedDetails, { props: { details, order: true, pull } });
		await view.setProps({ pending: true });
		expect(view.text()).toContain("Recalculating pulls");
		expect(view.find('[data-testid="ingredient-deviation"]').exists()).toBe(false);
		await view.setProps({ pending: false, message: "Choose a date" });
		expect(view.text()).toContain("Choose a date");
		expect(view.find('[data-testid="ingredient-deviation"]').exists()).toBe(false);
		await view.setProps({ message: "", pull: { ...pull, blocked: true } });
		expect(view.text()).toContain("No practical pull list yet");
		expect(view.find('[data-testid="ingredient-deviation"]').exists()).toBe(false);
	});
	it("shows unknown weights and escapes ingredient text", () => {
		const view = mount(FeedDetails, { props: { details: { item: "X", item_name: "X", composition: [{ item_code: "X", item_name: "<script>alert(1)</script>", lbs: null, share_pct: null, qty: 2, uom: "Nos" }] } } });
		expect(view.text()).toContain("Recipe weight incomplete");
		expect(view.text()).toContain("2 Nos · pound weight unknown");
		expect(view.find("script").exists()).toBe(false);
	});
});
