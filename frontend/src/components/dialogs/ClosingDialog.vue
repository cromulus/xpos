<template>
	<Dialog
		:open="posStore.showClosingDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogScrollContent class="max-w-2xl p-0 gap-0 overflow-hidden">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<DialogTitle>{{ __("Close Shift") }}</DialogTitle>
				<DialogDescription>{{ __("Review and reconcile your shift") }}</DialogDescription>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div
					v-if="!shiftClosed && queue.attention.length"
					class="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2"
					data-testid="close-queue-attention"
				>
					<p class="text-sm font-semibold text-destructive">
						{{
							__("{0} offline sale(s) did not sync. Fix or remove them before closing.", [
								String(queue.attention.length),
							])
						}}
					</p>
					<ul class="space-y-1 text-sm">
						<li
							v-for="(row, index) in queue.attention"
							:key="row.id ?? index"
							class="flex flex-col"
							data-testid="close-queue-attention-row"
						>
							<span class="font-medium text-foreground"
								>{{ row.customer || __("Unknown customer") }} &middot;
								{{ money(row.amount) }}</span
							>
							<span class="text-xs text-muted-foreground break-words">{{ row.error }}</span>
						</li>
					</ul>
					<Button
						variant="outline"
						size="sm"
						data-testid="close-open-offline-panel"
						@click="openOfflinePanel"
					>
						{{ __("Open offline invoices") }}
					</Button>
				</div>

				<div
					v-if="!shiftClosed && queue.pending.length"
					class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2"
					data-testid="close-queue-pending"
				>
					<p class="text-sm font-semibold text-amber-700 dark:text-amber-300">
						<template v-if="checkingQueue">
							{{ __("Syncing {0} offline sale(s)...", [String(queue.pending.length)]) }}
						</template>
						<template v-else-if="!offlineStore.isOnline">
							{{
								__(
									"{0} offline sale(s) have not synced and this till is offline. Reconnect to sync them, then close the shift.",
									[String(queue.pending.length)],
								)
							}}
						</template>
						<template v-else>
							{{
								__("{0} offline sale(s) are still waiting to sync. Wait for them before closing.", [
									String(queue.pending.length),
								])
							}}
						</template>
					</p>
					<div class="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							data-testid="close-retry-sync"
							:disabled="checkingQueue || !offlineStore.isOnline"
							@click="settleQueue"
						>
							{{ __("Sync now") }}
						</Button>
						<Button variant="ghost" size="sm" @click="openOfflinePanel">
							{{ __("Open offline invoices") }}
						</Button>
					</div>
				</div>

				<div v-if="isLoading" class="flex items-center justify-center py-12">
					<Loader2 class="w-8 h-8 text-primary animate-spin" />
				</div>

				<template v-else-if="summary">
					<div class="grid grid-cols-3 gap-3">
						<Card class="bg-primary/5 border-primary/20">
							<CardContent class="p-4 text-center">
								<p class="text-xs font-medium text-primary/70 mb-1">
									{{ __("Total Invoices") }}
								</p>
								<p class="text-2xl font-extrabold text-primary">
									{{ summary.total_invoices }}
								</p>
							</CardContent>
						</Card>
						<Card class="bg-emerald-500/5 border-emerald-500/20">
							<CardContent class="p-4 text-center">
								<p class="text-xs font-medium text-emerald-600 dark:text-emerald-400 mb-1">
									{{ __("Grand Total") }}
								</p>
								<p class="text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">
									{{ money(summary.grand_total ?? 0) }}
								</p>
							</CardContent>
						</Card>
						<Card class="bg-blue-500/5 border-blue-500/20">
							<CardContent class="p-4 text-center">
								<p class="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
									{{ __("Net Total") }}
								</p>
								<p class="text-2xl font-extrabold text-blue-700 dark:text-blue-300">
									{{ money(summary.net_total ?? 0) }}
								</p>
							</CardContent>
						</Card>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<Card
							v-if="(summary as any).returns_count > 0"
							class="bg-amber-500/5 border-amber-500/20"
						>
							<CardContent class="p-3 text-center">
								<p class="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
									{{ __("Returns") }}
								</p>
								<p class="text-lg font-bold text-amber-700 dark:text-amber-300">
									{{ (summary as any).returns_count }}
								</p>
							</CardContent>
						</Card>
						<Card
							v-if="(summary as any).total_taxes > 0"
							class="bg-violet-500/5 border-violet-500/20"
						>
							<CardContent class="p-3 text-center">
								<p class="text-xs font-medium text-violet-600 dark:text-violet-400 mb-1">
									{{ __("Total Taxes") }}
								</p>
								<p class="text-lg font-bold text-violet-700 dark:text-violet-300">
									{{ money((summary as any).total_taxes ?? 0) }}
								</p>
							</CardContent>
						</Card>
					</div>

					<div v-if="summary.by_cashier?.length" data-testid="close-by-cashier">
						<h3 class="text-sm font-semibold text-foreground mb-2">
							{{ __("By Cashier") }}
						</h3>
						<div class="border border-border rounded-lg overflow-hidden">
							<div class="overflow-x-auto">
								<table class="w-full text-sm">
									<thead class="bg-muted">
										<tr>
											<th class="text-start px-4 py-2 text-muted-foreground font-medium">
												{{ __("Cashier") }}
											</th>
											<th class="text-end px-4 py-2 text-muted-foreground font-medium">
												{{ __("Sales") }}
											</th>
											<th class="text-end px-4 py-2 text-muted-foreground font-medium">
												{{ __("Sales Total") }}
											</th>
											<th class="text-end px-4 py-2 text-muted-foreground font-medium">
												{{ __("Returns") }}
											</th>
											<th class="text-end px-4 py-2 text-muted-foreground font-medium">
												{{ __("Returns Total") }}
											</th>
										</tr>
									</thead>
									<tbody>
										<tr
											v-for="row in summary.by_cashier"
											:key="row.cashier"
											class="border-t border-border"
											data-testid="close-by-cashier-row"
										>
											<td class="px-4 py-2 font-medium text-foreground">{{ row.cashier }}</td>
											<td class="px-4 py-2 text-end">{{ row.sales_count }}</td>
											<td class="px-4 py-2 text-end">{{ money(row.sales_total ?? 0) }}</td>
											<td class="px-4 py-2 text-end">{{ row.returns_count }}</td>
											<td class="px-4 py-2 text-end">
												{{ row.returns_count ? money(Math.abs(row.returns_total ?? 0)) : "" }}
											</td>
										</tr>
									</tbody>
								</table>
							</div>
						</div>
					</div>

					<div v-if="summary.tax_summary?.length">
						<h3 class="text-sm font-semibold text-foreground mb-2">
							{{ __("Tax Breakdown") }}
						</h3>
						<div class="space-y-1">
							<div
								v-for="tax in summary.tax_summary"
								:key="`${tax.account_head}-${tax.rate}`"
								class="flex items-center justify-between text-sm bg-muted rounded-lg px-3 py-2"
							>
								<span class="text-muted-foreground">{{ tax.account_head }}</span>
								<span class="font-medium text-foreground">{{ money(tax.amount ?? 0) }}</span>
							</div>
						</div>
					</div>

					<div>
						<h3 class="text-sm font-semibold text-foreground mb-3">
							{{ __("Payment Reconciliation") }}
						</h3>
						<div class="border border-border rounded-lg overflow-hidden">
							<div class="overflow-x-auto">
								<table class="w-full text-sm min-w-105">
									<thead class="bg-muted">
										<tr>
											<th
												class="text-start px-4 py-2.5 text-muted-foreground font-medium"
											>
												{{ __("Method") }}
											</th>
											<th
												class="text-end px-4 py-2.5 text-muted-foreground font-medium"
											>
												{{ __("Opening") }}
											</th>
											<th
												class="text-end px-4 py-2.5 text-muted-foreground font-medium"
											>
												{{ __("Expected") }}
											</th>
											<th
												class="text-end px-4 py-2.5 text-muted-foreground font-medium"
											>
												{{ __("Closing") }}
											</th>
											<th
												class="text-end px-4 py-2.5 text-muted-foreground font-medium"
											>
												{{ __("Difference") }}
											</th>
										</tr>
									</thead>
									<tbody>
										<tr
											v-for="(detail, index) in closingDetails"
											:key="detail.mode_of_payment"
											class="border-t border-border"
											data-testid="closing-row"
											:data-mode="detail.mode_of_payment"
										>
											<td class="px-4 py-2.5 font-medium text-foreground">
												{{ detail.mode_of_payment }}
												<span
													class="block text-[11px] font-normal text-muted-foreground"
													data-testid="closing-currency"
												>
													{{ detail.currency }}
												</span>
											</td>
											<td class="px-4 py-2.5 text-end text-muted-foreground">
												{{ formatFor(detail.currency, detail.opening_amount) }}
											</td>
											<td
												class="px-4 py-2.5 text-end text-muted-foreground"
												data-testid="closing-expected"
											>
												{{ formatFor(detail.currency, detail.expected_amount) }}
											</td>
											<td class="px-4 py-2.5 text-end">
												<NumberInput
													v-model="closingDetails[index].closing_amount"
													:min="0"
													:precision="precisionFor(detail.currency)"
													class="w-28 text-end text-sm ms-auto"
													data-testid="closing-input"
													@change="calculateDifference(index)"
												/>
											</td>
											<td
												class="px-4 py-2.5 text-end font-bold"
												data-testid="closing-difference"
												:class="
													detail.difference >= 0
														? 'text-emerald-600'
														: 'text-destructive'
												"
											>
												{{ detail.difference >= 0 ? "+" : ""
												}}{{ formatFor(detail.currency, detail.difference) }}
											</td>
										</tr>
									</tbody>
								</table>
							</div>
						</div>
					</div>
				</template>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<template v-if="shiftClosed">
					<Button
						v-if="closedShiftName"
						variant="outline"
						class="gap-1.5"
						@click="printShiftSummary"
					>
						<Printer class="w-4 h-4" />
						{{ __("Print Summary") }}
					</Button>
					<Button @click="close">{{ __("Done") }}</Button>
				</template>
				<template v-else>
					<Button variant="outline" @click="close">{{ __("Cancel") }}</Button>
					<Button
						variant="destructive"
						class="font-bold"
						:disabled="isClosing || checkingQueue || closeBlocked"
						data-testid="close-shift-submit"
						@click="handleCloseShift"
					>
						<template v-if="isClosing">
							<Loader2 class="w-4 h-4 animate-spin" />
							{{ __("Closing...") }}
						</template>
						<span v-else>{{ __("Close Shift") }}</span>
					</Button>
				</template>
			</DialogFooter>
		</DialogScrollContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useOfflineStore } from "@/stores/offlineStore";
