<template>
	<!-- The one status control (Bill 2026-10-01, MuleCity-qajl.1): connection, pending sales and the
	     offline cache in one label; the cache detail and pending sales sit behind it. -->
	<details v-if="pos.useOfflineMode || offline.hasPending" class="relative text-xs" data-testid="status-control">
		<summary
			class="cursor-pointer list-none rounded px-3 py-2 flex items-center gap-1.5"
			:class="STATUS_TONE_CLASS[summary.tone]"
			:title="summary.label"
			data-testid="status-label"
		>
			<Loader2 v-if="offline.isSyncing || loading" class="w-4 h-4 animate-spin" />
			<WifiOff v-else-if="!offline.isOnline" class="w-4 h-4" />
			<CloudUpload v-else-if="offline.hasPending" class="w-4 h-4" />
			<Wifi v-else class="w-4 h-4" />
			<span class="whitespace-nowrap">{{ summary.label }}</span>
		</summary>
		<div
			class="absolute right-0 top-full z-50 w-80 rounded border bg-background p-4 shadow-lg space-y-3 text-foreground"
			aria-live="polite"
		>
			<template v-if="pos.useOfflineMode">
				<p>{{ __("Cache for this register’s eligible customers and products") }}</p>
				<div v-for="kind in kinds" :key="kind">
					<strong>{{ __(kind) }}: </strong>
					<span v-if="!state(kind)">{{ __("Not checked this session") }}</span>
					<span v-else-if="state(kind)!.loading">{{ __("Refreshing…") }}</span>
					<span v-else-if="state(kind)!.error">{{ __("Refresh failed — retry") }}</span>
					<span v-else
						>{{ state(kind)!.count.toLocaleString() }}
						{{
							state(kind)!.complete
								? __("loaded — all eligible")
								: __("loaded — limited by settings")
						}}<br />{{ __("Refreshed") }}
						{{ new Date(state(kind)!.updatedAt).toLocaleTimeString() }}</span
					>
				</div>
			</template>
			<p>
				{{ offline.pendingCount }} {{ __("pending sales") }} · {{ offline.deadLetterCount }}
				{{ __("need attention") }}
			</p>
			<p v-if="pos.useOfflineMode">{{ __("Stock reflects the last refresh and may change at another till.") }}</p>
			<div class="flex flex-wrap gap-2">
				<button
					v-if="pos.useOfflineMode"
					class="rounded border px-3 py-2"
					:disabled="!offline.isOnline || loading"
					@click="refresh"
				>
					{{ __("Refresh now") }}
				</button>
				<button
					class="rounded border px-3 py-2"
					data-testid="status-open-pending"
					@click="emit('open-pending')"
				>
					{{ __("Pending sales") }}
				</button>
			</div>
		</div>
	</details>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { CloudUpload, Loader2, Wifi, WifiOff } from "lucide-vue-next";
import { useCacheStatus } from "@/stores/cacheStatus";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useItemStore } from "@/stores/itemStore";
import { STATUS_TONE_CLASS, statusSummary } from "@/utils/statusSummary";
import { __ } from "@/lib/translate";
const emit = defineEmits<{ "open-pending": [] }>();
const cache = useCacheStatus(),
	pos = usePosStore(),
	offline = useOfflineStore();
// Taxes: every tax category's taxes, so any synced customer is taxed offline (MuleCity-ispl).
// Addresses: customers' delivery addresses with their miles, and their contacts (MuleCity-qajl.4).
const kinds = ["Customers", "Addresses", "Products and stock", "Taxes"];
const now = ref(Date.now());
const timer = setInterval(() => {
	now.value = Date.now();
	offline.refreshPendingCount();
}, 15000);
onUnmounted(() => clearInterval(timer));
const state = (kind: string) =>
	cache.states[kind]?.profile === pos.profileName ? cache.states[kind] : undefined;
const loading = computed(() => kinds.some((k) => state(k)?.loading));
const cacheReady = computed(() =>
	kinds.every((k) => {
		const s = state(k);
		return s && s.complete && !s.error && !s.loading && now.value - s.updatedAt < 300000;
	}),
);
const summary = computed(() =>
	statusSummary(
		{
			online: offline.isOnline,
			syncing: offline.isSyncing,
			pending: offline.pendingCount,
			deadLetters: offline.deadLetterCount,
			offlineMode: !!pos.useOfflineMode,
			cacheLoading: loading.value,
			cacheReady: cacheReady.value,
		},
		__,
	),
);
async function refresh() {
	await Promise.all([
		useCustomerStore().cacheAllCustomers(pos.profileName),
		useItemStore().cacheAllItems(pos.profileName),
		offline.cacheTaxContextsForOffline(pos.profileName).catch(() => {}),
		offline.syncPendingInvoices(),
	]);
	now.value = Date.now();
	await offline.refreshPendingCount();
}
</script>
