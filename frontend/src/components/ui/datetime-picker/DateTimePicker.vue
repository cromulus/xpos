<script setup lang="ts">
import { computed, ref, watch, nextTick, type HTMLAttributes } from "vue";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContentStyled } from "@/components/ui/popover";
import { __, cn } from "@/lib/utils";
import { nowDate } from "@/utils/datetime";

type DateTimeMode = "date" | "time" | "datetime";

const props = withDefaults(
	defineProps<{
		modelValue?: string;
		mode?: DateTimeMode;
		placeholder?: string;
		disabled?: boolean;
		minDate?: string;
		maxDate?: string;
		use12Hour?: boolean;
		firstDayOfWeek?: 0 | 1;
		showToday?: boolean;
		showNow?: boolean;
		clearable?: boolean;
		label?: string;
		class?: HTMLAttributes["class"];
	}>(),
	{
		mode: "datetime",
		placeholder: "Pick date & time",
		disabled: false,
		use12Hour: false,
		firstDayOfWeek: 1,
		showToday: true,
		showNow: true,
		clearable: true,
	},
);

const emit = defineEmits<{
	(e: "update:modelValue", value: string): void;
	(e: "change", value: string): void;
}>();

const open = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
const inputText = ref("");
const validationError = ref("");

const viewYear = ref(new Date().getFullYear());
const viewMonth = ref(new Date().getMonth());

const selectedDate = ref("");
const selectedTime = ref("00:00:00");
const calendarView = ref<"day" | "month" | "year">("day");

const DATE_DISPLAY_FORMAT = "DD-MM-YYYY";

