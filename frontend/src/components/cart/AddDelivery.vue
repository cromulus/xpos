<template>
	<!-- Its own line below the customer's account row (Bill 2026-10-01, MuleCity-qajl.2). -->
	<div v-if="offered" class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="delivery-row">
		<Button
			variant="outline"
			size="sm"
			class="h-7 px-2.5 text-xs font-semibold"
			data-testid="add-delivery"
			:disabled="busy"
			@click="start"
		>
			<Truck class="w-3.5 h-3.5 me-1" />{{ cartStore.activeDelivery ? __("Change delivery") : __("Add delivery") }}
		</Button>
		<!-- The delivery on this sale: where, how far, and its day (easy to change here). -->
		<template v-if="cartStore.activeDelivery">
			<span class="min-w-0 truncate text-muted-foreground" data-testid="delivery-summary">
				{{ summary }}
			</span>
			<label class="inline-flex items-center gap-1 font-semibold">
				{{ __("Day") }}
				<input
					type="date"
					class="border border-input rounded px-1 py-0.5 bg-card"
					data-testid="delivery-day-card"
					:value="cartStore.deliveryDate"
					@change="(e) => cartStore.setDeliveryDate((e.target as HTMLInputElement).value)"
				/>
			</label>
		</template>
	</div>

	<Dialog :open="open" @update:open="(value: boolean) => !value && close()">
		<DialogContent class="max-w-lg flex flex-col gap-3">
			<DialogHeader>
				<DialogTitle class="text-base">{{ __("Add delivery") }}</DialogTitle>
				<DialogDescription class="text-xs">{{ cartStore.customerName }}</DialogDescription>
			</DialogHeader>

			<!-- Several places: the primary shipping address is chosen; search, pick another. -->
			<div v-if="!chosen" class="space-y-2" data-testid="delivery-addresses">
				<label class="flex items-center gap-2 text-xs font-semibold">
					{{ __("Delivery day") }}
					<input v-model="day" type="date" class="border border-input rounded px-1 py-0.5 bg-card" data-testid="delivery-day" />
				</label>
				<Input
					v-if="addresses.length > 1"
					v-model="search"
					:placeholder="__('Search street, town or name')"
					data-testid="delivery-search"
				/>
				<div class="max-h-72 overflow-y-auto space-y-1.5">
					<button
						v-for="address in shown"
						:key="address.name"
						type="button"
						class="w-full text-start rounded-md border px-3 py-2 text-sm flex items-start gap-3"
						:class="selected?.name === address.name ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary'"
						data-testid="delivery-address"
						:data-selected="selected?.name === address.name ? 'true' : 'false'"
						:aria-pressed="selected?.name === address.name"
						:disabled="busy"
						@click="select(address)"
					>
						<span class="flex-1 min-w-0">
							<strong v-if="address.title" class="block truncate">{{ address.title }}</strong>
							<span class="block" data-testid="delivery-address-text">{{ fullAddress(address) }}</span>
							<span class="text-xs text-muted-foreground" data-testid="delivery-address-miles">{{
								address.miles ? __("{0} mi", [String(address.miles)]) : __("no miles")
							}}</span>
							<span v-if="address.is_shipping_address" class="ms-2 text-xs text-muted-foreground">{{ __("shipping") }}</span>
						</span>
						<span class="shrink-0 text-sm font-semibold" data-testid="delivery-address-cost">{{ costText(address) }}</span>
					</button>
					<p v-if="!shown.length && addresses.length" class="text-xs text-muted-foreground">{{ __("No address matches") }}</p>
				</div>

				<!-- The chosen place has no miles: type them (priced by the policy, flagged as typed). -->
				<div v-if="selected && !selected.miles" class="flex items-center gap-2" data-testid="delivery-miles-row">
					<Input
						v-model="typedMiles"
						type="number"
						min="0"
						step="0.1"
						:placeholder="__('Miles one way')"
						data-testid="delivery-miles"
					/>
					<span class="text-xs text-muted-foreground whitespace-nowrap">{{ __("or leave empty to type the charge") }}</span>
				</div>
				<Button v-if="selected" size="sm" data-testid="delivery-use" :disabled="busy" @click="useSelected">
					{{ __("Add delivery") }}
				</Button>

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
				<p class="text-sm">{{ fullAddress(chosen.address) }}</p>
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
 * "Add delivery" on the customer card (Bill 2026-09-29, MuleCity-6nb1; picker
 * 2026-10-01, MuleCity-qajl.3).
 *
 * One address (online): quoted and added at once. Several: a dialog opens on the
 * primary shipping address, with a search box (street, town, name) and each
 * address's miles and cost; the clerk can pick another. The cost per row is the
 * till's own quote from the cached policy (`quoteOffline`); the chosen address is
 * quoted by the site when online, as before. A standing charge or free delivery
 * shows that amount on every row. An address with no miles says "no miles": the
 * clerk types the miles (priced by the policy, kept on the sale as typed) or,
 * leaving them empty, types the charge. The clerk picks the delivery day here
 * (default: the day already chosen, else today) and can change it on the card.
 * Offline it works the same from the cache, and a new address can be typed with
 * its one-way miles.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { showError, showSuccess } from "@/services/api";
import { cachedCartWeight, cachedDeliveryPolicy, customerDelivery, deliveryPolicy, quoteDelivery } from "@/composables/useDelivery";
import { useMoney } from "@/composables/useMoney";
import {
	TYPED_OFFLINE,
	defaultDeliveryAddress,
	describeAddress,
	fullAddress,
	quoteOffline,
	searchAddresses,
	type CustomerDelivery,
	type DeliveryAddress,
	type DeliveryMilesSource,
	type DeliveryPolicy,
	type DeliveryQuote,
} from "@/services/delivery";
import { extractErrorMessage, isOnline } from "@/utils";
import { nowDate } from "@/utils/datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Truck } from "lucide-vue-next";
import { __ } from "@/lib/translate";

