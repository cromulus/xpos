/**
 * The add-address street field as a Google typeahead (Mule City, MuleCity-p644).
 *
 * Online, from 4 characters and a pause of about 300 ms, the site's suggestions
 * show under the street field; arrows move, Enter (or a tap) picks, Esc closes
 * the list. A pick is resolved by the site into the form's fields, its point
 * and its miles. One session token per address: made when the form opens, made
 * again after a pick and when the form closes.
 *
 * Offline: no lookups; the typed form as before. When the site cannot look up
 * (no key, Google refused, too many lookups) a short note says so, the list
 * stays shut and the till does not ask again for a while
 * (services/addressLookup.ts); the typed form and typed miles keep working.
 */
import { ref, type Ref } from "vue";
import {
	LOOKUP_DEBOUNCE_MS,
	LookupUnavailable,
	MIN_LOOKUP_TEXT,
	lookupResting,
	newSessionToken,
	resolveAddress,
	suggestAddresses,
	type AddressSuggestion,
	type ResolvedAddress,
} from "@/services/addressLookup";

export function useAddressTypeahead(options: { online: Ref<boolean>; debounceMs?: number }) {
	const delay = options.debounceMs ?? LOOKUP_DEBOUNCE_MS;
	const suggestions = ref<AddressSuggestion[]>([]);
	const listOpen = ref(false);
	const highlighted = ref(-1);
	const unavailable = ref(false);
	const resolving = ref(false);
	const sessionToken = ref(newSessionToken());
	let timer: ReturnType<typeof setTimeout> | null = null;
	// Answers to an earlier keystroke (or a closed form) are dropped.
	let asked = 0;

	function cancelPending() {
		if (timer) clearTimeout(timer);
		timer = null;
		asked++;
	}

	function closeList() {
		listOpen.value = false;
		highlighted.value = -1;
	}

	function stop() {
		cancelPending();
		closeList();
		suggestions.value = [];
	}

	/** A new address: a new session, no list, no note (the cooldown still holds). */
	function newSession() {
		stop();
		resolving.value = false;
		unavailable.value = lookupResting();
		sessionToken.value = newSessionToken();
	}

	function giveUp() {
		unavailable.value = true;
		stop();
	}

	/** The clerk typed in the street field. */
	function typed(text: string) {
		cancelPending();
		if (!options.online.value || unavailable.value || text.trim().length < MIN_LOOKUP_TEXT) {
			closeList();
			suggestions.value = [];
			return;
		}
		if (lookupResting()) return giveUp();
		const mine = asked;
		timer = setTimeout(async () => {
			timer = null;
			try {
				const found = await suggestAddresses(text, sessionToken.value);
				if (mine !== asked) return;
				suggestions.value = found;
				highlighted.value = found.length ? 0 : -1;
				listOpen.value = found.length > 0;
			} catch (error) {
				if (mine !== asked) return;
				if (error instanceof LookupUnavailable) giveUp();
				else stop(); // the network: offline now, the clerk types
			}
		}, delay);
	}

	/** Resolve the picked suggestion; null when it could not be (the clerk types). */
	async function pick(index = highlighted.value): Promise<ResolvedAddress | null> {
		const suggestion = suggestions.value[index];
		if (!suggestion || resolving.value) return null;
		const token = sessionToken.value;
		stop();
		resolving.value = true;
		try {
			const resolved = await resolveAddress(suggestion.place_id, token);
			return resolved;
		} catch (error) {
			if (error instanceof LookupUnavailable) giveUp();
			return null;
		} finally {
			resolving.value = false;
			// The pick ends Google's session: the next address starts a new one.
			sessionToken.value = newSessionToken();
		}
	}

	/** Arrows move through the list, Enter picks, Esc closes it. True when the key was the list's. */
	function keydown(event: KeyboardEvent, onPick: (index: number) => void): boolean {
		if (!listOpen.value || !suggestions.value.length) return false;
		const count = suggestions.value.length;
		if (event.key === "ArrowDown") highlighted.value = (highlighted.value + 1) % count;
		else if (event.key === "ArrowUp") highlighted.value = (highlighted.value - 1 + count) % count;
		else if (event.key === "Enter") onPick(highlighted.value < 0 ? 0 : highlighted.value);
		else if (event.key === "Escape") closeList();
		else return false;
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	return { suggestions, listOpen, highlighted, unavailable, resolving, sessionToken, typed, pick, keydown, closeList, newSession, stop };
}
