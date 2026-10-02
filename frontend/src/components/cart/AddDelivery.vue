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
			<!-- The site's Google miles replaced the typed ones: say so (MuleCity-ra6h). -->
			<span v-if="milesNote" class="font-semibold text-amber-700 dark:text-amber-400" data-testid="delivery-saved-miles">
				{{ milesNote }}
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
		<DialogContent class="max-w-lg flex flex-col gap-3" @escape-key-down="escapeList">
			<DialogHeader>
				<DialogTitle class="text-base">{{ __("Add delivery") }}</DialogTitle>
				<DialogDescription class="text-xs">{{ cartStore.customerName }}</DialogDescription>
			</DialogHeader>

			<label v-if="mode !== 'typed'" class="flex items-center gap-2 text-xs font-semibold">
				{{ __("Delivery day") }}
				<input v-model="day" type="date" class="border border-input rounded px-1 py-0.5 bg-card" data-testid="delivery-day" />
			</label>

			<!-- Several places: the primary shipping address is chosen; search, pick another, or add one. -->
			<div v-if="mode === 'pick'" class="space-y-2" data-testid="delivery-addresses">
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
				<div class="flex flex-wrap gap-2">
					<Button v-if="selected" size="sm" data-testid="delivery-use" :disabled="busy" @click="useSelected">
						{{ __("Add delivery") }}
					</Button>
					<Button variant="outline" size="sm" data-testid="delivery-add-address" :disabled="busy" @click="startNewAddress">
						{{ __("Add new address") }}
					</Button>
				</div>
			</div>

			<!-- A new place for this customer (Bill 2026-10-01 22:52): online the site looks
			     up its miles; offline it is saved when the till syncs, before the sale. -->
			<div v-else-if="mode === 'new'" class="space-y-2" data-testid="delivery-new-address">
				<p class="text-xs text-muted-foreground">
					{{ online ? __("New address for this customer.") : __("New address (offline): saved for this customer when the till is back online.") }}
				</p>
				<!-- Online, the street field suggests Google's addresses (MuleCity-p644). -->
				<div class="relative">
					<Input
						v-model="draft.address_line1"
						:placeholder="online && !typeahead.unavailable.value ? __('Street address (type to search)') : __('Street address')"
						role="combobox"
						aria-autocomplete="list"
						aria-controls="delivery-new-suggestions"
						:aria-expanded="typeahead.listOpen.value"
						data-testid="delivery-new-line1"
						@keydown="(event: KeyboardEvent) => typeahead.keydown(event, pickSuggestion)"
						@blur="typeahead.closeList()"
					/>
					<ul
						v-if="typeahead.listOpen.value"
						id="delivery-new-suggestions"
						role="listbox"
						class="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto rounded-md border bg-popover shadow-md"
						data-testid="delivery-new-suggestions"
					>
						<li
							v-for="(suggestion, index) in typeahead.suggestions.value"
							:key="suggestion.place_id"
							role="option"
							:aria-selected="typeahead.highlighted.value === index"
							class="cursor-pointer px-3 py-2.5 text-sm"
							:class="typeahead.highlighted.value === index ? 'bg-primary/10' : 'hover:bg-muted'"
							data-testid="delivery-new-suggestion"
							@mousedown.prevent
							@click="pickSuggestion(index)"
						>
							{{ suggestion.description }}
						</li>
					</ul>
				</div>
				<p v-if="typeahead.resolving.value" class="text-xs text-muted-foreground" data-testid="delivery-new-resolving">
					{{ __("Filling in the address…") }}
				</p>
				<p v-else-if="online && typeahead.unavailable.value" class="text-xs text-muted-foreground" data-testid="delivery-lookup-unavailable">
					{{ __("Address lookup isn't available — type the address") }}
				</p>
				<Input v-model="draft.address_line2" :placeholder="__('Address line 2 (optional)')" data-testid="delivery-new-line2" />
				<div class="grid grid-cols-3 gap-2">
					<Input v-model="draft.city" :placeholder="__('City')" data-testid="delivery-new-city" />
					<Input v-model="draft.state" :placeholder="__('State')" data-testid="delivery-new-state" />
					<Input v-model="draft.pincode" :placeholder="__('ZIP')" data-testid="delivery-new-zip" />
				</div>
				<div class="grid grid-cols-2 gap-2">
					<Input v-model="draft.title" :placeholder="__('Name for this place (optional)')" data-testid="delivery-new-title" />
					<Input
						v-model="draft.miles"
						type="number"
						min="0"
						step="0.1"
						:placeholder="__('Miles one way')"
						data-testid="delivery-new-miles"
					/>
				</div>
				<!-- The picked address, as Google knows it: its miles from HQ (the site saves them). -->
				<p v-if="pickedNow" class="text-xs text-muted-foreground" data-testid="delivery-new-found">
					<span v-if="pickedNow.delivery_miles != null" data-testid="delivery-new-found-miles">{{
						__("Google: {0} mi one way", [String(pickedNow.delivery_miles)])
					}}</span>
					<span v-else>{{ __("Google found the address but not its miles") }}</span>
					<span v-if="!pickedNow.validated" class="ms-1 font-semibold text-amber-700" data-testid="delivery-new-not-validated">{{
						__("· check the street number")
					}}</span>
				</p>
				<p v-if="formMilesNote" class="text-xs font-semibold text-amber-700" data-testid="delivery-new-saved-miles">
					{{ formMilesNote }}
				</p>
				<p v-if="milesAsked" class="text-xs font-semibold text-amber-700" data-testid="delivery-new-miles-asked">
					{{ __("The miles to this address could not be found. Type the one-way miles, or leave them empty to type the charge.") }}
				</p>
				<p v-else class="text-xs text-muted-foreground">
					{{
						online
							? __("The miles are looked up when it is saved; type them only if you know them.")
							: __("Type the one-way miles to price it now, or leave them empty to type the charge.")
					}}
				</p>
				<div class="flex flex-wrap gap-2">
					<Button size="sm" data-testid="delivery-new-address-use" :disabled="!draftComplete || busy" @click="saveNewAddress">
						{{ __("Deliver here") }}
					</Button>
					<Button
						v-if="addresses.length"
						variant="outline"
						size="sm"
						data-testid="delivery-new-address-back"
						:disabled="busy"
						@click="mode = 'pick'"
					>
						{{ __("Back to addresses") }}
					</Button>
				</div>
			</div>

			<!-- No standing charge and no miles: the clerk types the charge. -->
			<div v-else-if="chosen" class="space-y-2" data-testid="delivery-typed">
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
 * 2026-10-01, MuleCity-qajl.3; the address rule, Bill 2026-10-01 22:52).
 *
 * Offered for a named customer that is not the walk-in account, on a sale (not a
 * return), when the site quotes delivery, online or offline. A delivery needs a
 * real customer; the server refuses one on a walk-in sale too.
 *
 * Which address: the customer's only address; else their only Shipping address;
 * else the clerk picks (the dialog opens on the primary shipping address, with a
 * search box and each address's miles and cost); or adds a new one right here.
 * A customer with no address goes straight to the add form. The chosen address
 * is quoted at once when it has a price (miles, or a standing / free charge);
 * one with no miles opens the dialog for the clerk to type them. "Change
 * delivery" always opens the picker.
 *
 * A new address (street, line 2, city, state, ZIP, an optional name and miles):
 * online the site makes it and looks up its miles; if it cannot, the form asks
 * for typed miles. Offline it is queued and made at sync, before the sale
 * (services/addressQueue.ts). Either way the customer's cached addresses get it.
 * The clerk picks the delivery day here (default: the day already chosen, else
 * today) and can change it on the card.
 *
 * Online, the new address's street field is a Google typeahead (MuleCity-p644,
 * composables/useAddressTypeahead.ts): a pick fills street, line 2, city, state
 * and ZIP, shows Google's miles, and the save carries its county and point. If
 * the clerk then changes the street, city, state or ZIP, the pick is dropped.
 * Offline, or when the site cannot look up, the form is typed as before.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { showError, showSuccess } from "@/services/api";