const cartStore = useCartStore();
const posStore = usePosStore();
const { money } = useMoney();
const policy = ref<DeliveryPolicy | null>(null);
const details = ref<CustomerDelivery | null>(null);
const open = ref(false);
const busy = ref(false);
const chosen = ref<{ address: DeliveryAddress; quote: DeliveryQuote; milesSource?: DeliveryMilesSource } | null>(null);
const selected = ref<DeliveryAddress | null>(null);
const search = ref("");
const day = ref("");
const typedMiles = ref<string | number>("");
// The load's weight from the cached items, for each row's cost (the site weighs the chosen one online).
const weightLb = ref(0);
const typedAmount = ref<string | number>("");
const draft = ref({ address_line1: "", city: "", miles: "" as string | number });
// navigator.onLine is not reactive: follow the browser's online/offline events,
// and read it again when the clerk presses the button.
const online = ref(isOnline());
const syncOnline = () => (online.value = isOnline());

const addresses = computed(() => details.value?.addresses || []);
const shown = computed(() => searchAddresses(addresses.value, search.value));
const draftComplete = computed(
	() => !!draft.value.address_line1.trim() && !!draft.value.city.trim() && Number(draft.value.miles) > 0,
);
const summary = computed(() => {
	const delivery = cartStore.activeDelivery;
	if (!delivery) return "";
	const place = describeAddress(delivery.address) || __("the chosen address");
	return delivery.miles ? __("To {0} · {1} mi", [place, String(delivery.miles)]) : __("To {0} · miles not known", [place]);
});

// Offered when the site quotes delivery and the customer has somewhere to deliver to.
// Offline any named customer (not the walk-in default) may get one: the clerk can
// type a new address and its miles. Never in return mode.
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

/** The address with the miles the clerk typed for it, when it has none of its own. */
function withTypedMiles(address: DeliveryAddress): DeliveryAddress {
	const miles = Number(typedMiles.value);
	if (address.miles || !(miles > 0) || selected.value?.name !== address.name) return address;
	return { ...address, miles, miles_source: "manual" };
}

/** The row's cost, worked out at the till (same precedence and policy as the site). */
function costText(address: DeliveryAddress): string {
	if (!policy.value) return "";
	const quote = quoteOffline(policy.value, details.value, withTypedMiles(address), weightLb.value);
	return quote.amount === null ? "—" : money(quote.amount);
}

async function start() {
	const customer = cartStore.customer;
	if (!customer || !policy.value) return;
	syncOnline();
	busy.value = true;
	try {
		details.value = await customerDelivery(customer);
		chosen.value = null;
		search.value = "";
		typedMiles.value = "";
		day.value = cartStore.deliveryDate || nowDate();
		selected.value = defaultDeliveryAddress(addresses.value);
		// One address with a price (miles, or a standing / free charge): added at once.
		// Offline the picker also takes a new address, so it always opens; an address
		// with no miles opens it too, for the clerk to type them.
		const only = addresses.value.length === 1 ? addresses.value[0] : null;
		const priced = !!only?.miles || (details.value?.standing_charge || 0) > 0 || !!details.value?.no_charge;
		if (only && priced && online.value) {
			await choose(addresses.value[0]);
			return;
		}
		weightLb.value = await cachedCartWeight(lines(), policy.value.item_code);
		open.value = true;
	} catch (error) {
		showError(__("Could not add delivery: {0}", [extractErrorMessage(error)]));
	} finally {
		busy.value = false;
	}
}

function select(address: DeliveryAddress) {
	if (selected.value?.name !== address.name) typedMiles.value = "";
	selected.value = address;
}

function useSelected() {
	if (!selected.value) return;
	const address = withTypedMiles(selected.value);
	return choose(address, address !== selected.value ? "manual" : undefined);
}

async function choose(address: DeliveryAddress, milesSource?: DeliveryMilesSource) {
	busy.value = true;
	try {
		// Miles the clerk typed are priced by the policy at the till; the site knows none for this address.
		const quote =
			milesSource === "manual"
				? quoteOffline(policy.value!, details.value, address, await cachedCartWeight(lines(), policy.value!.item_code))
				: await quoteDelivery(policy.value!, cartStore.customer!.name, details.value, address, lines());
		if (quote.amount === null) {
			chosen.value = { address, quote, milesSource };
			typedAmount.value = "";
			open.value = true;
			return;
		}
		add(address, quote, quote.amount, milesSource);
	} catch (error) {
		showError(__("Could not add delivery: {0}", [extractErrorMessage(error)]));
	} finally {
		busy.value = false;
	}
}

function chooseNew() {
	return choose(
		{
			name: "",
			address_line1: draft.value.address_line1.trim(),
			city: draft.value.city.trim(),
			miles: Number(draft.value.miles),
			miles_source: TYPED_OFFLINE,
		},
		"manual",
	);
}

function useTyped() {
	if (!chosen.value) return;
	const { address, quote, milesSource } = chosen.value;
	add(address, { ...quote, description: __("Delivery (typed)") }, Number(typedAmount.value), milesSource);
}

function add(address: DeliveryAddress, quote: DeliveryQuote, amount: number, milesSource?: DeliveryMilesSource) {
	cartStore.setDelivery(policy.value!, address, quote, amount, { milesSource, date: day.value || undefined });
	showSuccess(__("Delivery to {0} added", [describeAddress(address)]));
	close();
}

function close() {
	open.value = false;
	chosen.value = null;
	draft.value = { address_line1: "", city: "", miles: "" };
}
</script>
