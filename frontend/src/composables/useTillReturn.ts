/**
 * Start a return in the cart (Mule City, Bill 2026-11-12, MuleCity-rj2o).
 *
 * A return has the cart to itself. With a sale in the cart, the cashier is asked
 * first (``cartBusy``): save the sale as a draft and come back to it, or clear it.
 * Each sold row becomes its own return line at the price it sold for, naming the
 * row it refunds, so a custom mix's free extra bags never refund as paid ones.
 */
import { computed } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useParkCart } from "@/composables/useParkCart";
import type { Choice } from "@/components/dialogs/ChoiceDialog.vue";
import __ from "@/lib/translate";

export interface ReturnRow {
	name?: string;
	item_code: string;
	item_name: string;
	rate: number;
	uom: string;
	stock_uom?: string;
	return_qty: number;
	serial_no?: string;
	batch_no?: string;
}

export interface ReturnSource {
	name: string;
	customer?: string;
	customer_name: string;
}

export const PARK = "park";
export const CLEAR = "clear";

export function useTillReturn() {
	const cartStore = useCartStore();
	const { parkCart } = useParkCart();

	/** Something in the cart that starting a return would throw away. */
	const cartBusy = computed(() => !cartStore.isEmpty);

	const busyTitle = computed(() =>
		cartStore.isReturnMode ? __("A return is already in the cart") : __("The cart has a sale in it"),
	);
	const busyDescription = computed(() =>
		cartStore.isReturnMode
			? __("Start this return instead? The one in the cart is dropped; nothing has been refunded yet.")
			: __("A return has the cart to itself. Save this sale for later, or clear it, then the return starts."),
	);
	const busyChoices = computed<Choice[]>(() =>
		cartStore.isReturnMode
			? [{ key: CLEAR, label: __("Drop it and start this return"), variant: "destructive" }]
			: [
					{
						key: PARK,
						label: __("Save the sale as a draft, then start the return"),
						hint: __("Bring it back with Restore draft."),
					},
					{ key: CLEAR, label: __("Clear the sale and start the return"), variant: "destructive" },
				],
	);

	/** Make room as the cashier chose; false when the sale could not be saved. */
	async function makeRoom(choice: string): Promise<boolean> {
		if (choice === PARK) return parkCart();
		return true;
	}

	function startReturn(source: ReturnSource, rows: ReturnRow[]): void {
		cartStore.clearAll();
		cartStore.enterReturnMode(
			source.name,
			rows.map((row) => row.item_code),
		);
		cartStore.setCustomer({
			name: source.customer || source.customer_name,
			customer_name: source.customer_name,
		});
		for (const row of rows) {
			if (row.return_qty > 0) {
				cartStore.addReturnLine({
					item_code: row.item_code,
					item_name: row.item_name,
					qty: row.return_qty,
					rate: row.rate,
					uom: row.uom,
					stock_uom: row.stock_uom,
					sales_invoice_item: row.name,
					serial_no: row.serial_no,
					batch_no: row.batch_no,
				});
			}
		}
	}

	return { cartBusy, busyTitle, busyDescription, busyChoices, makeRoom, startReturn };
}
