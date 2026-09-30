<!--
	Cashier initials at Pay (Mule City, MuleCity-fb00.2). Several cashiers share
	one register login; each sale records who rang it. The parent decides whether
	it is required and blocks payment until the initials match a listed cashier
	(see utils/cashierInitials). It starts empty on every sale because the Pay
	dialog is mounted afresh each time.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { __ } from "@/lib/translate";
import { matchCashier, normalizeInitials } from "@/utils/cashierInitials";
import type { XposCashier } from "@/types/pos.types";

const props = defineProps<{ cashiers: XposCashier[] }>();
const initials = defineModel<string>({ default: "" });
// Enter moves on to the amount, whose own Enter completes the sale.
const emit = defineEmits<{ done: [] }>();

const input = ref<InstanceType<typeof Input> | null>(null);

const typed = computed(() => normalizeInitials(initials.value));
const cashier = computed(() => matchCashier(props.cashiers, initials.value));

/** Lets the Pay dialog put the cursor here first. */
function focus() {
	(input.value?.$el as HTMLInputElement | undefined)?.focus();
}

defineExpose({ focus });
</script>

<template>
	<div class="space-y-1" data-testid="cashier-initials">
		<label
			for="cashier-initials-input"
			class="text-xs font-semibold text-muted-foreground uppercase tracking-wider"
		>
			{{ __("Cashier initials") }}
		</label>
		<div class="flex items-center gap-3">
			<Input
				id="cashier-initials-input"
				ref="input"
				v-model="initials"
				class="w-24 uppercase font-bold tracking-widest"
				maxlength="6"
				data-testid="cashier-initials-input"
				@keydown.enter.prevent="emit('done')"
			/>
			<span
				v-if="cashier"
				class="text-sm font-medium text-emerald-600 dark:text-emerald-400"
				data-testid="cashier-initials-match"
			>
				{{ cashier.cashier_name }}
			</span>
			<span
				v-else-if="typed"
				class="text-sm font-medium text-destructive"
				data-testid="cashier-initials-unknown"
			>
				{{ __("{0} is not on the cashier list", [typed]) }}
			</span>
			<span v-else class="text-xs text-muted-foreground">
				{{ __("Required to complete the sale") }}
			</span>
		</div>
	</div>
</template>
