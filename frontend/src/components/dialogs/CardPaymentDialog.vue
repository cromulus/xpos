<!--
	Pay by Card on the register's card reader (Mule City, MuleCity-bjjv.3).
	Shows what the reader is doing, and what the cashier may do: confirm the
	cash taken beside the card, pick a reader, cancel while the customer has
	not paid, try the card again or choose another tender after a decline or
	cancel. It cannot be closed while the reader may still take the card.
	The flow lives in stores/cardPaymentStore.
-->
<template>
	<Dialog :open="card.open" @update:open="(value: boolean) => !value && card.close()">
		<DialogContent class="max-w-md" data-testid="card-payment-dialog" @interact-outside.prevent>
			<DialogHeader>
				<DialogTitle class="flex items-center gap-2">
					<CreditCard class="w-5 h-5 text-primary" />
					{{ __("Pay by Card") }}
				</DialogTitle>
				<DialogDescription v-if="card.pending">
					{{ __("{0} on {1}", [amountLabel, card.pending.invoice]) }}
				</DialogDescription>
			</DialogHeader>

			<div class="space-y-3 py-1">
				<div v-if="card.step === 'saving'" class="flex items-center gap-2 text-sm" data-testid="card-saving">
					<Loader2 class="w-4 h-4 animate-spin" />
					{{ __("Saving the sale…") }}
				</div>

				<div v-else-if="card.step === 'pick'" class="space-y-2" data-testid="card-pick-reader">
					<p class="text-sm font-medium">{{ __("Which card reader?") }}</p>
					<Button
						v-for="device in card.devices"
						:key="device.name"
						variant="outline"
						class="w-full justify-start"
						@click="card.pickReader(device.name)"
					>
						{{ device.label }}
					</Button>
				</div>

				<div v-else-if="card.step === 'confirm'" class="space-y-2" data-testid="card-confirm-cash">
					<p class="text-sm">
						{{
							__("Cash taken first: {0}. Put it in the drawer, then charge the rest on the card.", [
								money(card.cash),
							])
						}}
					</p>
					<Button class="w-full" data-testid="card-confirm-cash-button" :disabled="card.busy" @click="card.confirmCash()">
						{{ __("I have the {0} cash. Charge {1} on the card", [money(card.cash), amountLabel]) }}
					</Button>
				</div>

				<div
					v-else-if="card.step === 'starting' || (card.step === 'collecting' && !card.view)"
					class="flex items-center gap-2 text-sm"
					data-testid="card-starting"
				>
					<Loader2 class="w-4 h-4 animate-spin" />
					{{ __("Sending the amount to the card reader…") }}
				</div>

				<div
					v-if="card.view"
					class="rounded-lg border p-3 text-sm"
					:class="statusClass"
					data-testid="card-status"
					:data-phase="card.view.phase"
				>
					<div class="flex items-start gap-2">
						<Loader2 v-if="!card.view.settled && card.view.phase !== 'paid'" class="w-4 h-4 mt-0.5 animate-spin shrink-0" />
						<CheckCircle2 v-else-if="card.view.phase === 'paid'" class="w-4 h-4 mt-0.5 shrink-0" />
						<AlertTriangle v-else class="w-4 h-4 mt-0.5 shrink-0" />
						<div>
							<p class="font-medium" data-testid="card-status-message">{{ card.view.message }}</p>
							<p v-if="card.view.reason" class="mt-1" data-testid="card-status-reason">{{ card.view.reason }}</p>
						</div>
					</div>
				</div>

				<p v-if="card.connectionLost" class="text-xs text-amber-700 dark:text-amber-400" data-testid="card-connection-lost">
					{{ __("Connection lost. Still checking the card reader; do not charge the card again.") }}
				</p>
				<p v-if="card.error" class="text-sm text-destructive" data-testid="card-error">{{ card.error }}</p>
			</div>

			<DialogFooter class="gap-2 sm:gap-2">
				<Button
					v-if="card.view?.canCancel && card.pending?.attempt"
					variant="destructive"
					data-testid="card-cancel"
					:disabled="card.busy"
					@click="card.cancel()"
				>
					{{ __("Cancel card payment") }}
				</Button>
				<template v-if="canChooseAgain">
					<Button variant="outline" data-testid="card-other-tender" @click="card.otherTender()">
						{{ __("Other tender") }}
					</Button>
					<Button data-testid="card-retry" :disabled="card.busy || !online" @click="card.retry()">
						{{ __("Try card again") }}
					</Button>
				</template>
				<Button v-if="card.step === 'done'" data-testid="card-close" @click="card.close()">
					{{ __("Close") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { __ } from "@/lib/translate";
import { formatWithSymbol } from "@/composables/useCurrency";
import { useCardPaymentStore } from "@/stores/cardPaymentStore";
import { usePosStore } from "@/stores/posStore";
import { isOnline } from "@/utils";

const card = useCardPaymentStore();
const posStore = usePosStore();

const online = computed(() => isOnline());
const money = (value: number | string | undefined) =>
	formatWithSymbol(posStore.invoiceCurrency || "USD", Number(value || 0));
const amountLabel = computed(() => money(card.status?.amount ?? card.pending?.amount));

/** Not charged, and nothing in flight: the cashier chooses what happens next. */
const canChooseAgain = computed(
	() => !!card.pending && !card.pending.attempt && card.step === "idle" && !card.busy,
);

const statusClass = computed(() => {
	switch (card.view?.phase) {
		case "paid":
			return "border-green-600/40 bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300";
		case "declined":
		case "cancelled":
			return "border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
		case "review":
			return "border-destructive/40 bg-destructive/10 text-destructive";
		default:
			return "border-primary/30 bg-primary/5";
	}
});
</script>
