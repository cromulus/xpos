<template>
	<!-- A practice (staging) till says so, in red, lower left. The flag is the site's
	     (xpos_site `practice_site`, from a site-role app); absent or false (production) =
	     no banner. It never takes a click. -->
	<div
		v-if="practiceSite"
		role="status"
		data-testid="practice-site-banner"
		class="fixed start-2 bottom-16 md:bottom-2 z-50 pointer-events-none select-none rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold uppercase tracking-wide text-white shadow-lg"
	>
		{{ __("Practice site") }}
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import __ from "@/lib/translate";
import { siteFeature } from "@/services/siteExtensions";

const practiceSite = computed(() => siteFeature("practice_site"));
</script>
