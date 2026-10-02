<template>
	<!-- Orders in flight (Bill 2026-09-30/10-01, MuleCity-zstm.23, mxwy.10): the selected customer's,
	     still searchable; nobody selected = every order in flight. Offline: the last known list with
	     its time, or "not known" — never "no orders". -->
	<div class="h-full min-h-0 flex flex-col" data-testid="open-orders">
		<div class="shrink-0 px-3 sm:px-4 pt-3 space-y-2">
			<div class="flex flex-wrap items-center gap-2">
				<h2 class="text-base font-bold text-foreground" data-testid="open-orders-scope">
					{{ scope ? __("Orders for {0}", [scopeName]) : __("All orders in flight") }}
				</h2>
				<Button
					v-if="scope"
					variant="outline"
					size="sm"
					data-testid="open-orders-show-all"
					@click="showAll"
				>
					{{ __("Show all orders") }}
				</Button>
				<Button
					v-else-if="cartScope"
					variant="outline"
					size="sm"
					data-testid="open-orders-show-customer"
					@click="showCustomer"
				>
					{{ __("Only {0}", [cartStore.customerName || cartScope]) }}
				</Button>
			</div>
			<form class="flex gap-2" @submit.prevent="refresh">
				<Input
					v-model="term"
					class="flex-1"
					data-testid="open-orders-search"
					:placeholder="__('Order number or customer')"
					:aria-label="__('Search orders')"
				/>
				<Button type="submit" :disabled="busy">{{ __("Search") }}</Button>
			</form>
			<p
				v-if="result && !result.live"
				class="text-xs font-semibold text-amber-700 dark:text-amber-400"
				data-testid="open-orders-last-known"
			>
				{{ __("Offline — last known list, as of {0}. Readiness may have changed.", [fetchedAtText(result.fetchedAt)]) }}
			</p>
			<p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
			<p v-if="busy" role="status" class="text-sm text-muted-foreground">{{ __("Loading…") }}</p>
			<p
				v-else-if="!error && result === null"
				class="text-sm text-muted-foreground"
				data-testid="open-orders-unknown"
			>
				{{ __("Offline: this till has no list of orders yet. They show once it is back online.") }}
			</p>
			<p
				v-else-if="!error && result && !result.rows.length"
				class="text-sm text-muted-foreground"
				data-testid="open-orders-empty"
			>
				{{
					result.live
						? term
							? __("No orders in flight match.")
							: scope
								? __("No orders in flight for {0}.", [scopeName])
								: __("No orders in flight.")
						: __("None in the last known list (as of {0}).", [fetchedAtText(result.fetchedAt)])
				}}
			</p>
			<p v-if="!cartStore.isEmpty" class="text-xs text-destructive">
				{{ __("Finish or park the current basket before loading an order.") }}
			</p>
		</div>
		<div class="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
			<Card
				v-for="row in result?.rows ?? []"
				:key="row.name"
				class="p-3 sm:p-4"
				:class="row.readiness === 'ready' ? 'border-emerald-500/70 bg-emerald-500/5' : ''"
				data-testid="open-order"
				:data-readiness="row.readiness"
			>
				<div class="flex flex-wrap items-center gap-3">
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2 mb-1">
							<span class="font-semibold text-sm text-foreground">{{ row.customer_name || row.customer }}</span>
							<Badge :variant="row.readiness === 'ready' ? 'success' : 'secondary'" class="text-[10px]">
								{{ __(readinessLabel(row.readiness)) }}
							</Badge>
						</div>
						<p class="text-xs text-muted-foreground">
							{{ row.name }}
							<template v-if="row.delivery_date"> · {{ __("Wanted {0}", [row.delivery_date]) }}</template>
							· {{ money(row.grand_total || 0) }}
							<template v-if="row.advance_paid"> · {{ __("Paid {0}", [money(row.advance_paid)]) }}</template>
						</p>
						<p v-if="row.progress" class="text-xs text-muted-foreground">{{ __(row.progress) }}</p>
					</div>
					<a
						class="text-sm text-primary underline"
						:href="'/desk/sales-order/' + encodeURIComponent(row.name)"
						target="_blank"
					>
						{{ __("Review order") }}
					</a>
					<Button
						size="sm"
						data-testid="open-order-load"
						:disabled="busy || !cartStore.isEmpty || !offline.isOnline"
						:title="!offline.isOnline ? __('Loading an order needs the internet') : undefined"
						@click="pickup(row)"
					>
						{{ __("Load for payment") }}
					</Button>
				</div>
			</Card>
			<p v-if="result?.truncated" class="text-xs text-muted-foreground">
				{{ __("Showing the first {0}. Search to narrow the list.", [result.rows.length]) }}
			</p>
			<p v-if="result?.rows.length" class="text-xs text-muted-foreground">
				{{
					__(
						"Review production readiness before release. Loading checks finished stock; the requested date alone does not mean ready.",
					)
				}}
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { useOpenOrdersStore } from "@/stores/openOrdersStore";
import { useMoney } from "@/composables/useMoney";
import { call, showInfo } from "@/services/api";
import { fetchedAtText, readinessLabel, type OpenOrder, type OrdersResult } from "@/utils/openOrders";
import __ from "@/lib/translate";

