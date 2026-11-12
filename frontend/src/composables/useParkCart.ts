/**
 * Park the cart: save it as a draft (the till's "Save as draft"), so another
 * sale, an order for pickup or a return can use the cart, and the parked one
 * comes back from "Restore draft" (Mule City, Bill 2026-11-12, MuleCity-rj2o).
 *
 * The same steps the cart's own Save as draft button runs (CartSummary.holdOrder):
 * online to the site, offline (or on the desktop app) to the till's own store.
 */
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { call, showError, showSuccess } from "@/services/api";
import { isElectron } from "@/services/electronBridge";
import { extractErrorMessage, isTabConflictError } from "@/utils";
import __ from "@/lib/translate";

export function useParkCart() {
	/** True when the cart was saved as a draft and emptied. */
	async function parkCart(): Promise<boolean> {
		// Stores are read when parking, so a screen can hold this without the offline store.
		const cartStore = useCartStore();
		const posStore = usePosStore();
		const offlineStore = useOfflineStore();
		if (cartStore.isEmpty) return true;

		const profileName = posStore.profileName;
		const shiftName = posStore.posOpeningShift?.name || "";
		if (!profileName) {
			showError(__("POS Profile is not set. Please close and reopen the shift."));
			return false;
		}
		if (!shiftName) {
			showError(__("No open shift found. Please open a shift first."));
			return false;
		}

		try {
			const data = cartStore.getInvoiceData(profileName, shiftName);
			if (!data.customer) {
				const bootCustomer = (window.xpos?.boot as Record<string, unknown>)?.sysdefaults as
					| Record<string, string>
					| undefined;
				data.customer = bootCustomer?.customer || "";
			}
			if (!data.customer) {
				showError(__("Please select a customer before holding the order."));
				return false;
			}
			if (!data.items || data.items.length === 0) {
				showError(__("No items in cart to save."));
				return false;
			}

			if (isElectron() && window.electronAPI?.db) {
				await window.electronAPI.db.addPendingInvoice({
					data: { ...data, is_draft: true, pos_opening_shift_local_id: shiftName },
					customer_name: cartStore.customerName || data.customer,
					grand_total: cartStore.grandTotal || 0,
				});
				cartStore.clearAll();
				showSuccess(__("Order saved as draft locally"));
				return true;
			}
			const serverData = { ...data };
			if (serverData.pos_opening_shift && /^\d+$/.test(String(serverData.pos_opening_shift))) {
				delete serverData.pos_opening_shift;
			}
			if (offlineStore.isOnline) {
				await call("xpos.api.invoices.save_draft_invoice", { data: JSON.stringify(serverData) });
				cartStore.clearAll();
				showSuccess(__("Order saved as draft"));
			} else {
				await offlineStore.saveOffline(
					{ ...serverData, is_draft: true } as Parameters<typeof offlineStore.saveOffline>[0],
					cartStore.customerName || data.customer,
					cartStore.grandTotal || 0,
				);
				cartStore.clearAll();
				showSuccess(__("No connection – draft saved offline"));
			}
			return true;
		} catch (error: unknown) {
			if (isTabConflictError(error)) {
				showError(__("This tab was changed on another terminal. Reload it and try again."));
				cartStore.openDraftDialog();
				return false;
			}
			showError(__("Failed to save draft: {0}", [extractErrorMessage(error)]));
			return false;
		}
	}

	return { parkCart };
}
