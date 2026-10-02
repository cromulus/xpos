<template>
	<!-- A practice (staging) till says so, in red, lower left (Bill 2026-10-01, MuleCity-qajl.1).
	     The flag comes from the Mule app's site_role.py in boot; absent or false (production,
	     erp.mulecity.com, MuleCity-nfxn.1) = no banner. It never takes a click. -->
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
import __ from "@/lib/translate";

const practiceSite = !!(window as unknown as { xpos?: { boot?: { mule_practice_site?: unknown } } }).xpos?.boot
	?.mule_practice_site;
</script>
