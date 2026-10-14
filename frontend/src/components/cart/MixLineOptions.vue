<template>
	<!-- A custom mix to order (Mule City MuleCity-erqg.17): its pull list, the fixes
	     when none passes, its stored grain and bulk choices, and Send to desk. -->
	<div class="mt-1 space-y-1 text-[10px]" data-testid="mix-line-options" @click.stop>
		<p v-if="summary" class="text-muted-foreground" data-testid="mix-pull-summary">{{ summary }}</p>

		<div v-if="fixes.length" class="space-y-0.5" data-testid="mix-pull-fixes">
			<button
				v-for="(fix, i) in fixes"
				:key="i"
				type="button"
				class="block w-full text-left rounded border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50"
				:disabled="fix.owner_only"
				:title="fix.owner_only ? __('An owner chooses this at the desk.') : ''"
				:data-testid="`mix-pull-fix-${fix.kind}`"
				@click="useFix(fix)"
			>
				<span class="font-semibold">{{ fix.label }}</span>
				<span class="text-muted-foreground">: {{ fix.consequence }}</span>
				<span v-if="fix.owner_only" class="text-muted-foreground"> ({{ __("owner, at the desk") }})</span>
			</button>
		</div>

		<div class="flex items-center gap-1 flex-wrap">
			<label class="flex items-center gap-1">
				{{ __("Stored grain") }}
				<select
					class="border border-input rounded px-0.5 bg-card"
					:value="item.mule_stored_grain_use || ''"
					data-testid="mix-grain-use"
					@change="setGrain(($event.target as HTMLSelectElement).value)"
				>
					<option value="">{{ __("All") }}</option>
					<option value="None">{{ __("None") }}</option>
					<option value="Up to">{{ __("Up to") }}</option>
				</select>
			</label>
			<input
				v-if="item.mule_stored_grain_use === 'Up to'"
				type="number"
				min="0"
				step="1"
				class="w-14 border border-input rounded px-0.5 bg-card"
				:value="item.mule_stored_grain_use_lbs || ''"
				:placeholder="__('lb')"
				data-testid="mix-grain-lbs"
				@change="setGrainLbs(($event.target as HTMLInputElement).value)"
			/>
			<label class="flex items-center gap-1 ms-2">
				<input
					type="checkbox"
					:checked="!!item.mule_bulk_no_bags"
					data-testid="mix-bulk"
					@change="cartStore.setMixLineFields(item.uid, { mule_bulk_no_bags: ($event.target as HTMLInputElement).checked ? 1 : null })"
				/>
				{{ __("Bulk to truck (no bags)") }}
			</label>
			<button type="button" class="ms-auto underline" data-testid="mix-send-to-desk" @click="openDesk">
				{{ __("Send to desk") }}
			</button>
		</div>

		<div v-if="showDesk" class="rounded border border-border p-1 space-y-1" data-testid="mix-desk-panel">
			<label class="flex items-center gap-1">
				{{ __("Assign to") }}
				<select v-model="assignTo" class="border border-input rounded px-0.5 bg-card" data-testid="mix-desk-user">
					<option v-for="u in cartStore.deskUsers" :key="u.user" :value="u.user">{{ u.name }}</option>
				</select>
			</label>
			<textarea
				v-model="note"
				rows="2"
				class="w-full border border-input rounded px-0.5 bg-card"
				:placeholder="__('Note for the desk')"
				data-testid="mix-desk-note"
			/>
			<p v-if="deskError" class="text-destructive">{{ deskError }}</p>
			<div class="flex gap-2">
				<button type="button" class="font-semibold underline" :disabled="!assignTo || sending" data-testid="mix-desk-send" @click="send">
					{{ sending ? __("Sending…") : __("Save as a draft order and assign") }}
				</button>
				<button type="button" class="underline" @click="showDesk = false">{{ __("Cancel") }}</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useCartStore } from "@/stores/cartStore";
import { pullSummary, qtyForSize, type PullFix } from "@/utils/mixPull";
import { extractErrorMessage } from "@/utils";
import __ from "@/lib/translate";

const props = defineProps({
	item: { type: Object, required: true },
	index: { type: Number, required: true },
});
const emit = defineEmits(["update-qty"]);

const cartStore = useCartStore();
const order = computed(() => cartStore.quotedOrder(props.item.uid));
const summary = computed(() => pullSummary(order.value?.pull));
const fixes = computed<PullFix[]>(() => (order.value?.pull?.blocked ? order.value?.pull_remedies || [] : []));

function useFix(fix: PullFix): void {
	if (fix.owner_only) return;
	if (fix.kind === "size" && fix.value) {
		// A size is just a different quantity: the site plans it from scratch.
		cartStore.setMixLineFields(props.item.uid, { mule_pull_remedy_json: null });
		emit("update-qty", qtyForSize(props.item.qty, order.value?.pull?.asked_lb || 0, fix.value));
		return;
	}
	cartStore.setMixLineFields(props.item.uid, { mule_pull_remedy_json: JSON.stringify(fix.apply) });
}

function setGrain(value: string): void {
	cartStore.setMixLineFields(props.item.uid, {
		mule_stored_grain_use: value || null,
		mule_stored_grain_use_lbs: value === "Up to" ? props.item.mule_stored_grain_use_lbs || null : null,
	});
}

function setGrainLbs(value: string): void {
	const lbs = Number(value);
	cartStore.setMixLineFields(props.item.uid, { mule_stored_grain_use_lbs: lbs > 0 ? lbs : null });
}

const showDesk = ref(false);
const assignTo = ref("");
const note = ref("");
const sending = ref(false);
const deskError = ref("");

async function openDesk(): Promise<void> {
	deskError.value = "";
	showDesk.value = true;
	try {
		const users = await cartStore.loadDeskUsers();
		if (!assignTo.value && users.length) assignTo.value = users[0].user;
	} catch (error) {
		deskError.value = extractErrorMessage(error);
	}
}

async function send(): Promise<void> {
	sending.value = true;
	deskError.value = "";
	try {
		await cartStore.sendMixToDesk(props.item.uid, assignTo.value, note.value);
		showDesk.value = false;
	} catch (error) {
		deskError.value = extractErrorMessage(error);
	} finally {
		sending.value = false;
	}
}
</script>
