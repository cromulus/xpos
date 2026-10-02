<template>
	<!-- Orders in flight next to the customer's name (Bill 2026-10-01, MuleCity-mxwy.10, zstm.23).
	     Ready for pickup stands out; offline it shows the last known count with its time, or nothing. -->
	<button
		v-if="summary && summary.inFlight > 0"
		type="button"
		data-testid="customer-orders-indicator"
		:data-ready="summary.ready"
		class="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold border transition-colors"
		:class="
			summary.ready
				? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
				: 'bg-background text-foreground border-border hover:border-primary'
		"
		:title="title"
		@click.stop="open"
	>
		<PackageCheck v-if="summary.ready" class="w-3.5 h-3.5" />
		<Clock v-else class="w-3.5 h-3.5" />
		<span>{{ text }}</span>
		<span v-if="!live" class="font-normal opacity-80">({{ fetchedAtText(fetchedAt) }})</span>
	</button>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import { Clock, PackageCheck } from "lucide-vue-next";
import { useCartStore } from "@/stores/cartStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { useOpenOrdersStore } from "@/stores/openOrdersStore";
import { fetchedAtText, summarizeOrders } from "@/utils/openOrders";
import __ from "@/lib/translate";

const router = useRouter();
const cartStore = useCartStore();
const offline = useOfflineStore();
const orders = useOpenOrdersStore();

const scope = computed(() => orders.scopeOf(cartStore.customer?.name));
const known = computed(() => (scope.value ? orders.latest[scope.value] ?? null : null));
const summary = computed(() => (known.value ? summarizeOrders(known.value.rows) : null));
const live = computed(() => !!known.value?.live);
const fetchedAt = computed(() => known.value?.fetchedAt ?? 0);

const text = computed(() => {
	const s = summary.value!;
	if (s.ready) return s.ready === 1 ? __("1 ready") : __("{0} ready", [s.ready]);
	return s.inFlight === 1 ? __("1 order") : __("{0} orders", [s.inFlight]);
});
const title = computed(() => {
	const s = summary.value!;
	const parts = [__("{0} in flight", [s.inFlight])];
	if (s.ready) parts.push(__("{0} ready for pickup", [s.ready]));
	if (!live.value) parts.push(__("last known, as of {0}", [fetchedAtText(fetchedAt.value)]));
	return parts.join(" · ") + " — " + __("open their orders");
});

function open() {
	router.push({ name: "orders", query: { customer: scope.value } });
}

/** The store keeps each customer's answer under their own key, so a late reply never lands on another customer. */
async function refresh() {
	if (!scope.value) return;
	try {
		await orders.load(scope.value);
	} catch {
		// A server refusal leaves the last answer in place; the badge never claims "no orders".
	}
}

watch(scope, refresh, { immediate: true });
// Back online, or a sale finished (the basket emptied): the counts may have changed.
watch(
	() => offline.isOnline,
	(online) => {
		if (online) refresh();
	},
);
watch(
	() => cartStore.isEmpty,
	(empty) => {
		if (empty) refresh();
	},
);
</script>
