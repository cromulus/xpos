<template>
	<div class="feed-details space-y-5 text-sm">
		<p v-if="details.animals" class="text-muted-foreground">{{ __("For {0}", [details.animals]) }}</p>
		<section aria-labelledby="feed-ingredients-title">
			<h3 id="feed-ingredients-title" class="font-semibold">{{ __("Ingredients") }}</h3>
			<p v-if="details.original_run?.pounds" class="text-xs text-muted-foreground mt-1">
				{{ __("Last recorded run: {0} lb", [number(details.original_run.pounds)]) }}<span v-if="details.original_run.bags"> · {{ number(details.original_run.bags) }} {{ __("bags") }}</span>
			</p>
			<div v-if="details.composition?.length" class="overflow-x-auto">
				<table class="w-full mt-2"><caption class="text-left text-xs text-muted-foreground pb-2">{{ details.recipe_lb == null ? __("Recipe weight incomplete; proportions unknown") : __("Recipe basis: {0} lb of feed", [number(details.recipe_lb)]) }}</caption>
					<thead><tr><th>{{ __("Ingredient") }}</th><th class="numeric">{{ __("lb in recipe") }}</th><th class="numeric">{{ __("Share") }}</th></tr></thead>
					<tbody><tr v-for="(row, index) in details.composition" :key="index"><td>{{ row.item_name || row.item_code }}<span v-if="row.lbs == null && row.qty" class="block text-xs text-muted-foreground">{{ number(row.qty) }} {{ row.uom }} · {{ __("pound weight unknown") }}</span></td><td class="numeric">{{ number(row.lbs) }}</td><td class="numeric">{{ row.share_pct == null ? __("Unknown") : number(row.share_pct) + '%' }}</td></tr></tbody>
				</table>
			</div>
			<p v-else class="text-muted-foreground mt-1">{{ __("Ingredients are not recorded for this product.") }}</p>
		</section>

		<section aria-labelledby="feed-guarantee-title" data-testid="guaranteed-analysis">
			<h3 id="feed-guarantee-title" class="font-semibold">{{ __("Guaranteed analysis") }}</h3>
			<p class="text-xs text-muted-foreground mt-1">{{ details.guaranteed_analysis_source || __("Recorded FilePro product analysis") }}</p>
			<table class="w-full mt-2"><thead><tr><th>{{ __("Nutrient") }}</th><th class="numeric">{{ __("Recorded value") }}</th></tr></thead>
				<tbody><tr v-for="field in fields(details.guaranteed_analysis)" :key="field"><td>{{ label(field) }}</td><td class="numeric">{{ number(details.guaranteed_analysis?.[field]) }}</td></tr></tbody>
			</table>
		</section>

		<section v-if="Object.keys(details.reference_analysis || {}).length" aria-labelledby="feed-reference-title" data-testid="reference-analysis">
			<h3 id="feed-reference-title" class="font-semibold">{{ __("Reference estimates") }}</h3>
			<p class="text-xs text-muted-foreground mt-1">{{ __("Typical ingredient composition, as fed. These estimates are used in recipe calculations.") }}</p>
			<table class="w-full mt-2"><thead><tr><th>{{ __("Nutrient") }}</th><th class="numeric">{{ __("Estimated value") }}</th></tr></thead>
				<tbody><tr v-for="field in Object.keys(details.reference_analysis || {})" :key="field"><td>{{ label(field) }}<details class="text-xs text-muted-foreground"><summary>{{ __("Source") }}</summary><p>{{ details.reference_analysis_sources?.[field] }}</p></details></td><td class="numeric">{{ number(details.reference_analysis?.[field]) }}</td></tr></tbody>
			</table>
		</section>

		<section v-if="details.calculated_analysis" data-testid="recipe-analysis">
			<h3 class="font-semibold">{{ __("Calculated recipe nutrition") }}</h3>
			<p class="text-xs text-muted-foreground mt-1">{{ __("Weighted from ingredient analysis, including any reference estimates. Unknown means analysis or weight is missing.") }}</p>
			<table class="w-full mt-2"><thead><tr><th>{{ __("Nutrient") }}</th><th class="numeric">{{ __("Recipe") }}</th></tr></thead>
				<tbody><tr v-for="field in fields(details.calculated_analysis)" :key="field"><td>{{ label(field) }}</td><td class="numeric" :title="missing(field)">{{ number(details.calculated_analysis[field]) }}</td></tr></tbody>
			</table>
		</section>

		<section v-if="order" class="border-t border-border pt-4" data-testid="order-comparison">
			<h3 class="font-semibold">{{ __("This order") }}<span v-if="orderSize"> · {{ orderSize }}</span></h3>
			<p v-if="pending" role="status" class="text-muted-foreground mt-2">{{ __("Recalculating pulls for the current order size…") }}</p>
			<p v-else-if="message" role="status" class="text-muted-foreground mt-2">{{ message }}</p>
			<template v-else-if="comparison">
				<p class="text-xs text-muted-foreground mt-1">{{ __("Original recipe scaled to {0} lb to manufacture · {1} lb planned", [number(pull?.asked_lb), number(pull?.pulled_lb)]) }}<span v-if="pull?.loads"> · {{ number(pull.loads) }} {{ __("loads") }}</span></p>
				<p v-if="comparison.note" class="text-xs mt-2">{{ comparison.note }}</p>
				<div class="overflow-x-auto"><table class="w-full mt-2" data-testid="ingredient-deviation">
					<caption class="text-left text-xs text-muted-foreground pb-2">{{ __("Pounds for the whole order. Differences come from the current pull plan.") }}</caption>
					<thead><tr><th>{{ __("Ingredient") }}</th><th class="numeric">{{ __("Scaled recipe") }}</th><th class="numeric">{{ __("Planned pulls") }}</th><th class="numeric">{{ __("Difference (lb)") }}</th></tr></thead>
					<tbody><tr v-for="row in comparison.ingredients" :key="row.item_code"><td>{{ row.item_name || row.item_code }}</td><td class="numeric">{{ number(row.recipe_lb) }}</td><td class="numeric">{{ number(row.planned_lb) }}</td><td class="numeric">{{ signed(row.planned_lb - row.recipe_lb) }}</td></tr></tbody>
				</table></div>
				<div class="overflow-x-auto"><table class="w-full mt-3" data-testid="nutrition-deviation">
					<caption class="text-left font-medium pb-2">{{ __("Calculated nutrition at this size") }}</caption>
					<thead><tr><th>{{ __("Nutrient") }}</th><th class="numeric">{{ __("Recipe") }}</th><th class="numeric">{{ __("Planned") }}</th><th class="numeric">{{ __("Relative change") }}</th></tr></thead>
					<tbody><tr v-for="field in fields(comparison.recipe_analysis, comparison.planned_analysis)" :key="field"><td>{{ label(field) }}</td><td class="numeric">{{ number(comparison.recipe_analysis[field]) }}</td><td class="numeric">{{ number(comparison.planned_analysis[field]) }}</td><td class="numeric">{{ relative(comparison.recipe_analysis[field], comparison.planned_analysis[field]) }}</td></tr></tbody>
				</table></div>
				<p class="text-xs text-muted-foreground mt-2">{{ __("Calculated changes are relative to the recipe, not to the recorded guarantee. Final production may differ from planned pulls.") }}</p>
			</template>
			<p v-else class="text-muted-foreground mt-2">{{ pull?.blocked ? __("No practical pull list yet. Choose a fix in the cart to see the comparison.") : __("The current pull comparison is not available yet.") }}</p>
		</section>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import __ from "@/lib/translate";
