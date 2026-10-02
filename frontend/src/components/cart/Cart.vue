<template>
	<div class="flex flex-col h-full">
		<div
			v-if="cartStore.isReturnMode"
			class="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center justify-between"
		>
			<div class="flex items-center gap-2">
				<RotateCcw class="w-4 h-4 text-amber-600" />
				<span class="text-sm font-semibold text-amber-700 dark:text-amber-400">{{
					__("Return Mode")
				}}</span>
				<span
					v-if="cartStore.returnAgainst"
					class="text-xs text-amber-600/70 dark:text-amber-400/70 font-mono"
				>
					{{ cartStore.returnAgainst }}
				</span>
			</div>
			<Button
				variant="ghost"
				size="icon-sm"
				class="text-amber-600 hover:text-amber-700"
				@click="cartStore.exitReturnMode()"
			>
				<X class="w-4 h-4" />
			</Button>
		</div>

		<!-- Compact header (Bill 2026-09-29, MuleCity-nfxn.3): the cart, its customer and their
		     account take two short lines instead of a card, a button and two big boxes.
		     Receive on Account is a Pay option now (PaymentDialog, or the empty cart's Pay button). -->
		<div class="shrink-0 px-4 pt-3 pb-2 border-b">
			<div class="flex items-center gap-2">
				<!-- No "Cart" heading: it took room (Bill 2026-10-01, MuleCity-qajl.1). -->
				<button
					type="button"
					data-testid="cart-customer"
					class="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors duration-200"
					:class="
						cartStore.isReturnMode
							? 'border-border bg-muted/50 cursor-not-allowed'
							: 'border-dashed border-border hover:border-primary hover:bg-primary/5 dark:hover:border-primary'
					"
					:disabled="cartStore.isReturnMode"
					:title="
						cartStore.isReturnMode
							? __('Customer locked for return')
							: cartStore.customer
								? __('Click to change customer')
								: __('Click to select customer')
					"
					@click="handleCustomerClick"
				>
					<User class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
					<span class="text-sm font-medium text-foreground truncate">
						{{ cartStore.customer ? cartStore.customerName : __("Select customer") }}
					</span>
					<Lock v-if="cartStore.isReturnMode" class="ms-auto w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
					<ChevronDown v-else class="ms-auto w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
				</button>
				<CustomerOrdersBadge v-if="cartStore.customer && !cartStore.isReturnMode" />
				<Button
					v-if="cartStore.customer && !cartStore.isReturnMode"
					variant="ghost"
					size="icon-sm"
					class="shrink-0"
					data-testid="edit-customer"
					:title="__('Edit Customer')"
					@click.stop="handleEditCustomer"
				>
					<Pencil class="w-4 h-4" />
				</Button>
				<!-- Customer Mixes, now the Mule City row is gone (MuleCity-qajl.1, qajl.2). -->
				<Button
					v-if="cartStore.customer && !cartStore.isReturnMode"
					variant="ghost"
					size="sm"
					class="shrink-0 h-7 px-2 gap-1 text-xs"
					data-testid="customer-mixes"
					:title="__('Customer mixes')"
					@click.stop="openMixes"
				>
					<FlaskConical class="w-3.5 h-3.5" />
					{{ __("Mixes") }}
				</Button>
				<ClearCustomer />
				<Autocomplete
					v-if="posStore.salesPersonEnabled && !cartStore.isReturnMode"
					v-model="cartStore.salesPerson"
					doctype="Sales Person"
					query="xpos.api.customers.sales_person_query"
					:filters="{ pos_profile: posStore.profileName }"
					:placeholder="__('Sales Person')"
					:open-on-focus="true"
					:clearable="true"
					:compact="true"
					:min-chars="0"
					class="min-w-0 max-w-36"
				/>
			</div>

			<div
				v-if="cartStore.customer && !cartStore.isReturnMode"
				class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
				data-testid="customer-account-row"
			>
				<!-- Can take a delivery, contact on file, tax exempt: at a glance (Bill 2026-09-29). -->
				<CustomerStatusIcons :customer="cartStore.customer" :tax-exempt-reason="cartStore.muleTaxExemptReason" />
				<span v-if="cartStore.customer.mobile_no" class="inline-flex items-center gap-1 truncate">
					<Phone class="w-3 h-3 shrink-0" />{{ cartStore.customer.mobile_no }}
				</span>
				<template v-if="showCreditInfo">
					<span :class="{ 'text-destructive font-semibold': isOverCreditLimit }" data-testid="customer-balance">
						{{ __("Balance") }}
						<strong class="text-foreground" :class="{ 'text-destructive': isOverCreditLimit }">{{ money(customerBalance ?? 0) }}</strong>
					</span>
					<span :class="{ 'text-destructive font-semibold': isOverCreditLimit }" data-testid="customer-credit-limit">
						{{ __("Credit limit") }}
						<strong class="text-foreground" :class="{ 'text-destructive': isOverCreditLimit }">{{ customerCreditLimit > 0 ? money(customerCreditLimit) : __("None") }}</strong>
					</span>
				</template>
			</div>
			<!-- Add delivery is its own button below the account row (Bill 2026-10-01, MuleCity-qajl.2);
			     The recent-sales link is gone: Repeat in the top bar does that. -->
			<AddDelivery v-if="cartStore.customer && !cartStore.isReturnMode" />
			<p
				v-if="showCreditInfo && isOverCreditLimit"
				class="mt-1 flex items-center gap-1.5 text-xs font-semibold text-destructive"
			>
				<AlertTriangle class="w-3.5 h-3.5 shrink-0" />
				{{ __("This sale exceeds the credit limit by {0}", [money(projectedBalance - customerCreditLimit)]) }}
			</p>
			<!-- A custom mix the mill still has to make is ordered for pickup (Mule City, MuleCity-3j1m). -->
			<label
				v-if="cartStore.hasOrderLines"
				class="mt-1 flex items-center gap-2 text-xs font-semibold"
				data-testid="cart-pickup-date"
			>
				{{ __("Mix pickup date") }}
				<input v-model="cartStore.pickupDate" type="date" required class="border border-input rounded px-1 py-0.5 bg-card" />
			</label>
			<!-- Whether the mix can be made and what the order costs, before Pay (MuleCity-zstm.20). -->
			<p
				v-if="cartStore.hasOrderLines"
				class="mt-1 text-xs"
				:class="{
					'text-destructive font-semibold': mixCheck.tone === 'bad',
					'text-amber-700 dark:text-amber-400 font-semibold': mixCheck.tone === 'answer',
					'text-muted-foreground': mixCheck.tone === 'info',
				}"
				data-testid="cart-mix-check"
				role="status"
			>
				{{ mixCheck.text }}
			</p>
			<ReceiveOnAccountDialog
				:customer="customerStore.showReceiveOnAccount ? cartStore.customer?.name || null : null"
				:customer-label="cartStore.customerName"
				:balance="customerBalance ?? 0"
				@close="customerStore.showReceiveOnAccount = false"
				@received="onReceivedOnAccount"
			/>
		</div>

		<div ref="cartScrollContainer" class="flex-1 overflow-y-auto px-4 xpos-scrollbar">
			<div
				v-if="cartStore.isEmpty"
				class="flex flex-col items-center justify-center h-full text-center py-8"
			>
				<div class="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-4">
					<ShoppingCart class="w-10 h-10 text-muted-foreground/40" />
				</div>
				<p class="text-sm font-medium text-muted-foreground">{{ __("Cart is empty") }}</p>
				<p class="text-xs text-muted-foreground mt-1">
					{{ __("Click on items to add them here") }}
				</p>
			</div>

			<div v-else class="space-y-0.5 py-0.5">
				<CartItem
					v-for="(item, index) in cartStore.items"
					:key="
						item.item_code +
						'-' +
						(item.serial_no || '') +
						'-' +
						(item.batch_no || '') +
						'-' +
						index
					"
					:item="item"
					:index="index"
					:currency-symbol="posStore.currencySymbol"
					@update-qty="handleUpdateQty"
					@update-rate="cartStore.updateItemRate"
					@update-discount="cartStore.updateItemDiscount"
					@update-uom="handleUpdateUOM"
					@remove="cartStore.removeItem"
				/>
			</div>
		</div>

		<div
			v-if="posStore.displayAdditionalNotes && !cartStore.isEmpty"
			class="shrink-0 px-4 py-2 border-t border-border"
		>
			<textarea
				v-model="cartStore.orderNotes"
				rows="2"
				placeholder="Add order notes..."
				class="w-full text-xs rounded-md border border-input bg-background px-3 py-1.5 ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
			/>
		</div>

		<div v-if="cartStore.hasOffers && !cartStore.isEmpty" class="shrink-0 px-4 pb-2 space-y-1">
			<div
				v-for="offer in cartStore.appliedOffers"
				:key="offer.name"
				class="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-1.5 text-xs"
			>
				<span class="text-emerald-700 dark:text-emerald-400 font-medium">
					{{ offer.offer_name || offer.name }}
				</span>
				<button
					@click="cartStore.removeOffer(offer.name)"
					class="text-muted-foreground hover:text-destructive"
				>
					<X class="w-3.5 h-3.5" />
				</button>
			</div>
			<div
				v-if="cartStore.appliedCoupon"
				class="flex items-center justify-between bg-violet-500/5 border border-violet-500/20 rounded-lg px-3 py-1.5 text-xs"
			>
				<span class="text-violet-700 dark:text-violet-400 font-medium">
					{{ __("Coupon") }}:
					{{ cartStore.appliedCoupon.coupon_code || cartStore.appliedCoupon.name }}
				</span>
				<button
					@click="cartStore.removeCoupon()"
					class="text-muted-foreground hover:text-destructive"
				>
					<X class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>

		<CartSummary />
		<CustomerEditDialog />
	</div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useCustomerStore } from "@/stores/customerStore";
