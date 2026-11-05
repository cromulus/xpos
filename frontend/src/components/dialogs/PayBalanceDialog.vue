<template>
	<Dialog :open="cartStore.showPayBalanceDialog" @update:open="(val: boolean) => !val && close()">
		<DialogContent class="max-w-md flex flex-col p-0 gap-0" data-testid="pay-balance-dialog">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-2">
					<div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
						<HandCoins class="w-4 h-4" />
					</div>
					<div>
						<DialogTitle class="text-base">{{ __("Pay balance") }}</DialogTitle>
						<DialogDescription class="text-xs">
							{{ __("Paid with this cart's tenders, toward the oldest tickets first") }}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div class="p-5 space-y-4">
				<div class="rounded-lg border border-border p-3 space-y-1.5 text-sm">
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">{{ __("Customer") }}</span>
						<span class="font-medium">{{ cartStore.customerName }}</span>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">{{ __("Balance") }}</span>
						<span class="font-semibold text-primary" data-testid="pay-balance-owed">{{ money(balance) }}</span>
					</div>
				</div>
				<div>
					<label class="text-sm font-semibold text-foreground mb-1.5 block">{{ __("Amount") }}</label>
					<NumberInput v-model="amount" :precision="moneyPrecision" data-testid="pay-balance-amount" />
					<p v-if="overBalance" class="text-xs text-muted-foreground mt-1.5">
						{{ __("{0} more than the balance stays on account as a credit.", [money(amount - balance)]) }}
					</p>
				</div>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">{{ __("Cancel") }}</Button>
				<Button class="flex-1" :disabled="!(amount > 0)" data-testid="pay-balance-add" @click="add">
					{{ cartStore.hasPayBalance ? __("Change amount") : __("Add to cart") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
/**
 * "Pay balance" (Bill 2026-11-05, MuleCity-biez): the amount of the cart's balance
 * payment. It starts at what the customer owes (the site's balance, the past-due
 * stop's netting: opening AR and unallocated payments included); type less for a
 * part payment. The line is paid at Pay with the cart's tenders.
 */
import { ref, computed, watch, onMounted } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useMoney } from "@/composables/useMoney";
import { useCustomerAccount } from "@/composables/useCustomerAccount";
import { roundTo } from "@/utils/numberFormat";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { HandCoins } from "lucide-vue-next";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const { money, moneyPrecision } = useMoney();
const { balance: customerBalance } = useCustomerAccount();
const balance = computed(() => Number(customerBalance.value) || 0);
const amount = ref(0);
const overBalance = computed(() => amount.value > balance.value + 0.009);

onMounted(() => {
	cartStore.loadPayBalanceSettings();
});

watch(
	() => cartStore.showPayBalanceDialog,
	(open) => {
		if (!open) return;
		const start = cartStore.hasPayBalance ? cartStore.payBalanceAmount : Math.max(balance.value, 0);
		amount.value = roundTo(start, moneyPrecision.value);
	},
	{ immediate: true },
);

function add() {
	cartStore.setPayBalance(amount.value);
	close();
}

function close() {
	cartStore.showPayBalanceDialog = false;
}
</script>
