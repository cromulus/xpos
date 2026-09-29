<template>
	<div class="space-y-2" data-testid="customer-addresses">
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-muted-foreground">{{ __("Addresses") }}</span>
			<Button
				v-if="!editing"
				variant="link"
				size="sm"
				class="h-auto p-0 text-xs"
				data-testid="add-address"
				:disabled="!online"
				@click="startEdit(null)"
			>
				{{ __("Add address") }}
			</Button>
		</div>

		<p v-if="!addresses.length && !editing" class="text-xs text-muted-foreground">
			{{ __("No address on file") }}
		</p>

		<div
			v-for="address in addresses"
			v-show="editing?.name !== address.name"
			:key="address.name"
			class="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
			data-testid="address-row"
		>
			<span>{{ describe(address) }}</span>
			<Button
				v-if="!editing"
				variant="link"
				size="sm"
				class="h-auto p-0 text-xs shrink-0"
				:disabled="!online"
				@click="startEdit(address)"
			>
				{{ __("Edit") }}
			</Button>
		</div>

		<div v-if="editing" class="space-y-2 rounded-md border border-primary/40 p-2.5" data-testid="address-form">
			<Input v-model="draft.address_line1" :placeholder="__('Street address')" />
			<Input v-model="draft.address_line2" :placeholder="__('Apartment, suite, etc.')" />
			<div class="grid grid-cols-3 gap-2">
				<Input v-model="draft.city" :placeholder="__('City')" />
				<Input v-model="draft.state" :placeholder="__('State')" />
				<Input v-model="draft.pincode" :placeholder="__('ZIP')" />
			</div>
			<p v-if="!complete" class="text-xs text-muted-foreground">
				{{ __("Enter both street address and city to save the address.") }}
			</p>
			<div class="flex justify-end gap-2">
				<Button variant="outline" size="sm" @click="editing = null">{{ __("Cancel") }}</Button>
				<Button size="sm" data-testid="save-address" :disabled="!complete || saving" @click="save">
					{{ __("Save address") }}
				</Button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
/**
 * The customer's addresses in Edit Customer (Bill 2026-09-29, MuleCity-nfxn.6:
 * "Need add addresses in customer edit!"). Native ERPNext Addresses linked to
 * the Customer: add one, or correct an existing one. An address is what the
 * cart's "can take a delivery" icon reads. Needs the server, so it is offered
 * only online.
 */
import { computed, ref, watch } from "vue";
import { useCustomerStore } from "@/stores/customerStore";
import { showError } from "@/services/api";
import { isOnline, extractErrorMessage } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CustomerAddress } from "@/types/pos.types";
import __ from "@/lib/translate";

const props = defineProps<{ customer: string }>();
const emit = defineEmits<{ (e: "changed", addresses: CustomerAddress[]): void }>();

const customerStore = useCustomerStore();
const addresses = ref<CustomerAddress[]>([]);
const editing = ref<{ name: string | null } | null>(null);
const saving = ref(false);
const blank = () => ({ address_line1: "", address_line2: "", city: "", state: "", pincode: "" });
const draft = ref(blank());
const online = computed(() => isOnline());
const complete = computed(() => !!draft.value.address_line1.trim() && !!draft.value.city.trim());

function describe(address: CustomerAddress): string {
	const place = [address.city, [address.state, address.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
	return [address.address_line1, address.address_line2, place].filter(Boolean).join(", ");
}

async function load() {
	addresses.value = props.customer ? await customerStore.fetchAddresses(props.customer) : [];
}

function startEdit(address: CustomerAddress | null) {
	editing.value = { name: address?.name ?? null };
	draft.value = address
		? {
				address_line1: address.address_line1 || "",
				address_line2: address.address_line2 || "",
				city: address.city || "",
				state: address.state || "",
				pincode: address.pincode || "",
			}
		: blank();
}

async function save() {
	if (!editing.value || !complete.value) return;
	saving.value = true;
	try {
		if (editing.value.name) {
			await customerStore.updateAddress(props.customer, editing.value.name, { ...draft.value });
		} else {
			await customerStore.createAddress({ customer: props.customer, ...draft.value });
		}
		editing.value = null;
		await load();
		emit("changed", addresses.value);
	} catch (error) {
		showError(__("Failed to save the address: {0}", [extractErrorMessage(error)]));
	} finally {
		saving.value = false;
	}
}

watch(() => props.customer, load, { immediate: true });
</script>