import { classifyQueue, queueBlocksClose, type CloseShiftQueue } from "@/utils/closeShiftGuard";
import { useMoney } from "@/composables/useMoney";
import { showSuccess, showError } from "@/services/api";
import { hasPermission } from "@/services/userRights";
import { formatFor, precisionFor, roundFor } from "@/composables/useCurrency";
import type { POSClosingShiftTax, ShiftCashierTotals, ShiftModeTotal } from "@/types/pos.types";
import {
	Dialog,
	DialogScrollContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Printer } from "lucide-vue-next";
import __ from "@/lib/translate";

interface ClosingSummary {
	total_invoices?: number;
	grand_total?: number;
	net_total?: number;
	payment_summary?: Record<string, ShiftModeTotal>;
	opening_balances?: Record<string, ShiftModeTotal>;
	expected_amounts?: Record<string, ShiftModeTotal>;
	// get_shift_summary returns each tax row's total under `amount`.
	tax_summary?: POSClosingShiftTax[];
	// Sales and returns per cashier initials, "(none)" last (MuleCity-qajl.6).
	by_cashier?: ShiftCashierTotals[];
	[key: string]: unknown;
}

interface ClosingDetail {
	mode_of_payment: string;
	currency: string;
	opening_amount: number;
	expected_amount: number;
	closing_amount: number;
	difference: number;
}

