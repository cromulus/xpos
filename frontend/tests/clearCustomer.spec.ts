/**
 * @vitest-environment jsdom
 *
 * Counter story (Bill 2026-10-01, MuleCity-zstm.22): Leslie finished with Albert
 * and wants the till back to walk-in. One control at the customer's name clears
 * the customer, the basket and its discounts; with lines in the basket it asks
 * first. It does nothing for walk-in with an empty basket, and it needs no
 * network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { canClearCustomer, clearNeedsConfirm } from "@/utils/clearCustomer";

const cached = vi.hoisted(() => ({ getCustomer: vi.fn() }));
const server = vi.hoisted(() => ({ getCustomer: vi.fn() }));
vi.mock("@/services/dbBridge", () => cached);
vi.mock("@/utils", async (importOriginal) => ({ ...(await importOriginal<object>()), ...server }));
vi.mock("@/services/api", () => ({ call: vi.fn() }));
vi.mock("@/stores/posStore", () => ({
	usePosStore: () => ({ defaultCustomer: "Walk-In", taxes: [], profile: {}, tenderModeFor: () => undefined }),
}));

import { useCartStore } from "@/stores/cartStore";
import ClearCustomer from "@/components/cart/ClearCustomer.vue";

const base = { defaultCustomer: "Walk-In", isEmpty: true, isReturnMode: false };

describe("when the clear control is enabled", () => {
	it("walk-in with an empty basket: nothing to clear", () => {
		expect(canClearCustomer({ ...base, customer: "Walk-In" })).toBe(false);
	});
	it("a customer chosen, basket empty: enabled, no confirm", () => {
		const state = { ...base, customer: "MC-CUST-4112" };
		expect(canClearCustomer(state)).toBe(true);
		expect(clearNeedsConfirm(state)).toBe(false);
	});
	it("a basket with lines: enabled, asks first (even for walk-in)", () => {
		const state = { ...base, customer: "Walk-In", isEmpty: false };
		expect(canClearCustomer(state)).toBe(true);
		expect(clearNeedsConfirm(state)).toBe(true);
	});
	it("a register without a walk-in customer: any chosen customer can be cleared", () => {
		expect(canClearCustomer({ ...base, defaultCustomer: "", customer: "MC-CUST-1" })).toBe(true);
		expect(canClearCustomer({ ...base, defaultCustomer: "", customer: null })).toBe(false);
	});
	it("never in return mode (the return banner has its own exit)", () => {
		expect(canClearCustomer({ ...base, customer: "MC-CUST-1", isEmpty: false, isReturnMode: true })).toBe(false);
	});
});

describe("clearing at the counter", () => {
	let wrapper: ReturnType<typeof mount> | null = null;
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		cached.getCustomer.mockResolvedValue({ name: "Walk-In", customer_name: "Walk-In Customer" });
	});
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
	});

	function mountWith(customer: string, lines = 0) {
		const cart = useCartStore();
		cart.setCustomer({ name: customer, customer_name: customer });
		for (let i = 0; i < lines; i++)
			cart.items.push({ item_code: "FEED-" + i, item_name: "Feed", qty: 1, rate: 10, uom: "Bag" } as never);
		cart.setDiscount("percentage", 5);
		wrapper = mount(ClearCustomer, { attachTo: document.body });
		return cart;
	}

	it("a customer alone is cleared at once, back to the walk-in row from the till's cache (offline too)", async () => {
		const cart = mountWith("MC-CUST-4112");
		await wrapper!.get("[data-testid='clear-customer']").trigger("click");
		await flushPromises();
		expect(cart.customer?.name).toBe("Walk-In");
		expect(cart.customer?.customer_name).toBe("Walk-In Customer");
		expect(cart.discountPercentage).toBe(0);
		expect(server.getCustomer).not.toHaveBeenCalled();
	});

	it("with lines in the basket it asks; Clear all empties basket and customer", async () => {
		const cart = mountWith("MC-CUST-4112", 2);
		await wrapper!.get("[data-testid='clear-customer']").trigger("click");
		await flushPromises();
		expect(cart.items).toHaveLength(2);
		const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear all");
		expect(confirm, "the confirm dialog").toBeTruthy();
		confirm!.click();
		await flushPromises();
		expect(cart.items).toHaveLength(0);
		expect(cart.customer?.name).toBe("Walk-In");
	});

	it("is disabled for walk-in with an empty basket", () => {
		mountWith("Walk-In");
		expect(wrapper!.get("[data-testid='clear-customer']").attributes("disabled")).toBeDefined();
	});
});
