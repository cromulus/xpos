<template>
	<!-- "?" in the till header (Mule City, MuleCity-vz28.17.20): the counter's procedures from the
	     manual, as the desk's "How do I…?" lists them (mulecity_erpnext.in_app_help.get_help, screen
	     "xpos", docs/erpnext/runbook/help-map.yml). Each opens /manual/<page>#<heading> in a new tab;
	     the till keeps its basket. No entries: the manual's counter page. A site without the help
	     (no Mule app or Wiki yet, or offline) says so, never a dead link. -->
	<Popover v-model:open="open">
		<PopoverTrigger as-child>
			<Button
				variant="ghost"
				size="sm"
				class="text-muted-foreground hover:text-foreground gap-1"
				data-testid="counter-help"
				:title="__('How do I…?')"
				@click="load"
			>
				<CircleHelp class="w-4 h-4" />
				<span class="hidden lg:inline text-xs">{{ __("Help") }}</span>
			</Button>
		</PopoverTrigger>
		<PopoverContentStyled class="w-96 p-2 max-h-[70vh] overflow-y-auto" align="end">
			<p class="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">{{ __("How do I…?") }}</p>
			<a
				v-for="entry in entries"
				:key="entry.id"
				:href="entry.url"
				target="_blank"
				rel="noopener"
				class="flex gap-2 rounded-md px-2 py-1.5 no-underline hover:bg-accent"
				data-testid="counter-help-entry"
			>
				<span class="shrink-0 rounded bg-primary/10 px-1.5 text-xs font-semibold text-primary">{{ entry.id }}</span>
				<span class="flex flex-col">
					<span class="text-sm font-medium text-foreground">{{ entry.title }}</span>
					<span v-if="entry.use_when" class="text-xs text-muted-foreground">{{ entry.use_when }}</span>
				</span>
			</a>
			<p v-if="unavailable" class="px-2 py-1.5 text-sm text-muted-foreground" data-testid="counter-help-unavailable">
				{{ __("Help isn't available on this till right now.") }}
			</p>
			<a v-else :href="MANUAL" target="_blank" rel="noopener" class="block px-2 pt-2 text-xs">{{ __("The counter page of the manual") }}</a>
		</PopoverContentStyled>
	</Popover>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { CircleHelp } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContentStyled, PopoverTrigger } from "@/components/ui/popover";
import { call } from "@/services/api";
import { __ } from "@/lib/translate";

type Entry = { id: string; title: string; use_when: string; url: string };
const MANUAL = "/manual/counter";
const open = ref(false);
const entries = ref<Entry[]>([]);
const unavailable = ref(false);

async function load() {
	if (entries.value.length) return;
	unavailable.value = false;
	try {
		const help = await call<{ entries: Entry[] }>("mulecity_erpnext.in_app_help.get_help", { screen: "xpos" });
		const seen = new Set<string>();
		entries.value = (help?.entries || []).filter((e) => !seen.has(e.id) && seen.add(e.id));
	} catch {
		// No help API here (or offline): keep the popover open with a note; /manual may not exist.
		entries.value = [];
		unavailable.value = true;
		return;
	}
	if (!entries.value.length) {
		open.value = false;
		window.open(MANUAL, "_blank", "noopener");
	}
}
</script>
