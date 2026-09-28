<template>
  <section aria-label="Recipe and nutrition" class="space-y-2 border-t pt-3">
    <p v-if="loading" role="status">Loading recipe and analysis…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <template v-else-if="info">
      <p><strong>For:</strong> {{ info.animals || 'Animal not recorded' }}</p>
      <p><strong>Ingredients:</strong> {{ info.ingredients?.join(', ') || 'Recipe not recorded' }}</p>
      <a v-if="info.bom" :href="'/desk/bom/' + encodeURIComponent(info.bom)" target="_blank" class="underline">Open full recipe (BOM)</a>
      <MuleNutrition :values="info.nutrition" :source="info.nutrition_source" />
    </template>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue';
import { call } from '@/services/api';
import MuleNutrition from './MuleNutrition.vue';
const props = defineProps({ itemCode: String, profile: String, customer: String });
const info = ref(null), loading = ref(false), error = ref('');
let generation = 0;
// Ignore late responses when the clerk opens another product.
watch(() => [props.itemCode, props.profile, props.customer], async () => {
  const token = ++generation;
  info.value = null; error.value = ''; loading.value = false;
  if (!props.itemCode || !props.profile) return;
  loading.value = true;
  try {
    const result = await call('mulecity_erpnext.pos_product_context.product_details', {
      item_code: props.itemCode, pos_profile: props.profile, customer: props.customer || null,
    });
    if (token === generation) info.value = result;
  } catch { if (token === generation) error.value = 'Could not load recipe and analysis. Try opening this product again.'; }
  finally { if (token === generation) loading.value = false; }
}, { immediate: true });
</script>
