/**
 * @vitest-environment jsdom
 *
 * User stories (Mule City MuleCity-erqg.17, Bill 2026-10-14): the cart's mix line
 * says what the mixer will pull ("2,000 lb asked → 2,040 lb pulled, 4 loads"),
 * lists the fixes when no pull list passes, carries the line's stored-grain and
 * bulk choices to the site, and can send the mix to the desk as a draft order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));

import { call } from "@/services/api";
import { muleOrderFields } from "@/services/muleOrderFields";
import { pullSummary, qtyForSize } from "@/utils/mixPull";

describe("the mix line's pull list", () => {
	it("says asked, pulled and loads", () => {
		expect(pullSummary({ asked_lb: 2000, pulled_lb: 2040, loads: 4 })).toBe("2,000 lb asked → 2,040 lb pulled, 4 loads");
		expect(pullSummary({ asked_lb: 4000, pulled_lb: 4000, loads: 1 })).toBe("4,000 lb, 1 load");
		expect(pullSummary({ asked_lb: 3370, blocked: true })).toBe("3,370 lb asked: no practical pull list. Choose a fix below.");
		expect(pullSummary(null)).toBe("");
	});

	it("turns a size fix into the line's own unit", () => {
		expect(qtyForSize(40, 2000, 2050)).toBe(41); // 40 bags of 50 lb -> 41 bags
		expect(qtyForSize(3370, 3370, 3400)).toBe(3400);
	});

	it("sends the line's choices with the sale", () => {
		const row = { item_code: "MIX", mule_stored_grain_use: "Up to", mule_stored_grain_use_lbs: 300, mule_bulk_no_bags: 1,
			mule_pull_remedy_json: '{"kind":"loads"}', qty: 2 };
		expect(muleOrderFields(row)).toEqual({ mule_stored_grain_use: "Up to", mule_stored_grain_use_lbs: 300,
			mule_bulk_no_bags: 1, mule_pull_remedy_json: '{"kind":"loads"}' });
		expect(muleOrderFields({ item_code: "MIX", mule_bulk_no_bags: null })).toEqual({});
	});
});

describe("Send to desk", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.mocked(call).mockReset();
	});

	it("saves the mix as a draft order for the desk and takes it out of the cart", async () => {
		const { useCartStore } = await import("@/stores/cartStore");
		const cart = useCartStore();
		cart.items = [
			{ uid: "a", item_code: "FEED", item_name: "Feed", qty: 1, rate: 10, uom: "Nos" } as any,
			{ uid: "b", item_code: "MIX", item_name: "Steve's mix", qty: 2, rate: 20, uom: "Nos" } as any,
		];
		vi.mocked(call).mockResolvedValueOnce({ sales_order: "SAL-ORD-0001", assigned_to: "Ben" });
		await cart.sendMixToDesk("b", "ben@mulecity.com", "more protein");
		const [method, args] = vi.mocked(call).mock.calls[0] as [string, Record<string, unknown>];
		expect(method).toBe("mulecity_erpnext.counter_mix_orders.counter_send_to_desk");
		expect(args).toMatchObject({ line_index: 1, assign_to: "ben@mulecity.com", note: "more protein" });
		expect(cart.items.map((i: any) => i.item_code)).toEqual(["FEED"]);
		expect(cart.deskMessage).toBe("Sent to Ben as a draft order SAL-ORD-0001.");
	});

	it("keeps a line's choices on the line", async () => {
		const { useCartStore } = await import("@/stores/cartStore");
		const cart = useCartStore();
		cart.items = [{ uid: "b", item_code: "MIX", item_name: "Steve's mix", qty: 2, rate: 20, uom: "Nos" } as any];
		cart.setMixLineFields("b", { mule_bulk_no_bags: 1, mule_stored_grain_use: "None" });
		expect((cart.items[0] as any).mule_bulk_no_bags).toBe(1);
		cart.setMixLineFields("b", { mule_bulk_no_bags: null });
		expect("mule_bulk_no_bags" in (cart.items[0] as any)).toBe(false);
		expect((cart.items[0] as any).mule_stored_grain_use).toBe("None");
	});
});

describe("the fixes on a mix line", () => {
	beforeEach(() => setActivePinia(createPinia()));

	it("lists them, keeps an owner's fix for the desk, and applies a size as the quantity", async () => {
		const { mount } = await import("@vue/test-utils");
		const { useCartStore } = await import("@/stores/cartStore");
		const MixLineOptions = (await import("@/components/cart/MixLineOptions.vue")).default;
		const cart = useCartStore();
		const item = { uid: "b", item_code: "MIX", item_name: "Steve's mix", qty: 3370, rate: 0.3, uom: "Pound" };
		cart.items = [item as any];
		cart.quotedOrder = (() => ({
			item_code: "MIX", qty: 3370, grand_total: 0,
			pull: { asked_lb: 3370, blocked: true },
			pull_remedies: [
				{ kind: "size", label: "Order 3,400 lb (above)", consequence: "1 load(s), 3,410 lb pulled", value: 3400, apply: { kind: "size", value: 3400 } },
				{ kind: "band", label: "Let protein move ±2.5%", consequence: "1 load(s)", owner_only: true, apply: { kind: "band" } },
				{ kind: "exact", label: "Weigh the recipe's exact pounds", consequence: "not round", apply: { kind: "exact" } },
			],
		})) as any;
		const wrapper = mount(MixLineOptions, { props: { item, index: 0 } });
		expect(wrapper.get('[data-testid="mix-pull-summary"]').text()).toContain("no practical pull list");
		expect(wrapper.get('[data-testid="mix-pull-fix-band"]').attributes("disabled")).toBeDefined();
		await wrapper.get('[data-testid="mix-pull-fix-size"]').trigger("click");
		expect(wrapper.emitted("update-qty")?.[0]).toEqual([3400]);
		await wrapper.get('[data-testid="mix-pull-fix-exact"]').trigger("click");
		expect((cart.items[0] as any).mule_pull_remedy_json).toBe('{"kind":"exact"}');
	});
});
