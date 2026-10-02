/**
 * @vitest-environment jsdom
 *
 * Bill (2026-10-01, MuleCity-qajl.7): "we should be able to add notes to sales,
 * orders, and returns as well." The cart's note box (POS Profile
 * display_additional_notes, which the Mule app turns on) is saved as pos_notes:
 * on the Sales Invoice for a sale or a return, on the Sales Order header for a
 * counter order (the same invoice data goes to counter_checkout), and it comes
 * back when an order is loaded for pickup. The offline receipt prints it from the
 * snapshot. A blank note sends and prints nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/services/dbBridge", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getCustomer: vi.fn(async () => null),
	getCachedStockForItem: vi.fn(async () => null),
	getCachedItemByCode: vi.fn(async () => null),
}));
vi.mock("@/stores/posStore", () => ({
	usePosStore: vi.fn(() => ({ taxes: [], taxInclusiveMode: false, currency: "USD", tenderModeFor: vi.fn(), defaultCustomer: "Walk-In" })),
}));
vi.mock("@/lib/translate", () => {
	const __ = (text: string) => text;
	return { __, default: __ };
});

import { useCartStore } from "@/stores/cartStore";

const line = {
	uid: "r1",
	item_code: "LAYER-PELLET",
	item_name: "Layer Pellet",
	qty: 1,
	rate: 20,
	uom: "Nos",
	conversion_factor: 1,
	discount_percentage: 0,
	discount_amount: 0,
};

beforeEach(() => setActivePinia(createPinia()));

describe("the cart's note", () => {
	it("goes with a sale and prints on its offline receipt", () => {
		const cart = useCartStore();
		cart.items.push({ ...line } as never);
		cart.orderNotes = "  Call Steve first  ";
		expect(cart.getInvoiceData("Till", "SHIFT-1").pos_notes).toBe("Call Steve first");
		expect(cart.getReceiptSnapshot("SINV-1").notes).toBe("Call Steve first");
	});

	it("goes with a return, with the return's own note (not the sale's)", () => {
		const cart = useCartStore();
		cart.orderNotes = "sale note";
		cart.clearCart();
		cart.items.push({ ...line, qty: -1 } as never);
		cart.enterReturnMode("ACC-SINV-2026-00001", ["LAYER-PELLET"]);
		expect(cart.orderNotes).toBe("");
		cart.orderNotes = "Torn bag";
		const data = cart.getInvoiceData("Till", "SHIFT-1");
		expect([data.is_return, data.return_against, data.pos_notes]).toEqual([true, "ACC-SINV-2026-00001", "Torn bag"]);
		const snapshot = cart.getReceiptSnapshot("SINV-2");
		expect([snapshot.is_return, snapshot.notes]).toEqual([true, "Torn bag"]);
	});

	it("comes back with an order loaded for pickup", () => {
		const cart = useCartStore();
		cart.loadFromInvoice({
			customer: "SMITH",
			customer_name: "Smith Farm",
			items: [{ item_code: "MIX-1", item_name: "Custom mix", qty: 500, rate: 0.4, uom: "Pound" }],
			pos_notes: "Bag in 50s",
		});
		expect(cart.orderNotes).toBe("Bag in 50s");
		expect(cart.getInvoiceData("Till", "SHIFT-1").pos_notes).toBe("Bag in 50s");
	});

	it("negative: a blank note sends and prints nothing", () => {
		const cart = useCartStore();
		cart.items.push({ ...line } as never);
		cart.orderNotes = "   ";
		expect(cart.getInvoiceData("Till", "SHIFT-1")).not.toHaveProperty("pos_notes");
		expect(cart.getReceiptSnapshot("SINV-3").notes).toBeUndefined();
	});

	it("the note box shows in return mode too (only an empty cart hides it)", async () => {
		const source = (await import("@/components/cart/Cart.vue?raw")).default as string;
		const box = source.match(/<div\s+v-if="([^"]*)"[^>]*>\s*<textarea\s+v-model="cartStore.orderNotes"/);
		expect(box?.[1]).toBe("posStore.displayAdditionalNotes && !cartStore.isEmpty");
	});
});
