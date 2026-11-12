/**
 * Put a past purchase in the cart (Recent purchases, a receipt's Repeat).
 *
 * Bill 2026-11-12 (MuleCity-rj2o): it always replaced the cart. With something in
 * the cart the cashier now chooses: add the purchase to the cart, or replace the
 * cart with it. A return in the cart can only be replaced.
 */
import { computed, ref } from "vue";
import { useCartStore } from "@/stores/cartStore";
import type { Choice } from "@/components/dialogs/ChoiceDialog.vue";
import __ from "@/lib/translate";

export const ADD = "add";
export const REPLACE = "replace";

type Purchase = Parameters<ReturnType<typeof useCartStore>["loadFromInvoice"]>[0];

export function useRepeatPurchase() {
	const cartStore = useCartStore();
	const pending = ref<{ purchase: Purchase; done?: () => void } | null>(null);
	const asking = computed(() => pending.value !== null);

	const title = computed(() => __("The cart already has {0} lines", [cartStore.items?.length ?? 0]));
	const description = computed(() =>
		cartStore.isReturnMode
			? __("A return is in the cart. Replace it with this purchase?")
			: __("Add this purchase to what is in the cart, or start the cart over with it?"),
	);
	const choices = computed<Choice[]>(() =>
		cartStore.isReturnMode
			? [{ key: REPLACE, label: __("Replace the cart"), variant: "destructive" }]
			: [
					{ key: ADD, label: __("Add to cart"), hint: __("The cart keeps its lines and customer.") },
					{ key: REPLACE, label: __("Replace the cart"), hint: __("The cart's lines are dropped."), variant: "outline" },
				],
	);

	/** Load now when the cart is empty; otherwise ask, then ``done`` runs after a choice. */
	function put(purchase: Purchase, done?: () => void): void {
		if (cartStore.isEmpty) {
			replaceWith(purchase);
			done?.();
			return;
		}
		pending.value = { purchase, done };
	}

	function choose(choice: string): void {
		const current = pending.value;
		pending.value = null;
		if (!current) return;
		if (choice === ADD && !cartStore.isReturnMode) cartStore.addFromInvoice(current.purchase);
		else replaceWith(current.purchase);
		current.done?.();
	}

	/** loadFromInvoice keeps return mode; a purchase is a sale, so leave it first. */
	function replaceWith(purchase: Purchase): void {
		if (cartStore.isReturnMode) cartStore.clearAll();
		cartStore.loadFromInvoice(purchase);
	}

	function cancel(): void {
		pending.value = null;
	}

	return { asking, title, description, choices, put, choose, cancel };
}
