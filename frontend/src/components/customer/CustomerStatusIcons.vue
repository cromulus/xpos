<template>
	<span v-if="details.length" class="flex flex-wrap items-center gap-3 text-xs" data-testid="customer-status-icons">
		<span
			v-for="detail in details"
			:key="detail.key"
			class="inline-flex items-center gap-0.5"
			role="img"
			:aria-label="detail.label"
			:title="detail.label"
			:data-status="detail.key"
			:class="detail.present ? 'text-primary' : 'text-muted-foreground'"
		>
			<component :is="detail.icon" class="w-4 h-4" aria-hidden="true" />
			<span v-if="detail.count" class="font-semibold" data-testid="address-count">{{ detail.count }}</span>
			<Check v-if="detail.present" class="w-3 h-3" aria-hidden="true" />
			<Minus v-else class="w-3 h-3" aria-hidden="true" />
		</span>
	</span>
</template>

<script setup lang="ts">
/**
 * What the counter needs to know about a customer at a glance: an address on
 * file (so they can take a delivery), email, phone, and whether they are
 * tax-exempt (Mule City's reason: Farm / Reseller). Shown on the cart's
 * customer card and in the customer search. Shape and labels tell present from
 * missing without relying on color; a flag the server did not send is left out.
 */
import { computed } from "vue";
import { MapPin, Mail, Phone, ReceiptText, Check, Minus } from "lucide-vue-next";
import __ from "@/lib/translate";
import { customerStatusDetails, type CustomerStatus } from "@/utils/customerStatus";

const props = defineProps<{ customer: CustomerStatus | null | undefined; taxExemptReason?: string }>();

const ICONS = { address: MapPin, email: Mail, phone: Phone, tax: ReceiptText } as const;

const details = computed(() =>
	customerStatusDetails(props.customer, props.taxExemptReason, __).map((d) => ({ ...d, icon: ICONS[d.key] })),
);
</script>