import {
	addDeliveryAddress,
	cachedCartWeight,
	cachedDeliveryPolicy,
	customerDelivery,
	deliveryPolicy,
	quoteDelivery,
} from "@/composables/useDelivery";
import { useMoney } from "@/composables/useMoney";
import {
	autoDeliveryAddress,
	defaultDeliveryAddress,
	deliveryOffered,
	describeAddress,
	fullAddress,
	isLocalAddress,
	quoteOffline,
	searchAddresses,
	type CustomerDelivery,
	type DeliveryAddress,
	type DeliveryMilesSource,
	type DeliveryPolicy,
	type DeliveryQuote,
} from "@/services/delivery";
import { cachedAddress, withAddress, type AddedAddress } from "@/services/addressQueue";
import { useAddressTypeahead } from "@/composables/useAddressTypeahead";
import type { ResolvedAddress } from "@/services/addressLookup";
import { extractErrorMessage, isOnline } from "@/utils";
import { nowDate } from "@/utils/datetime";
import { savedMilesNote } from "@/utils/savedMiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Truck } from "lucide-vue-next";
import { __ } from "@/lib/translate";

type Mode = "pick" | "new" | "typed";
const EMPTY_DRAFT = { address_line1: "", address_line2: "", city: "", state: "NC", pincode: "", title: "", miles: "" as string | number };

