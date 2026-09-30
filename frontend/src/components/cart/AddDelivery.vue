<template>
	<Button
		v-if="offered"
		variant="link"
		size="sm"
		class="h-auto p-0 text-xs font-semibold"
		data-testid="add-delivery"
		:disabled="busy"
		@click="start"
	>
		<Truck class="w-3 h-3 me-1" />{{ __("Add delivery") }}
	</Button>

	<Dialog :open="open" @update:open="(value: boolean) => !value && close()">
		<DialogContent class="max-w-md flex flex-col gap-3">
			<DialogHeader>
				<DialogTitle class="text-base">{{ __("Add delivery") }}</DialogTitle>
				<DialogDescription class="text-xs">{{ cartStore.customerName }}</DialogDescription>
			</DialogHeader>

			<!-- Several places: pick where it goes. -->
			<div v-if="!chosen" class="space-y-2" data-testid="delivery-addresses">
				<button
					v-for="address in addresses"
					:key="address.name"
					type="button"
					class="w-full text-start rounded-md border border-border px-3 py-2 text-sm hover:border-primary"
					data-testid="delivery-address"
					:disabled="busy"
					@click="choose(address)"
				>
					{{ describeAddress(address)
					}}<span v-if="address.miles" class="text-xs text-muted-foreground"> · {{ address.miles }} mi</span>
				</button>

				<!-- Offline, a new place: the clerk types the one-way miles; the sale and address are flagged. -->
				<div v-if="!online" class="space-y-2 rounded-md border border-dashed border-border p-2.5" data-testid="delivery-new-address">
					<p class="text-xs text-muted-foreground">{{ __("New address (offline): type the one-way driving miles.") }}</p>
					<Input v-model="draft.address_line1" :placeholder="__('Street address')" />
					<div class="grid grid-cols-2 gap-2">
						<Input v-model="draft.city" :placeholder="__('City')" />
						<Input v-model="draft.miles" type="number" min="0" step="0.1" :placeholder="__('Miles one way')" />
					</div>
					<Button size="sm" data-testid="delivery-new-address-use" :disabled="!draftComplete || busy" @click="chooseNew">
						{{ __("Deliver here") }}
					</Button>
				</div>
			</div>

			<!-- No standing charge and no miles: the clerk types the charge. -->
			<div v-else class="space-y-2" data-testid="delivery-typed">
				<p class="text-sm">{{ describeAddress(chosen.address) }}</p>
				<p class="text-xs text-muted-foreground">{{ chosen.quote.description }}</p>
				<Input v-model="typedAmount" type="number" min="0" step="0.01" :placeholder="__('Delivery charge')" data-testid="delivery-amount" />
				<Button size="sm" data-testid="delivery-amount-use" :disabled="!(Number(typedAmount) >= 0) || typedAmount === ''" @click="useTyped">
					{{ __("Add delivery") }}
				</Button>
			</div>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
/**
 * "Add delivery" on the cart (Bill 2026-09-29, MuleCity-6nb1). For a customer
 * with an address: one address is quoted straight away; several are listed
 * (street and town) first. The chosen address becomes the sale's shipping
 * address and one delivery line is added (or updated) at the site's quote.
 * No quote ("none"): the clerk types the charge. Offline, the till prices it
 * from its cache, and a new address can be typed with its one-way miles.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { showError, showSuccess } from "@/services/api";
import { cachedDeliveryPolicy, customerDelivery, deliveryPolicy, quoteDelivery } from "@/composables/useDelivery";
import {
	TYPED_OFFLINE,
	describeAddress,
	type CustomerDelivery,
	type DeliveryAddress,
	type DeliveryPolicy,
	type DeliveryQuote,
} from "@/services/delivery";
import { extractErrorMessage, isOnline } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Truck } from "lucide-vue-next";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const posStore = usePosStore();
const policy = ref<DeliveryPolicy | null>(null);
const details = ref<CustomerDelivery | null>(null);
const open = ref(false);
const busy = ref(false);
const chosen = ref<{ address: DeliveryAddress; quote: DeliveryQuote } | null>(null);
const typedAmount = ref<string | number>("");
const draft = ref({ address_line1: "", city: "", miles: "" as string | number });
// navigator.onLine is not reactive: follow the browser's online/offline events,
// and read it again when the clerk presses the button.
const online = ref(isOnline());
const syncOnline = () => (online.value = isOnline());

const addresses = computed(() => details.value?.addresses || []);
const draftComplete = computed(
	() => !!draft.value.address_line1.trim() && !!draft.value.city.trim() && Number(draft.value.miles) > 0,
);

// Offered when the site quotes delivery and the customer has somewhere to deliver to.
// Offline any named customer (not the walk-in default) may get one: the clerk can
// type a new address and its miles.
const offered = computed(() => {
	const customer = cartStore.customer;
	if (!policy.value?.item || !customer || cartStore.isReturnMode) return false;
	if (!online.value) return customer.name !== posStore.defaultCustomer;
	return (customer.xpos_address_count || 0) > 0 || !!customer.xpos_has_address || !!customer.xpos_delivery?.addresses?.length;
});

onUnmounted(() => {
	window.removeEventListener("online", syncOnline);
	window.removeEventListener("offline", syncOnline);
});

onMounted(async () => {
	window.addEventListener("online", syncOnline);
	window.addEventListener("offline", syncOnline);
	policy.value = (await cachedDeliveryPolicy()) || (await deliveryPolicy().catch(() => null));
});

function lines() {
	return cartStore.items.map((item) => ({
		item_code: item.item_code,
		qty: item.qty,
		conversion_factor: item.conversion_factor || 1,
	}));
}

async function start() {
	const customer = cartStore.customer;
	if (!customer || !policy.value) return;
	syncOnline();
	busy.value = true;
	try {
		details.value = await customerDelivery(customer);
		chosen.value = null;
		// Offline the picker also takes a new address, so it always opens.
		if (addresses.value.length === 1 && online.value) await choose(addresses.value[0]);
		else open.value = true;
	} catch (error) {
		showError(__("Could not add delivery: {0}", [extractErrorMessage(error)]));
	} finally {
		busy.value = false;
	}
}

async function choose(address: DeliveryAddress) {
	busy.value = true;
	try {
		const quote = await quoteDelivery(policy.value!, cartStore.customer!.name, details.value, address, lines());
		if (quote.amount === null) {
			chosen.value = { address, quote };
			typedAmount.value = "";
			open.value = true;
			return;
		}
		add(address, quote, quote.amount);
	} catch (error) {
		showError(__("Could not add delivery: {0}", [extractErrorMessage(error)]));
	} finally {
		busy.value = false;
	}
}

function chooseNew() {
	return choose({
		name: "",
		address_line1: draft.value.address_line1.trim(),
		city: draft.value.city.trim(),
		miles: Number(draft.value.miles),
		miles_source: TYPED_OFFLINE,
	});
}

function useTyped() {
	if (!chosen.value) return;
	const { address, quote } = chosen.value;
	add(address, { ...quote, description: __("Delivery (typed)") }, Number(typedAmount.value));
}

function add(address: DeliveryAddress, quote: DeliveryQuote, amount: number) {
	cartStore.setDelivery(policy.value!, address, quote, amount);
	showSuccess(__("Delivery to {0} added", [describeAddress(address)]));
	close();
}

function close() {
	open.value = false;
	chosen.value = null;
	draft.value = { address_line1: "", city: "", miles: "" };
}
</script>