import { showError } from "@/services/api";
import { useMoney } from "@/composables/useMoney";
import CartItem from "./CartItem.vue";
import CartSummary from "./CartSummary.vue";
import { Button } from "@/components/ui/button";
import { Autocomplete } from "@/components/ui/autocomplete";
import {
	ShoppingCart,
	User,
	ChevronDown,
	RotateCcw,
	X,
	Lock,
	Gift,
	Phone,
	Pencil,
	AlertTriangle,
	FlaskConical,
} from "lucide-vue-next";
import __ from "@/lib/translate";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";
import ReceiveOnAccountDialog from "@/components/dialogs/ReceiveOnAccountDialog.vue";
import CustomerStatusIcons from "@/components/customer/CustomerStatusIcons.vue";
import AddDelivery from "@/components/cart/AddDelivery.vue";
import ClearCustomer from "@/components/cart/ClearCustomer.vue";
import CustomerOrdersBadge from "@/components/cart/CustomerOrdersBadge.vue";
import { useCustomerAccount } from "@/composables/useCustomerAccount";
import { showsCreditInfo } from "@/utils/creditPanel";
import { mixCheckStatus } from "@/utils/mixCheck";
import { useOfflineStore } from "@/stores/offlineStore";
import type { ItemUOM } from "@/types/pos.types";