const cartStore = useCartStore();
const posStore = usePosStore();
const { money } = useMoney();
const policy = ref<DeliveryPolicy | null>(null);
const details = ref<CustomerDelivery | null>(null);
const open = ref(false);
const busy = ref(false);
const mode = ref<Mode>("pick");
const chosen = ref<{ address: DeliveryAddress; quote: DeliveryQuote; milesSource?: DeliveryMilesSource } | null>(null);
const selected = ref<DeliveryAddress | null>(null);
const search = ref("");
const day = ref("");
const typedMiles = ref<string | number>("");
// The load's weight from the cached items, for each row's cost (the site weighs the chosen one online).
const weightLb = ref(0);
const typedAmount = ref<string | number>("");
const draft = ref({ ...EMPTY_DRAFT });
// The site made the address but found no miles: the form asks for them (and keeps the address).
const milesAsked = ref(false);
const pendingAdded = ref<AddedAddress | null>(null);
// "Saved: 0.8 mi (Google route), you typed 3 mi": on the delivery row for the
// address it was said of, and in the form while it is still open (MuleCity-ra6h).
const savedMiles = ref<{ address: string; note: string } | null>(null);
const formMilesNote = ref("");
const milesNote = computed(() =>
	savedMiles.value && cartStore.activeDelivery?.address?.name === savedMiles.value.address ? savedMiles.value.note : "",
);
// navigator.onLine is not reactive: follow the browser's online/offline events,
// and read it again when the clerk presses the button.
const online = ref(isOnline());
const syncOnline = () => (online.value = isOnline());
const typeahead = useAddressTypeahead({ online });
// The address the clerk picked from Google's suggestions (while the form still shows it).
const picked = ref<ResolvedAddress | null>(null);
const PICKED_FIELDS = ["address_line1", "city", "state", "pincode"] as const;
const pickedNow = computed(() => {
	const place = picked.value;
	if (!place) return null;
	const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
	return PICKED_FIELDS.every((field) => same(draft.value[field], place[field])) ? place : null;
});

watch(
	() => draft.value.address_line1,
	(text) => {
		if (mode.value !== "new" || !open.value) return;
		// The pick filled it: nothing to look up.
		if (picked.value && text === picked.value.address_line1) return;
		syncOnline();
		typeahead.typed(text);
	},
);

async function pickSuggestion(index: number) {
	const place = await typeahead.pick(index);
	if (!place) return;
	picked.value = place;
	draft.value = {
		...draft.value,
		address_line1: place.address_line1 || draft.value.address_line1,
		address_line2: place.address_line2 || "",
		city: place.city || draft.value.city,
		state: place.state || draft.value.state,
		pincode: place.pincode || draft.value.pincode,
	};
}

/** Esc closes the suggestions first, the dialog only after. */
function escapeList(event: Event) {
	if (!typeahead.listOpen.value) return;
	event.preventDefault();
	typeahead.closeList();
}

const addresses = computed(() => details.value?.addresses || []);
const shown = computed(() => searchAddresses(addresses.value, search.value));
const draftMiles = computed(() => (draft.value.miles === "" ? null : Number(draft.value.miles)));
const draftComplete = computed(
	() =>
		!!draft.value.address_line1.trim() &&
		!!draft.value.city.trim() &&
		!!draft.value.state.trim() &&
		!!draft.value.pincode.trim() &&
		(draftMiles.value === null || draftMiles.value > 0),
);
const summary = computed(() => {
	const delivery = cartStore.activeDelivery;
	if (!delivery) return "";
	const place = describeAddress(delivery.address) || __("the chosen address");
	return delivery.miles ? __("To {0} · {1} mi", [place, String(delivery.miles)]) : __("To {0} · miles not known", [place]);
});

const offered = computed(() =>
	deliveryOffered({
		policy: policy.value,
		customer: cartStore.customer?.name,
		defaultCustomer: posStore.defaultCustomer,
		isReturnMode: cartStore.isReturnMode,
	}),
);

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

