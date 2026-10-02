<template>
	<!-- Clear customer and basket (Bill 2026-10-01, MuleCity-zstm.22): back to walk-in, nothing in the basket. -->
	<Button
		v-if="!cartStore.isReturnMode"
		variant="ghost"
		size="icon-sm"
		class="shrink-0 text-muted-foreground hover:text-destructive"
		data-testid="clear-customer"
		:disabled="!enabled"
		:title="__('Clear customer and basket')"
		:aria-label="__('Clear customer and basket')"
		@click.stop="request"
	>
		<UserX class="w-4 h-4" />
	</Button>
	<ConfirmDialog
		:open="confirming"
		:title="__('Clear customer and basket?')"
		:description="__('The customer, every line, discounts and delivery are cleared. The till goes back to the walk-in customer.')"
		:confirm-label="__('Clear all')"
		variant="destructive"
		:icon="UserX"
		@confirm="confirm"
		@cancel="confirming = false"
	/>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { UserX } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ConfirmDialog from "@/components/dialogs/ConfirmDialog.vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { getCustomer as getCachedCustomer } from "@/services/dbBridge";
import { getCustomer } from "@/utils";
import { canClearCustomer, clearNeedsConfirm } from "@/utils/clearCustomer";
import __ from "@/lib/translate";

const cartStore = useCartStore();
const posStore = usePosStore();
const confirming = ref(false);

const state = computed(() => ({
	customer: cartStore.customer?.name,
	defaultCustomer: posStore.defaultCustomer,
	isEmpty: cartStore.isEmpty,
	isReturnMode: cartStore.isReturnMode,
}));
const enabled = computed(() => canClearCustomer(state.value));

function request() {
	if (!enabled.value) return;
	if (clearNeedsConfirm(state.value)) confirming.value = true;
	else void clear();
}

function confirm() {
	confirming.value = false;
	void clear();
}

/** clearAll puts back the walk-in by ID at once; its full row comes from the till's cache, else the server. */
async function clear() {
	cartStore.clearAll();
	const name = posStore.defaultCustomer ? String(posStore.defaultCustomer) : "";
	if (!name) return;
	let row: Record<string, unknown> | null = null;
	try {
		row = ((await getCachedCustomer(name)) as Record<string, unknown> | null) ?? null;
	} catch {
		row = null;
	}
	if (!row && navigator.onLine) {
		try {
			row = (await getCustomer(name)) as Record<string, unknown>;
		} catch {
			row = null;
		}
	}
	// Only if nobody was chosen in the meantime.
	if (row && cartStore.customer?.name === name) cartStore.setCustomer(row as never);
}

defineExpose({ clear });
</script>