const posStore = usePosStore();
const cartStore = useCartStore();
const customerStore = useCustomerStore();
const { money } = useMoney();
const offlineStore = useOfflineStore();
const mixCheck = computed(() =>
	mixCheckStatus(
		{
			online: offlineStore.isOnline,
			pickupDate: cartStore.pickupDate,
			pending: cartStore.mixCheckPending,
			error: cartStore.mixCheckError,
			errorAnswered: cartStore.mixCheckAnswered,
			ordersTotal: cartStore.counterQuote ? cartStore.counterQuote.orders_total : null,
		},
		money,
	),
);

const cartScrollContainer = ref<HTMLElement | null>(null);

onMounted(() => {
	window.addEventListener("xpos:focus-cart-item", handleFocusCartItem);
});

onUnmounted(() => {
	window.removeEventListener("xpos:focus-cart-item", handleFocusCartItem);
});

function handleFocusCartItem() {
	if (cartStore.isEmpty) return;
	const firstItemEl = document.querySelector('[data-cart-index="0"]');
	const allInputs = firstItemEl?.querySelectorAll('input[type="number"]');
	if (!allInputs || allInputs.length === 0) return;
	const qtyEl = (allInputs.length > 1 ? allInputs[1] : allInputs[0]) as HTMLInputElement;
	qtyEl.focus();
	qtyEl.select();
}

watch(
	() => cartStore.items.length,
	(newLen, oldLen) => {
		if (newLen > oldLen) {
			nextTick(() => {
				const container = cartScrollContainer.value;
				if (!container) return;

				container.scrollTo({
					top: container.scrollHeight,
					behavior: "smooth",
				});

				const lastChild = container.querySelector(".space-y-1 > :last-child") as HTMLElement | null;
				if (lastChild) {
					lastChild.classList.add("ring-2", "ring-primary/50", "rounded-xl");
					setTimeout(() => {
						lastChild.classList.remove("ring-2", "ring-primary/50", "rounded-xl");
					}, 800);
				}
			});
		}
	},
);

watch(
	() => cartStore.customer?.name,
	(name) => {
		if (name && posStore.showCustomerBalance) customerStore.getCustomerInfo(name);
	},
	{ immediate: true },
);

const { balance: customerBalance, creditLimit: customerCreditLimit } = useCustomerAccount();
const projectedBalance = computed(() => (customerBalance.value ?? 0) + Math.max(cartStore.grandTotal, 0));
const isOverCreditLimit = computed(
	() => customerCreditLimit.value > 0 && projectedBalance.value > customerCreditLimit.value,
);
const showCreditInfo = computed(() =>
	showsCreditInfo({
		showCustomerBalance: posStore.showCustomerBalance,
		isReturnMode: cartStore.isReturnMode,
		isDefaultCustomer: !!posStore.defaultCustomer && cartStore.customer?.name === posStore.defaultCustomer,
		balance: customerBalance.value ?? 0,
		creditLimit: customerCreditLimit.value,
	}),
);

function onReceivedOnAccount() {
	customerStore.showReceiveOnAccount = false;
	if (cartStore.customer?.name) customerStore.getCustomerInfo(cartStore.customer.name);
}

function handleCustomerClick() {
	if (cartStore.isReturnMode) {
		showError(__("Customer cannot be changed in return mode"));
		return;
	}
	customerStore.showCustomerDialog = true;
	customerStore.searchCustomers();
}

function openMixes() {
	window.dispatchEvent(new CustomEvent("xpos:open-mule-workspace", { detail: { mode: "mixes" } }));
}

function handleEditCustomer() {
	customerStore.showCustomerEditDialog = true;
}

async function handleUpdateUOM(index: number, unit: ItemUOM) {
	const result = await cartStore.changeItemUOM(index, unit);
	if (!result.success && result.message) {
		showError(result.message);
	}
}

function handleUpdateQty(index: number, qty: number) {
	const result = cartStore.updateItemQty(index, qty);
	if (!result.success && result.message) {
		showError(result.message);
	}
}
</script>
