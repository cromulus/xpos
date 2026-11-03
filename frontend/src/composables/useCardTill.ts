/**
 * The till's side of Pay by Card (Mule City, MuleCity-bjjv.3): the cart adopts
 * the draft the card reader collects for, so another tender completes that same
 * sale; once the payments app has submitted it, this cart is cleared, Pay is
 * closed and that invoice is printed. Never create_invoice: no second sale.
 */
import { useCardPaymentStore } from "@/stores/cardPaymentStore";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { usePrintInvoice } from "@/composables/usePrintInvoice";

export function bindCardTill(): void {
	const cardStore = useCardPaymentStore();
	const cartStore = useCartStore();
	const posStore = usePosStore();
	const { printInvoice } = usePrintInvoice();
	cardStore.bindTill({
		adoptDraft(name: string, modified: string) {
			cartStore.currentDraftName = name;
			cartStore.currentDraftModified = modified;
		},
		async complete(invoice: string, withPrint: boolean) {
			posStore.lastInvoiceName = invoice;
			if (cartStore.currentDraftName === invoice) cartStore.clearAll();
			cartStore.closePaymentDialog();
			if (withPrint) await printInvoice(invoice);
		},
	});
}