const posStore = usePosStore();
const offlineStore = useOfflineStore();
const { money } = useMoney();

const isLoading = ref(true);
const isClosing = ref(false);
const shiftClosed = ref(false);
const closedShiftName = ref("");
const summary = ref<ClosingSummary | null>(null);
const closingDetails = ref<ClosingDetail[]>([]);

// Offline sales still in this browser's queue (MuleCity-86ea). Closing is
// online-only and the server cannot see them, so the close waits for them.
const queue = ref<CloseShiftQueue>({ pending: [], attention: [] });
const checkingQueue = ref(false);
const closeBlocked = computed(() => queueBlocksClose(queue.value));
const SYNC_WAIT_MS = 500;
const SYNC_WAIT_TRIES = 120;

async function readQueue() {
	await offlineStore.loadPendingInvoices();
	queue.value = classifyQueue(offlineStore.pendingInvoices || [], posStore.profileName);
}

/** Read the queue; if sales are waiting and the till is online, sync them first. */
async function settleQueue() {
	checkingQueue.value = true;
	try {
		await readQueue();
		if (queue.value.pending.length && offlineStore.isOnline) {
			// A background sync may already be running: wait for it, then run one.
			for (let i = 0; offlineStore.isSyncing && i < SYNC_WAIT_TRIES; i++) {
				await new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS));
			}
			await offlineStore.syncPendingInvoices();
			await readQueue();
		}
	} catch (error) {
		console.warn("[XPOS] Could not check the offline queue before closing:", error);
	} finally {
		checkingQueue.value = false;
	}
}

