/**
 * Cashier initials on a till payment that is not a sale (Mule City, MuleCity-b9df):
 * Receive on Account and Settle ask for them on the shared register login exactly
 * like Pay (utils/cashierInitials, CashierInitialsField). The server
 * (`xpos.api.payments.stamp_till_payment`) refuses the same payments without them.
 */
import { computed, ref } from "vue";
import { usePosStore } from "@/stores/posStore";
import { cashierInitialsOk, normalizeInitials } from "@/utils/cashierInitials";

export function useTillCashier() {
	const posStore = usePosStore();
	const initials = ref("");
	const required = computed(() => !!posStore.requireCashierInitials);
	const cashiers = computed(() => posStore.cashiers ?? []);
	const ok = computed(() => cashierInitialsOk(required.value, cashiers.value, initials.value));

	/** `{ pos_cashier }` for the API call when initials are asked, else nothing (the server names a named login). */
	function payload(): { pos_cashier?: string } {
		return required.value ? { pos_cashier: normalizeInitials(initials.value) } : {};
	}

	/** After the payment is taken: the avatar shows who is at the till (MuleCity-qajl.1). */
	function remember(): void {
		if (required.value) posStore.rememberCashier(initials.value);
	}

	return { initials, required, cashiers, ok, payload, remember, reset: () => (initials.value = "") };
}
