<template>
	<!-- The cart's "Pay balance" line (MuleCity-biez): a payment on account, not a sale. -->
	<div
		v-if="cartStore.hasPayBalance"
		class="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm"
		data-testid="pay-balance-line"
	>
		<HandCoins class="w-4 h-4 shrink-0 text-emerald-600" />
		<button type="button" class="flex-1 text-left min-w-0" data-testid="pay-balance-edit" @click="cartStore.openPayBalance()">
			<span class="font-semibold">{{ cartStore.payBalanceSettings?.item_name || __("Pay balance") }}</span>
			<span class="block text-xs text-muted-foreground">{{ __("Paid on account, no tax") }}</span>
		</button>
		<span class="font-semibold tabular-nums" data-testid="pay-balance-line-amount">{{ money(cartStore.payBalanceAmount) }}</span>
		<button
			type="button"
			class="p-1 text-muted-foreground hover:text-destructive"
			:aria-label="__('Remove')"
			data-testid="pay-balance-remove"
			@click="cartStore.clearPayBalance()"
		>
			<X class="w-4 h-4" />
		</button>
	</div>
</template>

<script setup lang="ts">
import { useCartStore } from "@/stores/cartStore";
import { useMoney } from "@/composables/useMoney";
import { HandCoins, X } from "lucide-vue-next";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const { money } = useMoney();
</script>