function openOfflinePanel() {
	close();
	window.dispatchEvent(new CustomEvent("xpos:open-offline-panel"));
}

function buildClosingDetails(data: ClosingSummary): ClosingDetail[] {
	const expectedAmounts = data.expected_amounts || {};
	const openingBalances = data.opening_balances || {};
	const modes = Object.keys(expectedAmounts).length
		? Object.keys(expectedAmounts)
		: Object.keys(openingBalances);

	if (modes.length === 0) {
		return [
			{
				mode_of_payment: posStore.cashModeOfPayment || "Cash",
				currency: posStore.invoiceCurrency,
				opening_amount: 0,
				expected_amount: 0,
				closing_amount: 0,
				difference: 0,
			},
		];
	}

	return modes.map((mode) => {
		const expected = expectedAmounts[mode]?.amount ?? openingBalances[mode]?.amount ?? 0;
		return {
			mode_of_payment: mode,
			currency:
				expectedAmounts[mode]?.currency ||
				openingBalances[mode]?.currency ||
				posStore.invoiceCurrency,
			opening_amount: openingBalances[mode]?.amount ?? 0,
			expected_amount: expected,
			closing_amount: expected,
			difference: 0,
		};
	});
}

onMounted(async () => {
	void settleQueue();
	try {
		const data = (await posStore.fetchClosingData()) as ClosingSummary | undefined;
		summary.value = data || null;
		if (data) closingDetails.value = buildClosingDetails(data);
	} catch (error) {
		showError("Failed to load shift data");
	} finally {
		isLoading.value = false;
	}
});

function calculateDifference(index: number) {
	const detail = closingDetails.value[index];
	detail.difference = roundFor(detail.currency, (detail.closing_amount || 0) - detail.expected_amount);
}

async function handleCloseShift() {
	if (isClosing.value) return;
	if (!hasPermission("close_shift")) {
		showError(__("Only a Supervisor can close a shift."));
		return;
	}
	// A sale may have been queued or refused while this dialog sat open.
	await settleQueue();
	if (closeBlocked.value) {
		showError(__("Offline sales have not synced. Sync or resolve them before closing the shift."));
		return;
	}
	isClosing.value = true;

	try {
		const result = (await posStore.closeShift(closingDetails.value)) as { name?: string } | undefined;
		closedShiftName.value = result?.name || "";
		shiftClosed.value = true;
		showSuccess(__("Shift closed successfully!"));
	} catch (error: unknown) {
		showError("Failed to close shift: " + ((error as Error)?.message || error));
	} finally {
		isClosing.value = false;
	}
}

function printShiftSummary() {
	const name = closedShiftName.value;
	if (!name) return;
	const url = `/printview?doctype=POS+Closing+Entry&name=${name}&no_letterhead=0&trigger_print=1`;
	window.open(url, "_blank");
}

function close() {
	posStore.showClosingDialog = false;
}
</script>