/** It has a price without asking: its miles, or the customer's standing or free charge. */
function priced(address: DeliveryAddress): boolean {
	return !!address.miles || (details.value?.standing_charge || 0) > 0 || !!details.value?.no_charge;
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
		resetDraft();
		day.value = cartStore.deliveryDate || nowDate();
		const changing = !!cartStore.activeDelivery;
		if (!addresses.value.length) {
			// No address yet: straight to the add form.
			mode.value = "new";
			open.value = true;
			return;
		}
		// The one address, or the one Shipping address, is used without asking;
		// "Change delivery" always shows the list.
		const auto = changing ? null : autoDeliveryAddress(addresses.value);
		if (auto && priced(auto)) {
			await choose(auto);
			return;
		}
		selected.value = auto || defaultDeliveryAddress(addresses.value);
		weightLb.value = await cachedCartWeight(lines(), policy.value.item_code);
		mode.value = "pick";
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
			mode.value = "typed";
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

function resetDraft() {
	draft.value = { ...EMPTY_DRAFT };
	milesAsked.value = false;
	pendingAdded.value = null;
	formMilesNote.value = "";
	picked.value = null;
	// One Google session per address form.
	typeahead.newSession();
}

function startNewAddress() {
	resetDraft();
	mode.value = "new";
}

/** Save the new address (online: the site; offline: the queue), then deliver there. */
async function saveNewAddress() {
	const customer = cartStore.customer;
	if (!customer || !draftComplete.value) return;
	syncOnline();
	const typed = draftMiles.value;
	// The site found no miles last time and none were typed: deliver there, the clerk types the charge.
	if (pendingAdded.value && !typed) return deliverToNew(pendingAdded.value);
	busy.value = true;
	try {
		const added = await addDeliveryAddress(
			customer.name,
			{
				address_line1: draft.value.address_line1.trim(),
				address_line2: draft.value.address_line2.trim() || null,
				city: draft.value.city.trim(),
				state: draft.value.state.trim(),
				pincode: draft.value.pincode.trim(),
				title: draft.value.title.trim() || null,
				miles: typed,
				// A Google pick the form still shows: its county and point go on the Address.
				county: pickedNow.value?.county || null,
				latitude: pickedNow.value?.latitude ?? null,
				longitude: pickedNow.value?.longitude ?? null,
			},
			{ first: !addresses.value.length },
		);
		const address = cachedAddress(added);
		// Google's miles won over the typed ones: tell the clerk (kept typed only when Google had none).
		const note = savedMilesNote(typed, added);
		formMilesNote.value = note;
		savedMiles.value = note && added.name ? { address: added.name, note } : null;
		// The picker and the cached customer row show it at once.
		details.value = withAddress(details.value, address);
		customer.xpos_delivery = details.value;
		if (added.miles_pending && added.quote?.amount == null && !isLocalAddress(added.name) && !milesAsked.value) {
			// Online, the site could not find its miles: ask for them (or go on and type the charge).
			milesAsked.value = true;
			pendingAdded.value = added;
			return;
		}
		busy.value = false;
		await deliverToNew(added);
	} catch (error) {
		showError(__("Could not save the address: {0}", [extractErrorMessage(error)]));
	} finally {
		busy.value = false;
	}
}

function deliverToNew(added: AddedAddress) {
	const address = cachedAddress(added);
	// Miles typed for a place the till made offline are the clerk's: priced at the till and flagged.
	const typed = isLocalAddress(address.name) && !!address.miles;
	return choose(address, typed ? "manual" : undefined);
}

function useTyped() {
	if (!chosen.value) return;
	const { address, quote, milesSource } = chosen.value;
	add(address, { ...quote, description: __("Delivery (typed)") }, Number(typedAmount.value), milesSource);
}

function add(address: DeliveryAddress, quote: DeliveryQuote, amount: number, milesSource?: DeliveryMilesSource) {
	cartStore.setDelivery(policy.value!, address, quote, amount, { milesSource, date: day.value || undefined });
	const note = savedMiles.value?.address === address.name ? savedMiles.value.note : "";
	showSuccess(
		note
			? __("Delivery to {0} added. {1}", [describeAddress(address), note])
			: __("Delivery to {0} added", [describeAddress(address)]),
	);
	close();
}

function close() {
	open.value = false;
	chosen.value = null;
	mode.value = "pick";
	resetDraft();
}
</script>
