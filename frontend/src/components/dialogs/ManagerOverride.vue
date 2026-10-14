<!--
	A charge the site refused (over the credit limit, or past due), and the
	manager override (Mule City, MuleCity-zstm.13). The clerk sees the site's
	message: who, how much, and that a manager can override. "Manager override"
	asks Ben or Matt for their name and PIN; the parent pays the same cart again
	with them (services/chargeOverride). The PIN lives only in this box and is
	cleared after every try.
-->
<script setup lang="ts">
import { nextTick, ref } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { __ } from "@/lib/translate";
import { listApprovers, type OverrideApprover } from "@/services/chargeOverride";
import { extractErrorMessage } from "@/utils";

const props = defineProps<{ message: string; busy?: boolean; error?: string }>();
const emit = defineEmits<{ approve: [{ approver: string; pin: string }] }>();

const open = ref(false);
const approvers = ref<OverrideApprover[]>([]);
const approver = ref("");
const pin = ref("");
const loadError = ref("");
const pinInput = ref<InstanceType<typeof Input> | null>(null);

async function start() {
	loadError.value = "";
	try {
		approvers.value = (await listApprovers()).filter((row) => row.has_pin);
	} catch (error) {
		loadError.value = extractErrorMessage(error);
		return;
	}
	if (!approvers.value.length) {
		loadError.value = __("No manager has set an override PIN yet.");
		return;
	}
	if (approvers.value.length === 1) approver.value = approvers.value[0].user;
	open.value = true;
	await nextTick();
	(pinInput.value?.$el as HTMLInputElement | undefined)?.focus();
}

function approve() {
	if (!approver.value || !pin.value || props.busy) return;
	const typed = pin.value;
	pin.value = "";
	emit("approve", { approver: approver.value, pin: typed });
}
</script>

<template>
	<div
		class="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2"
		data-testid="charge-refusal"
	>
		<p class="text-sm font-semibold text-amber-800 dark:text-amber-300">{{ __("Charge refused") }}</p>
		<p class="text-sm text-amber-900 dark:text-amber-200" data-testid="charge-refusal-message">
			{{ message }}
		</p>
		<Button
			v-if="!open"
			variant="outline"
			size="sm"
			data-testid="manager-override"
			:disabled="busy"
			@click="start"
		>
			{{ __("Manager override") }}
		</Button>
		<p v-if="loadError" class="text-xs font-semibold text-red-600" data-testid="manager-override-error">
			{{ loadError }}
		</p>
		<form v-if="open" class="flex flex-wrap items-end gap-2" autocomplete="off" @submit.prevent="approve">
			<label class="text-xs space-y-1">
				<span class="block font-semibold text-muted-foreground uppercase tracking-wider">{{
					__("Manager")
				}}</span>
				<select
					v-model="approver"
					class="h-9 rounded-md border border-border bg-background px-2 text-sm"
					data-testid="manager-override-approver"
				>
					<option value="" disabled>{{ __("Who approves?") }}</option>
					<option v-for="row in approvers" :key="row.user" :value="row.user">
						{{ row.full_name }}
					</option>
				</select>
			</label>
			<label class="text-xs space-y-1">
				<span class="block font-semibold text-muted-foreground uppercase tracking-wider">{{
					__("PIN")
				}}</span>
				<Input
					ref="pinInput"
					v-model="pin"
					type="password"
					inputmode="numeric"
					autocomplete="off"
					maxlength="8"
					class="w-28 tracking-widest"
					data-testid="manager-override-pin"
				/>
			</label>
			<Button
				type="submit"
				size="sm"
				:disabled="busy || !approver || !pin"
				data-testid="manager-override-approve"
			>
				{{ __("Approve and save") }}
			</Button>
		</form>
		<p
			v-if="open && error"
			class="text-xs font-semibold text-red-600"
			data-testid="manager-override-error"
		>
			{{ error }}
		</p>
	</div>
</template>