const route = useRoute();
const router = useRouter();
const cartStore = useCartStore();
const posStore = usePosStore();
const offline = useOfflineStore();
const orders = useOpenOrdersStore();
const { money } = useMoney();

/** The cart's customer, unless it is the walk-in. */
const cartScope = computed(() => orders.scopeOf(cartStore.customer?.name));
/** ?customer= (the indicator) wins; ?customer= empty means "everyone"; else the cart's customer. */
const scope = computed(() => {
	const asked = route.query.customer;
	if (typeof asked === "string") return orders.scopeOf(asked);
	return cartScope.value;
});
const scopeName = computed(() => {
	if (scope.value === cartStore.customer?.name) return cartStore.customerName || scope.value;
	return result.value?.rows.find((row) => row.customer === scope.value)?.customer_name || scope.value;
});

const term = ref("");
const result = ref<OrdersResult | null>(null);
const busy = ref(false);
const error = ref("");
let generation = 0;

async function refresh() {
	const token = ++generation;
	busy.value = true;
	error.value = "";
	try {
		const next = await orders.load(scope.value || null, term.value);
		if (token === generation) result.value = next;
	} catch (e) {
		if (token !== generation) return;
		result.value = null;
		error.value = (e as Error)?.message || __("Could not load orders. Please retry.");
	} finally {
		if (token === generation) busy.value = false;
	}
}

function showAll() {
	router.replace({ query: { ...route.query, customer: "" } });
}
function showCustomer() {
	router.replace({ query: { ...route.query, customer: cartScope.value } });
}

/** The same steps as the Mule City dialog: the server maps the order (pickup, advances), the cart loads it. */
async function pickup(row: OpenOrder) {
	if (!cartStore.isEmpty) return;
	busy.value = true;
	error.value = "";
	try {
		const doc = await call<Record<string, unknown>>("mulecity_erpnext.pos_workspace.pickup_invoice", {
			pos_profile: posStore.profileName,
			sales_order: row.name,
		});
		// The server says when it turned a delivery order into a pickup (and dropped its delivery charge).
		if (doc?.mule_notice) showInfo(String(doc.mule_notice));
		cartStore.loadFromInvoice(doc as never);
		await router.push("/pos");
	} catch (e) {
		error.value = (e as Error)?.message || __("Could not load this order. Please retry.");
	} finally {
		busy.value = false;
	}
}

watch(scope, () => {
	term.value = "";
	refresh();
});
watch(
	() => offline.isOnline,
	(online) => {
		if (online) refresh();
	},
);
onMounted(refresh);
defineExpose({ refresh });
</script>