import type { FeedAnalysis, FeedDetails } from "@/types/feedDetails";
import type { MixPull } from "@/utils/mixPull";
const props = defineProps<{ details: FeedDetails; order?: boolean; orderSize?: string; pull?: MixPull | null; pending?: boolean; message?: string }>();
const comparison = computed(() => props.pending || props.message || props.pull?.blocked ? null : props.pull?.comparison);
const core = ["protein_pct", "fat_pct", "fiber_pct"];
function fields(...analyses: Array<FeedAnalysis | undefined>) {
	return [...new Set([...core, ...Object.keys(props.details.nutrient_labels || {}), ...analyses.flatMap(a => Object.keys(a || {}))])]
		.filter(field => core.includes(field) || analyses.some(a => a?.[field] != null));
}
function label(field: string) { return props.details.nutrient_labels?.[field] || ({ protein_pct: "Protein %", fat_pct: "Fat %", fiber_pct: "Fiber %" } as Record<string, string>)[field] || field; }
function number(value: number | null | undefined) { return value == null || !Number.isFinite(value) ? __("Unknown") : value.toLocaleString(undefined, { maximumFractionDigits: 3 }); }
function signed(value: number) { return (value > 0.0005 ? "+" : "") + number(Math.abs(value) < 0.0005 ? 0 : value); }
function relative(base: number | null | undefined, planned: number | null | undefined) {
	if (base == null || planned == null) return __("Unknown");
	if (base === 0) return planned === 0 ? "0%" : "—";
	return signed((planned / base - 1) * 100) + "%";
}
function missing(field: string) { const items = props.details.analysis_missing_items?.[field]; return items?.length ? __("Missing analysis: {0}", [items.join(", ")]) : ""; }
</script>

<style scoped>
th, td { padding: .5rem .4rem; text-align: left; border-bottom: 1px solid hsl(var(--border)); }
th { font-size: .75rem; font-weight: 600; color: hsl(var(--muted-foreground)); }
.numeric { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
