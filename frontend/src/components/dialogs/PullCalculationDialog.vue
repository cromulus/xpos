<script setup lang="ts">
import { watch, onUnmounted } from "vue";
import { Loader2 } from "lucide-vue-next";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import __ from "@/lib/translate";

const props = defineProps<{ open: boolean }>();
// Radix's standard modal traps focus and blocks pointer edits. Capture before
// document-level till shortcuts/scanner keystrokes so they cannot mutate a cart.
const block = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
watch(() => props.open, open => {
	if (open) {
		(document.activeElement as HTMLElement | null)?.blur();
		window.addEventListener("keydown", block, true);
	} else window.removeEventListener("keydown", block, true);
}, { immediate: true, flush: "sync" });
onUnmounted(() => window.removeEventListener("keydown", block, true));
</script>

<template>
	<Dialog :open="open">
		<DialogContent hide-close class="max-w-sm" @escape-key-down.prevent @pointer-down-outside.prevent @interact-outside.prevent>
			<DialogTitle>{{ __("Calculating pull list…") }}</DialogTitle>
			<DialogDescription>{{ __("Please wait. The order will update automatically.") }}</DialogDescription>
			<div role="status" :aria-label="__('Calculating pull list')" aria-busy="true" class="flex justify-center">
				<Loader2 class="h-8 w-8 animate-spin" aria-hidden="true" />
			</div>
		</DialogContent>
	</Dialog>
</template>