function parseUserDate(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	let day: number, month: number, year: number;

	const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
	if (isoMatch) {
		year = parseInt(isoMatch[1], 10);
		month = parseInt(isoMatch[2], 10);
		day = parseInt(isoMatch[3], 10);
	} else {
		const userMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
		if (!userMatch) return null;
		day = parseInt(userMatch[1], 10);
		month = parseInt(userMatch[2], 10);
		year = parseInt(userMatch[3], 10);
		if (year < 100) {
			year += year < 50 ? 2000 : 1900;
		}
	}

	if (month < 1 || month > 12 || day < 1 || day > 31) return null;

	const testDate = new Date(year, month - 1, day);
	if (testDate.getFullYear() !== year || testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
		return null;
	}

	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseUserTime(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
	if (!match) return null;

	const h = parseInt(match[1], 10);
	const m = parseInt(match[2], 10);
	const s = match[3] ? parseInt(match[3], 10) : 0;

	if (h > 23 || m > 59 || s > 59) return null;

	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDateForDisplay(dateStr: string): string {
	if (!dateStr) return "";
	const [y, m, d] = dateStr.split("-");
	return `${d}/${m}/${y}`;
}

function formatTimeForDisplay(timeStr: string): string {
	if (!timeStr || timeStr === "00:00:00") return "";
	if (props.use12Hour) {
		const h = parseInt(timeStr.split(":")[0] ?? "0", 10);
		const m = timeStr.split(":")[1] ?? "00";
		const h12 = h % 12 || 12;
		const period = h >= 12 ? "PM" : "AM";
		return `${String(h12).padStart(2, "0")}:${m} ${period}`;
	}
	return timeStr.slice(0, 5);
}

function updateInputText() {
	if (props.mode === "time") {
		inputText.value = formatTimeForDisplay(selectedTime.value);
		return;
	}
	const datePart = formatDateForDisplay(selectedDate.value);
	if (!datePart) {
		inputText.value = "";
		return;
	}
	if (props.mode === "date") {
		inputText.value = datePart;
		return;
	}
	const timePart = formatTimeForDisplay(selectedTime.value);
	inputText.value = timePart ? `${datePart} ${timePart}` : datePart;
}

function parseValue(val: string | undefined) {
	if (!val) {
		selectedDate.value = "";
		selectedTime.value = "00:00:00";
		updateInputText();
		return;
	}
	if (props.mode === "time") {
		selectedDate.value = "";
		selectedTime.value = normalizeTime(val);
		updateInputText();
		return;
	}
	const parts = val.includes(" ") ? val.split(" ") : val.includes("T") ? val.split("T") : [val];
	selectedDate.value = parts[0] ?? "";
	selectedTime.value = parts[1] ? normalizeTime(parts[1]) : "00:00:00";

	if (selectedDate.value) {
		const [y, m] = selectedDate.value.split("-").map(Number);
		if (y && m) {
			viewYear.value = y;
			viewMonth.value = m - 1;
		}
	}
	updateInputText();
}

function normalizeTime(t: string): string {
	const parts = t.split(":");
	const hh = (parts[0] ?? "00").padStart(2, "0");
	const mm = (parts[1] ?? "00").padStart(2, "0");
	const ss = (parts[2] ?? "00").padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

watch(() => props.modelValue, parseValue, { immediate: true });

function onInputCommit() {
	validationError.value = "";
	const raw = inputText.value.trim();

	if (!raw) {
		clearValue();
		return;
	}

	if (props.mode === "time") {
		const parsed = parseUserTime(raw);
		if (!parsed) {
			validationError.value = "Time must be in format: HH:mm or HH:mm:ss";
			updateInputText();
			return;
		}
		selectedTime.value = parsed;
		emitValue();
		updateInputText();
		return;
	}

	const spaceIdx = raw.indexOf(" ");
	let datePart = raw;
	let timePart = "";

	if (props.mode === "datetime" && spaceIdx !== -1) {
		datePart = raw.slice(0, spaceIdx).trim();
		timePart = raw.slice(spaceIdx + 1).trim();
	}

	const parsedDate = parseUserDate(datePart);
	if (!parsedDate) {
		validationError.value = `Date must be in format: ${DATE_DISPLAY_FORMAT}`;
		updateInputText();
		return;
	}

	if (isDateDisabled(parsedDate)) {
		validationError.value = "Date is outside the allowed range";
		updateInputText();
		return;
	}

	selectedDate.value = parsedDate;

	const [y, m] = parsedDate.split("-").map(Number);
	viewYear.value = y;
	viewMonth.value = m - 1;

	if (props.mode === "datetime" && timePart) {
		const parsedTime = parseUserTime(timePart);
		if (parsedTime) {
			selectedTime.value = parsedTime;
		}
	}

	emitValue();
	updateInputText();
}

function onInputKeydown(e: KeyboardEvent) {
	validationError.value = "";

	if (e.key === "t" || e.key === "T") {
		e.preventDefault();
		setNow();
		return;
	}

	if (e.key === "Enter") {
		e.preventDefault();
		onInputCommit();
		return;
	}

	if (e.key === "Escape") {
		open.value = false;
		updateInputText();
	}
}

watch(open, (isOpen) => {
	if (isOpen) {
		nextTick(() => {
			inputRef.value?.focus();
			inputRef.value?.select();
		});
	} else {
		calendarView.value = "day";
	}
});

const DAYS_SHORT_MON = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAYS_SHORT_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const dayHeaders = computed(() => (props.firstDayOfWeek === 1 ? DAYS_SHORT_MON : DAYS_SHORT_SUN));

const yearRangeStart = computed(() => Math.floor(viewYear.value / 12) * 12);

interface CalendarDay {
	date: string;
	day: number;
	isCurrentMonth: boolean;
	isToday: boolean;
	isSelected: boolean;
	isDisabled: boolean;
}

const calendarDays = computed((): CalendarDay[] => {
	const year = viewYear.value;
	const month = viewMonth.value;
	const firstOfMonth = new Date(year, month, 1);
	const lastOfMonth = new Date(year, month + 1, 0);

	let startDow = firstOfMonth.getDay();
	if (props.firstDayOfWeek === 1) {
		startDow = startDow === 0 ? 6 : startDow - 1;
	}

	const today = nowDate();
	const days: CalendarDay[] = [];

	const prevMonthLast = new Date(year, month, 0).getDate();
	for (let i = startDow - 1; i >= 0; i--) {
		const d = prevMonthLast - i;
		const dt = formatDateStr(year, month - 1, d);
		days.push({
			date: dt,
			day: d,
			isCurrentMonth: false,
			isToday: dt === today,
			isSelected: dt === selectedDate.value,
			isDisabled: isDateDisabled(dt),
		});
	}

	for (let d = 1; d <= lastOfMonth.getDate(); d++) {
		const dt = formatDateStr(year, month, d);
		days.push({
			date: dt,
			day: d,
			isCurrentMonth: true,
			isToday: dt === today,
			isSelected: dt === selectedDate.value,
			isDisabled: isDateDisabled(dt),
		});
	}

	const remaining = 42 - days.length;
	for (let d = 1; d <= remaining; d++) {
		const dt = formatDateStr(year, month + 1, d);
		days.push({
			date: dt,
			day: d,
			isCurrentMonth: false,
			isToday: dt === today,
			isSelected: dt === selectedDate.value,
			isDisabled: isDateDisabled(dt),
		});
	}

	return days;
});

function formatDateStr(year: number, month: number, day: number): string {
	const d = new Date(year, month, day);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

function isDateDisabled(dateStr: string): boolean {
	if (props.minDate && dateStr < props.minDate) return true;
	if (props.maxDate && dateStr > props.maxDate) return true;
	return false;
}

function prevMonth() {
	if (viewMonth.value === 0) {
		viewMonth.value = 11;
		viewYear.value--;
	} else {
		viewMonth.value--;
	}
}

function nextMonth() {
	if (viewMonth.value === 11) {
		viewMonth.value = 0;
		viewYear.value++;
	} else {
		viewMonth.value++;
	}
}

function goToday() {
	const now = new Date();
	viewYear.value = now.getFullYear();
	viewMonth.value = now.getMonth();
}

function prevPeriod() {
	if (calendarView.value === "day") {
		prevMonth();
	} else if (calendarView.value === "month") {
		viewYear.value--;
	} else {
		viewYear.value -= 12;
	}
}

function nextPeriod() {
	if (calendarView.value === "day") {
		nextMonth();
	} else if (calendarView.value === "month") {
		viewYear.value++;
	} else {
		viewYear.value += 12;
	}
}

function openMonthView() {
	calendarView.value = "month";
}

function openYearView() {
	calendarView.value = "year";
}

function selectMonth(monthIndex: number) {
	viewMonth.value = monthIndex;
	calendarView.value = "day";
}

function selectYear(year: number) {
	viewYear.value = year;
	calendarView.value = "month";
}

function selectDay(day: CalendarDay) {
	if (day.isDisabled) return;
	validationError.value = "";
	selectedDate.value = day.date;

	const [y, m] = day.date.split("-").map(Number);
	viewYear.value = y;
	viewMonth.value = m - 1;

	emitValue();
	updateInputText();

	if (props.mode === "date") {
		open.value = false;
	}
}

const hours = computed({
	get: () => parseInt(selectedTime.value.split(":")[0] ?? "0", 10),
	set: (v: number) => updateTimePart(v, minutes.value, seconds.value),
});

const minutes = computed({
	get: () => parseInt(selectedTime.value.split(":")[1] ?? "0", 10),
	set: (v: number) => updateTimePart(hours.value, v, seconds.value),
});

const seconds = computed({
	get: () => parseInt(selectedTime.value.split(":")[2] ?? "0", 10),
	set: (v: number) => updateTimePart(hours.value, minutes.value, v),
});

function updateTimePart(h: number, m: number, s: number) {
	selectedTime.value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	emitValue();
	updateInputText();
}

function incrementHour(delta: number) {
	hours.value = (hours.value + delta + 24) % 24;
}

function incrementMinute(delta: number) {
	minutes.value = (minutes.value + delta + 60) % 60;
}

function incrementSecond(delta: number) {
	seconds.value = (seconds.value + delta + 60) % 60;
}

const displayHour = computed(() => {
	if (!props.use12Hour) return String(hours.value).padStart(2, "0");
	const h12 = hours.value % 12 || 12;
	return String(h12).padStart(2, "0");
});

const amPm = computed(() => (hours.value >= 12 ? "PM" : "AM"));

function toggleAmPm() {
	hours.value = (hours.value + 12) % 24;
}

function emitValue() {
	let val = "";
	if (props.mode === "date") {
		val = selectedDate.value;
	} else if (props.mode === "time") {
		val = selectedTime.value;
	} else {
		val = selectedDate.value ? `${selectedDate.value} ${selectedTime.value}` : "";
	}
	emit("update:modelValue", val);
	emit("change", val);
}

const formattedDisplay = computed(() => {
	if (props.mode === "time") {
		if (!selectedTime.value || selectedTime.value === "00:00:00") return "";
		return formatTimeForDisplay(selectedTime.value);
	}

	if (!selectedDate.value) return "";
	const dateStr = formatDateForDisplay(selectedDate.value);

	if (props.mode === "date") return dateStr;

	const timeStr = formatTimeForDisplay(selectedTime.value);
	return timeStr ? `${dateStr}  ${timeStr}` : dateStr;
});

function setNow() {
	validationError.value = "";
	const now = new Date();
	if (props.mode !== "time") {
		selectedDate.value = nowDate();
		viewYear.value = now.getFullYear();
		viewMonth.value = now.getMonth();
	}
	selectedTime.value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
	emitValue();
	updateInputText();
	open.value = false;
}

function setToday() {
	validationError.value = "";
	const now = new Date();
	selectedDate.value = nowDate();
	viewYear.value = now.getFullYear();
	viewMonth.value = now.getMonth();
	emitValue();
	updateInputText();
	if (props.mode === "date") {
		open.value = false;
	}
}

function clearValue() {
	validationError.value = "";
	selectedDate.value = "";
	selectedTime.value = "00:00:00";
	inputText.value = "";
	emit("update:modelValue", "");
	emit("change", "");
}
</script>

<template>
	<div :class="cn('relative', props.class)">
		<label v-if="label" class="block text-sm font-medium text-foreground mb-1.5">
			{{ label }}
		</label>

		<Popover v-model:open="open">
			<PopoverTrigger as-child>
				<Button
					type="button"
					variant="outline"
					:disabled="disabled"
					:class="
						cn(
							'h-9 w-full justify-start gap-2 px-3 text-start font-normal',
							!formattedDisplay && 'text-muted-foreground',
							props.class,
						)
					"
				>
					<CalendarDays v-if="mode !== 'time'" class="h-4 w-4 shrink-0" />
					<Clock v-else class="h-4 w-4 shrink-0" />
					<span class="truncate flex-1">{{ formattedDisplay || placeholder }}</span>
					<button
						v-if="clearable && formattedDisplay"
						type="button"
						tabindex="-1"
						class="ms-auto p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
						@click.stop="clearValue"
					>
						<X class="h-3.5 w-3.5" />
					</button>
				</Button>
			</PopoverTrigger>

			<PopoverContentStyled
				:class="
					cn('p-0 w-auto max-w-[calc(100vw-1rem)]', mode === 'time' ? 'w-[200px]' : 'w-[300px]')
				"
				align="start"
			>
				<div class="px-3 pt-3 pb-2">
					<div class="relative">
						<input
							ref="inputRef"
							v-model="inputText"
							type="text"
							:placeholder="
								mode === 'time'
									? 'HH:mm:ss'
									: mode === 'date'
										? DATE_DISPLAY_FORMAT
										: `${DATE_DISPLAY_FORMAT} HH:mm`
							"
							:disabled="disabled"
							class="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							:class="validationError && 'border-destructive ring-destructive'"
							@keydown="onInputKeydown"
							@blur="onInputCommit"
						/>
					</div>
					<p v-if="validationError" class="mt-1 text-xs text-destructive">
						{{ validationError }}
					</p>
					<p v-else class="mt-1 text-[10px] text-muted-foreground">
						Type directly or press
						<kbd
							class="mx-0.5 inline-flex h-4 items-center rounded border bg-muted px-1 font-mono text-[10px]"
							>T</kbd
						>
						for {{ mode === "time" ? "now" : "today" }}
					</p>
				</div>

				<div v-if="mode !== 'time'" class="px-3 pb-1">
					<div class="flex items-center justify-between mb-3">
						<Button type="button" variant="ghost" size="icon" class="h-7 w-7" @click="prevPeriod">
							<ChevronLeft class="h-4 w-4" />
						</Button>
						<div v-if="calendarView === 'day'" class="flex items-center gap-1">
							<button
								type="button"
								class="text-sm font-semibold text-foreground hover:text-primary transition-colors"
								@click="openMonthView"
							>
								{{ MONTHS[viewMonth] }}
							</button>
							<button
								type="button"
								class="text-sm font-semibold text-foreground hover:text-primary transition-colors"
								@click="openYearView"
							>
								{{ viewYear }}
							</button>
						</div>
						<button
							v-else-if="calendarView === 'month'"
							type="button"
							class="text-sm font-semibold text-foreground hover:text-primary transition-colors"
							@click="openYearView"
						>
							{{ viewYear }}
						</button>
						<span v-else class="text-sm font-semibold text-foreground">
							{{ yearRangeStart }} – {{ yearRangeStart + 11 }}
						</span>
						<Button type="button" variant="ghost" size="icon" class="h-7 w-7" @click="nextPeriod">
							<ChevronRight class="h-4 w-4" />
						</Button>
					</div>

					<template v-if="calendarView === 'day'">
						<div class="grid grid-cols-7 mb-1">
							<div
								v-for="dh in dayHeaders"
								:key="dh"
								class="text-center text-[11px] font-medium text-muted-foreground py-1"
							>
								{{ dh }}
							</div>
						</div>

						<div class="grid grid-cols-7 gap-0.5">
							<button
								v-for="(day, idx) in calendarDays"
								:key="idx"
								type="button"
								:disabled="day.isDisabled"
								class="relative h-8 w-8 mx-auto rounded-md text-sm transition-colors flex items-center justify-center"
								:class="[
									day.isSelected
										? 'bg-primary text-primary-foreground font-semibold'
										: day.isToday
											? 'bg-accent text-accent-foreground font-medium'
											: day.isCurrentMonth
												? 'text-foreground hover:bg-accent/50'
												: 'text-muted-foreground/40 hover:bg-accent/30',
									day.isDisabled && 'opacity-30 cursor-not-allowed',
								]"
								@click="selectDay(day)"
							>
								{{ day.day }}
								<span
									v-if="day.isToday && !day.isSelected"
									class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary"
								></span>
							</button>
						</div>
					</template>

					<template v-else-if="calendarView === 'month'">
						<div class="grid grid-cols-3 gap-1 pb-1">
							<button
								v-for="(monthName, idx) in MONTHS"
								:key="idx"
								type="button"
								class="h-9 rounded-md text-sm transition-colors flex items-center justify-center"
								:class="[
									idx === viewMonth
										? 'bg-primary text-primary-foreground font-semibold'
										: 'text-foreground hover:bg-accent/50',
								]"
								@click="selectMonth(idx)"
							>
								{{ monthName.slice(0, 3) }}
							</button>
						</div>
					</template>

					<template v-else>
						<div class="grid grid-cols-3 gap-1 pb-1">
							<button
								v-for="year in Array.from({ length: 12 }, (_, i) => yearRangeStart + i)"
								:key="year"
								type="button"
								class="h-9 rounded-md text-sm transition-colors flex items-center justify-center"
								:class="[
									year === viewYear
										? 'bg-primary text-primary-foreground font-semibold'
										: 'text-foreground hover:bg-accent/50',
								]"
								@click="selectYear(year)"
							>
								{{ year }}
							</button>
						</div>
					</template>
				</div>

				<div
					v-if="mode !== 'date'"
					:class="
						cn(
							'px-3 pb-3',
							mode === 'datetime' && 'border-t border-border pt-3',
							mode === 'time' && 'pt-1',
						)
					"
				>
					<div class="flex items-center justify-center gap-1">
						<div class="flex flex-col items-center">
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementHour(1)"
							>
								<ChevronLeft class="h-3.5 w-3.5 rotate-90" />
							</button>
							<div
								class="w-10 h-8 flex items-center justify-center text-lg font-mono font-semibold text-foreground bg-muted rounded"
							>
								{{ displayHour }}
							</div>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementHour(-1)"
							>
								<ChevronRight class="h-3.5 w-3.5 rotate-90" />
							</button>
						</div>

						<span class="text-lg font-mono font-bold text-muted-foreground">:</span>

						<div class="flex flex-col items-center">
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementMinute(1)"
							>
								<ChevronLeft class="h-3.5 w-3.5 rotate-90" />
							</button>
							<div
								class="w-10 h-8 flex items-center justify-center text-lg font-mono font-semibold text-foreground bg-muted rounded"
							>
								{{ String(minutes).padStart(2, "0") }}
							</div>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementMinute(-1)"
							>
								<ChevronRight class="h-3.5 w-3.5 rotate-90" />
							</button>
						</div>

						<span class="text-lg font-mono font-bold text-muted-foreground">:</span>

						<div class="flex flex-col items-center">
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementSecond(1)"
							>
								<ChevronLeft class="h-3.5 w-3.5 rotate-90" />
							</button>
							<div
								class="w-10 h-8 flex items-center justify-center text-lg font-mono font-semibold text-foreground bg-muted rounded"
							>
								{{ String(seconds).padStart(2, "0") }}
							</div>
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground p-0.5"
								@click="incrementSecond(-1)"
							>
								<ChevronRight class="h-3.5 w-3.5 rotate-90" />
							</button>
						</div>

						<button
							v-if="use12Hour"
							type="button"
							class="ms-2 px-2 h-8 rounded bg-muted text-sm font-semibold text-foreground hover:bg-accent transition-colors"
							@click="toggleAmPm"
						>
							{{ amPm }}
						</button>
					</div>
				</div>

				<div class="flex items-center justify-between p-2 border-t border-border">
					<div class="flex items-center gap-1">
						<Button
							v-if="clearable"
							type="button"
							variant="ghost"
							size="sm"
							class="h-7 text-xs"
							@click="clearValue"
						>
							{{ __("Clear") }}
						</Button>
					</div>
					<div class="flex items-center gap-1">
						<Button
							v-if="showToday && mode !== 'time'"
							type="button"
							variant="ghost"
							size="sm"
							class="h-7 text-xs"
							@click="setToday"
						>
							{{ __("Today") }}
						</Button>
						<Button
							v-if="showNow"
							type="button"
							variant="outline"
							size="sm"
							class="h-7 text-xs"
							@click="setNow"
						>
							{{ __("Now") }}
						</Button>
					</div>
				</div>
			</PopoverContentStyled>
		</Popover>
	</div>
</template>
