<template>
	<!-- The cart's store-opened dialogs, mounted ONCE by PosView (MuleCity-6ev6).
	     PosView renders two Carts (desktop panel and mobile tab, one hidden by CSS
	     only), so a dialog inside Cart opened from the store showed twice, stacked. -->
	<ReceiveOnAccountDialog
		:customer="customerStore.showReceiveOnAccount ? cartStore.customer?.name || null : null"
		:customer-label="cartStore.customerName"
		:balance="customerBalance ?? 0"
		@close="customerStore.showReceiveOnAccount = false"
		@received="onReceivedOnAccount"
	/>
	<CustomerEditDialog />
</template>

<script setup lang="ts">
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useCustomerAccount } from "@/composables/useCustomerAccount";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";
import ReceiveOnAccountDialog from "@/components/dialogs/ReceiveOnAccountDialog.vue";

const cartStore = useCartStore();
const customerStore = useCustomerStore();
const { balance: customerBalance } = useCustomerAccount();

function onReceivedOnAccount() {
	customerStore.showReceiveOnAccount = false;
	if (cartStore.customer?.name) customerStore.getCustomerInfo(cartStore.customer.name);
}
</script>
