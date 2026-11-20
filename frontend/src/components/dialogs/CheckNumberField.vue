<!--
	The check's number when a payment on account or a settled ticket is paid by
	check (Mule City, MuleCity-zegl): required, digits only, saved on the
	Payment Entry (pos_check_number) and listed at the close (utils/checkTender).
-->
<script setup lang="ts">
import { computed } from "vue";
import { Input } from "@/components/ui/input";
import { __ } from "@/lib/translate";
import { checkNumberProblem, cleanCheckNumber } from "@/utils/checkTender";

const number = defineModel<string>({ default: "" });
const problem = computed(() => (cleanCheckNumber(number.value) ? checkNumberProblem(number.value) : null));
</script>

<template>
	<div class="space-y-1">
		<label for="payment-check-number" class="text-sm font-semibold text-foreground mb-1.5 block">
			{{ __("Check number") }}
		</label>
		<Input
			id="payment-check-number"
			v-model="number"
			data-testid="payment-check-number"
			inputmode="numeric"
			autocomplete="off"
			:placeholder="__('Required')"
		/>
		<p v-if="problem" class="text-xs text-destructive">{{ problem }}</p>
	</div>
</template>
