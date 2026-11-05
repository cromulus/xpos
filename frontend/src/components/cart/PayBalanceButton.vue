<template>
	<!-- Offered when the customer owes something (Bill 2026-11-05, MuleCity-biez). -->
	<Button
		v-if="offered"
		variant="outline"
		size="sm"
		class="mt-1 h-7 text-xs"
		data-testid="pay-balance-button"
		@click="pick"
	>
		<HandCoins class="w-3.5 h-3.5 me-1" />{{ __("Pay balance {0}", [money(balance ?? 0)]) }}
	</Button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useMoney } from "@/composables/useMoney";
import { useCustomerAccount } from "@/composables/useCustomerAccount";
import { showError } from "@/services/api";
import { Button } from "@/components/ui/button";
import { HandCoins } from "lucide-vue-next";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const { money } = useMoney();
const { balance, canReceive } = useCustomerAccount();
// The same gate as Receive on Account (profile and role allow settling, online, a sale, a balance owed).
const offered = computed(() => !!cartStore.payBalanceSettings && canReceive.value && !cartStore.hasPayBalance);

function pick() {
	const result = cartStore.openPayBalance();
	if (!result.success && result.message) showError(result.message);
}
</script>
