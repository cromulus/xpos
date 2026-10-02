<template>
	<!-- Top-bar "Orders" (Bill 2026-09-30/10-01, MuleCity-zstm.23): Sales Orders in flight first;
	     past sales (and reprint) one tab away. -->
	<div class="h-full min-h-0 flex flex-col">
		<div class="shrink-0 flex items-center gap-1 px-3 sm:px-4 pt-3" role="tablist">
			<Button
				role="tab"
				size="sm"
				:variant="tab === 'open' ? 'secondary' : 'ghost'"
				:aria-selected="tab === 'open'"
				data-testid="orders-tab-open"
				@click="setTab('open')"
			>
				<PackageCheck class="w-4 h-4" />
				{{ __("Orders in flight") }}
			</Button>
			<Button
				role="tab"
				size="sm"
				:variant="tab === 'history' ? 'secondary' : 'ghost'"
				:aria-selected="tab === 'history'"
				data-testid="orders-tab-history"
				@click="setTab('history')"
			>
				<FileText class="w-4 h-4" />
				{{ __("Sales history") }}
			</Button>
		</div>
		<div class="flex-1 min-h-0">
			<OpenOrdersPanel v-if="tab === 'open'" />
			<OrdersView v-else />
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { FileText, PackageCheck } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import OpenOrdersPanel from "@/components/orders/OpenOrdersPanel.vue";
import OrdersView from "@/views/OrdersView.vue";
import __ from "@/lib/translate";

const route = useRoute();
const router = useRouter();
const tab = computed(() => (route.query.tab === "history" ? "history" : "open"));

function setTab(next: "open" | "history") {
	const query = { ...route.query };
	if (next === "history") query.tab = "history";
	else delete query.tab;
	router.replace({ query });
}
</script>
