/**
 * The cart customer's account: balance, credit limit, and Receive on Account.
 *
 * Shared by the cart's customer line, the Pay button (an empty cart with a
 * balance offers Receive on Account) and the Pay dialog (Receive on Account as
 * a payment option), Bill 2026-09-29, MuleCity-nfxn.3. The one
 * ReceiveOnAccountDialog is mounted by the cart and opened through
 * customerStore.showReceiveOnAccount.
 */
import { computed } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { isOnline } from "@/utils";
import { canReceiveOnAccount } from "@/utils/onAccount";

export function useCustomerAccount() {
	const posStore = usePosStore();
	const cartStore = useCartStore();
	const customerStore = useCustomerStore();

	// Only the info loaded for the cart's own customer counts.
	const info = computed(() =>
		cartStore.customer && customerStore.selectedCustomerInfo?.name === cartStore.customer.name
			? customerStore.selectedCustomerInfo
			: null,
	);
	const balance = computed<number | null>(() => info.value?.balance ?? null);
	const creditLimit = computed<number>(() => info.value?.credit_limit ?? 0);
	const canReceive = computed(() =>
		canReceiveOnAccount({
			allowSettlement: !!posStore.allowOutstandingSettlement,
			online: isOnline(),
			isReturnMode: cartStore.isReturnMode,
			balance: balance.value ?? 0,
		}),
	);

	/** Open Receive on Account, closing Pay if it is open. */
	function openReceiveOnAccount() {
		cartStore.closePaymentDialog();
		customerStore.showReceiveOnAccount = true;
	}

	return { balance, creditLimit, canReceive, openReceiveOnAccount };
}
