<template>
  <section aria-label="Nutrient analysis">
    <strong>Nutrient analysis</strong>
    <p>{{ source || 'Recorded analysis' }}</p>
    <dl class="grid grid-cols-2 gap-x-4 gap-y-1">
      <template v-for="[field, label] in nutrients" :key="field">
        <dt>{{ label }}</dt><dd>{{ values?.[field] == null ? 'Unknown' : Number(values[field]).toFixed(2) + '%' }}</dd>
      </template>
    </dl>
    <details><summary>More nutrients</summary>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1">
        <template v-for="[field, label, unit] in additional" :key="field">
          <dt>{{ label }}</dt><dd>{{ values?.[field] == null ? 'Unknown' : Number(values[field]).toFixed(2) + unit }}</dd>
        </template>
      </dl>
    </details>
    <p>Unknown means analysis is missing or incomplete. Intended animal is not a nutritional approval.</p>
  </section>
</template>
<script setup>
defineProps({ values: Object, source: String });
const nutrients = [['protein_pct', 'Protein'], ['fat_pct', 'Fat'], ['fiber_pct', 'Fiber'], ['calcium_pct', 'Calcium'], ['phosphorus_pct', 'Phosphorus'], ['salt_pct', 'Salt']];
const additional = [['copper_ppm', 'Copper', ' ppm'], ['selenium_ppm', 'Selenium', ' ppm'], ['zinc_ppm', 'Zinc', ' ppm'], ['vitamin_e_ppm', 'Vitamin E', ' ppm'], ['vitamin_a', 'Vitamin A (source units)', ''], ['vitamin_d', 'Vitamin D (source units)', ''], ['tdn_pct', 'TDN', '%'], ['bypass_protein_pct', 'Bypass protein', '%'], ['potassium_pct', 'Potassium', '%'], ['magnesium_pct', 'Magnesium', '%'], ['methionine_pct', 'Methionine', '%'], ['lysine_pct', 'Lysine', '%'], ['starch_pct', 'Starch', '%'], ['ne_lact_mcal', 'Net energy, lactation (Mcal, source basis)', ''], ['ne_growth_mcal', 'Net energy, growth (Mcal, source basis)', '']];
</script>
