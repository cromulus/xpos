<template>
	<!-- A question with more than one answer, e.g. what to do with a full cart before
	     loading something else into it (Mule City, Bill 2026-11-12, MuleCity-rj2o). -->
	<Dialog
		:open="open"
		@update:open="
			(val: boolean) => {
				if (!val) $emit('cancel');
			}
		"
	>
		<DialogContent class="max-w-md" data-testid="choice-dialog">
			<DialogHeader>
				<DialogTitle class="text-base">{{ title }}</DialogTitle>
				<DialogDescription v-if="description" class="text-sm">{{ description }}</DialogDescription>
			</DialogHeader>
			<div class="flex flex-col gap-2">
				<Button
					v-for="choice in choices"
					:key="choice.key"
					:variant="choice.variant || 'default'"
					class="w-full justify-start h-auto py-2.5 text-start whitespace-normal"
					:data-testid="'choice-' + choice.key"
					@click="$emit('choose', choice.key)"
				>
					<span class="flex flex-col items-start">
						<span class="font-semibold">{{ choice.label }}</span>
						<span v-if="choice.hint" class="text-xs font-normal opacity-80">{{ choice.hint }}</span>
					</span>
				</Button>
			</div>
			<DialogFooter>
				<Button variant="outline" class="w-full" data-testid="choice-cancel" @click="$emit('cancel')">
					{{ __("Cancel") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import __ from "@/lib/translate";

export interface Choice {
	key: string;
	label: string;
	hint?: string;
	variant?: "default" | "outline" | "destructive" | "secondary";
}

defineProps<{ open: boolean; title: string; description?: string; choices: Choice[] }>();

defineEmits<{ choose: [key: string]; cancel: [] }>();
</script>
