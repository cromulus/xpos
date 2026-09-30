<template>
	<Dialog
		:open="customerStore.showCustomerEditDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="max-w-md max-h-[80vh] flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-3">
					<div>
						<DialogTitle>{{ __("Edit Customer") }}</DialogTitle>
						<DialogDescription class="text-xs text-muted-foreground mt-0.5">
							{{ __("Update customer information") }}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div v-if="isLoadingInfo" class="flex-1 flex items-center justify-center p-8">
				<Loader2 class="w-6 h-6 animate-spin text-primary" />
			</div>

			<div v-else class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div>
					<label class="text-xs font-medium text-muted-foreground mb-1 block"
						>{{ __("Customer Name") }} *</label
					>
					<Input
						ref="customerNameInput"
						v-model="form.customer_name"
						type="text"
						:placeholder="__('Full name')"
					/>
				</div>

				<!-- Mule City (Bill 2026-09-29, MuleCity-nfxn.7): name, phone and email only.
				     Customer Group, Territory, Tax ID, Gender, Referral Code and Birthday
				     aren't used at the counter; they keep their values and stay on the desk. -->
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
							__("Mobile No")
						}}</label>
						<Input v-model="form.mobile_no" type="tel" :placeholder="__('Mobile No')" />
					</div>
					<div>
						<label class="text-xs font-medium text-muted-foreground mb-1 block">{{
							__("Email")
						}}</label>
						<Input v-model="form.email_id" type="email" :placeholder="__('Email')" />
					</div>
				</div>

				<!-- Mule City (Bill 2026-09-29): the tax exemption is set only from here, on the desk's
				     Customer form in a new tab (its Tax Category and reason; the Customer's history
				     records who). The cart shows it as a status icon. -->
				<Button
					v-if="cartStore.customer?.name"
					variant="outline"
					size="sm"
					class="w-full"
					data-testid="set-tax-exemption"
					@click="openCustomerTaxSection(cartStore.customer.name)"
				>
					{{ __("Tax exemption") }}
				</Button>

				<CustomerAddresses
					v-if="cartStore.customer?.name"
					:customer="cartStore.customer.name"
					@changed="onAddressesChanged"
				/>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="outline" class="flex-1" @click="close">
					{{ __("Cancel") }}
				</Button>
				<Button class="flex-1 font-bold" :disabled="!canSave || isSaving" @click="saveChanges">
					<Loader2 v-if="isSaving" class="w-4 h-4 animate-spin me-1" />
					{{ isSaving ? __("Saving...") : __("Save Changes") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { changedFields } from "@/utils/customerEdit";
import { ref, computed, watch, nextTick } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { showSuccess, showError } from "@/services/api";
import { openCustomerTaxSection } from "@/services/customerTax";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-vue-next";
import __ from "@/lib/translate";
import CustomerAddresses from "@/components/customer/CustomerAddresses.vue";
import type { CustomerAddress } from "@/types/pos.types";

const cartStore = useCartStore();
const customerStore = useCustomerStore();

const customerNameInput = ref<InstanceType<typeof Input> | null>(null);
const isLoadingInfo = ref(false);
const isSaving = ref(false);

const defaultForm = () => ({
	customer_name: "",
	mobile_no: "",
	email_id: "",
});

const form = ref(defaultForm());
// What the customer had when the dialog opened: only fields the cashier changed
// are saved, so a phone or email shown from the customer's Contact is not
// copied onto the Customer (Mule City, nfxn.8).
const loaded = ref(defaultForm());

const canSave = computed(() => !!form.value.customer_name.trim());

watch(
	() => customerStore.showCustomerEditDialog,
	async (isOpen) => {
		if (isOpen && cartStore.customer?.name) {
			await loadCustomerData(cartStore.customer.name);
		}
	},
);

async function loadCustomerData(customerName: string) {
	isLoadingInfo.value = true;
	try {
		const info = await customerStore.getCustomerInfo(customerName);
		if (info) {
			form.value = {
				customer_name: info.customer_name || "",
				mobile_no: info.mobile_no || "",
				email_id: info.email_id || "",
			};
			loaded.value = { ...form.value };
		}
		nextTick(() => {
			const el = customerNameInput.value?.$el as HTMLElement | undefined;
			const input = el?.querySelector?.("input") || el;
			(input as HTMLInputElement)?.focus();
		});
	} finally {
		isLoadingInfo.value = false;
	}
}

async function saveChanges() {
	if (!canSave.value || !cartStore.customer?.name) return;
	isSaving.value = true;

	try {
		const payload = changedFields(form.value, loaded.value);

		const result = await customerStore.updateCustomer(cartStore.customer.name, payload);

		// Keep what the status icons read (the customer's flags) across the save.
		cartStore.setCustomer({
			...cartStore.customer,
			name: cartStore.customer.name,
			customer_name: result.customer_name || form.value.customer_name,
			mobile_no: result.mobile_no || form.value.mobile_no,
			email_id: result.email_id || form.value.email_id,
		});

		showSuccess(__("Customer updated successfully!"));
		close();
	} catch (error: unknown) {
		showError(__("Failed to update customer: ") + ((error as Error)?.message || String(error)));
	} finally {
		isSaving.value = false;
	}
}

// The cart's "can take a delivery" icon follows an address saved here.
function onAddressesChanged(addresses: CustomerAddress[]) {
	if (!cartStore.customer) return;
	const count = addresses.filter((address) => !!address.address_line1?.trim()).length;
	cartStore.setCustomer({
		...cartStore.customer,
		xpos_has_address: count > 0,
		xpos_address_count: count,
	});
}

function close() {
	customerStore.showCustomerEditDialog = false;
	form.value = defaultForm();
}
</script>
