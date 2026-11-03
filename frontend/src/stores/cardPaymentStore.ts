/**
 * Pay by Card on the register's card reader (Mule City, MuleCity-bjjv.3).
 *
 * Steps: save the cart as a draft (with the reader's card row at 0.00) →
 * confirm any cash taken beside the card → start the payment on the reader →
 * poll its status, showing the reader's prompts, until the payments app has
 * submitted the draft (paid), or the card was declined or cancelled (try the
 * card again, or choose another tender: the draft stays, and Pay completes
 * that same draft).
 *
 * The payment in progress is kept in this browser (services/cardTerminal) so a
 * reload resumes watching it instead of charging again, and Close Shift waits
 * for it. Polling keeps going through network drops. Nothing here submits a
 * sale or queues one for create_invoice or for offline sync.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { __ } from "@/lib/translate";
import { isNetworkError, showError, showSuccess } from "@/services/api";
import { isElectron } from "@/services/electronBridge";
import { extractErrorMessage } from "@/utils";
import {
	CARD_OFF,
	availableTerminals,
	cancelCardPayment,
	cardPaymentStatus,
	clearPendingCard,
	describeCardStatus,
	fetchCardTerminalConfig,
	loadPendingCard,
	saveCardDraft,
	savePendingCard,
	startCardPayment,
	type CardPaymentStatus,
	type CardTerminalConfig,
	type CardView,
	type PendingCardPayment,
} from "@/services/cardTerminal";

export type CardStep = "idle" | "saving" | "pick" | "confirm" | "starting" | "collecting" | "done";

const CONFIG_KEY = "xpos:card-config:";
const POLL_MS = 2500;
const POLL_HIDDEN_MS = 10000;

function cachedConfig(profile: string): CardTerminalConfig | null {
	try {
		const raw = window.localStorage.getItem(CONFIG_KEY + profile);
		return raw ? (JSON.parse(raw) as CardTerminalConfig) : null;
	} catch {
		return null;
	}
}

function cacheConfig(profile: string, config: CardTerminalConfig): void {
	try {
		window.localStorage.setItem(CONFIG_KEY + profile, JSON.stringify(config));
	} catch {
		/* the next boot fetches it again */
	}
}

/** What the store needs from the till, given by the caller (no store imports: testable alone). */
export interface CardTill {
	/** The cart is this draft now: Pay (another tender) completes the same sale. */
	adoptDraft(name: string, modified: string): void;
	/** The sale is posted: clear the cart if it is still this sale, close Pay, print. */
	complete(invoice: string, withPrint: boolean): Promise<void>;
}

export interface BeginCardPayment {
	profile: string;
	invoiceData: Record<string, unknown>;
	cash: number;
	withPrint: boolean;
	cardMode?: string;
}

export const useCardPaymentStore = defineStore("cardPayment", () => {
	const config = ref<CardTerminalConfig>({ ...CARD_OFF });
	const configProfile = ref("");
	const pending = ref<PendingCardPayment | null>(loadPendingCard());
	const step = ref<CardStep>("idle");
	const open = ref(false);
	const status = ref<CardPaymentStatus | null>(null);
	const view = ref<CardView | null>(null);
	const error = ref("");
	const connectionLost = ref(false);
	const busy = ref(false);
	const cash = ref(0);
	const devices = ref<{ name: string; label: string; busy: boolean }[]>([]);
	const terminal = ref("");
	let till: CardTill | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const cardModes = computed(() => new Set(config.value.card_modes || []));
	const inProgress = computed(() => !!pending.value);

	function isCardMode(mode: string): boolean {
		return cardModes.value.has(mode);
	}

	function bindTill(value: CardTill): void {
		till = value;
	}

	async function loadConfig(profile: string): Promise<CardTerminalConfig> {
		if (!profile || isElectron()) {
			config.value = { ...CARD_OFF };
			configProfile.value = profile;
			return config.value;
		}
		// Offline boot: the last answer still hides the reader's mode from the tender buttons.
		const cached = cachedConfig(profile);
		if (cached) config.value = { ...cached, enabled: false };
		configProfile.value = profile;
		try {
			const fresh = await fetchCardTerminalConfig(profile);
			config.value = fresh || { ...CARD_OFF };
			cacheConfig(profile, config.value);
		} catch (err) {
			if (!cached) config.value = { ...CARD_OFF };
			if (!isNetworkError(err)) console.warn("[XPOS] Card reader settings unavailable:", err);
		}
		return config.value;
	}

	function persist(patch: Partial<PendingCardPayment>): void {
		if (!pending.value) return;
		pending.value = { ...pending.value, ...patch };
		savePendingCard(pending.value);
	}

	function stopPolling(): void {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function schedule(): void {
		stopPolling();
		const hidden = typeof document !== "undefined" && document.hidden;
		timer = setTimeout(() => void poll(), hidden ? POLL_HIDDEN_MS : POLL_MS);
	}

	function reset(): void {
		stopPolling();
		pending.value = null;
		clearPendingCard();
		step.value = "idle";
		status.value = null;
		view.value = null;
		error.value = "";
		connectionLost.value = false;
		busy.value = false;
		cash.value = 0;
		devices.value = [];
		terminal.value = "";
	}

	/** Pay by Card pressed in the Pay dialog. */
	async function begin(request: BeginCardPayment): Promise<void> {
		if (busy.value || pending.value?.attempt) return;
		busy.value = true;
		error.value = "";
		open.value = true;
		step.value = "saving";
		status.value = null;
		view.value = null;
		cash.value = request.cash;
		try {
			const draft = await saveCardDraft({
				...request.invoiceData,
				card_mode: request.cardMode || config.value.mode_of_payment || undefined,
			});
			pending.value = {
				profile: request.profile,
				doctype: draft.doctype,
				invoice: draft.name,
				modified: draft.modified,
				localId: (request.invoiceData.local_id as string) || undefined,
				amount: draft.card_amount,
				cash: request.cash,
				customer: (request.invoiceData.customer as string) || undefined,
				withPrint: request.withPrint,
				startedAt: new Date().toISOString(),
			};
			savePendingCard(pending.value);
			if (draft.submitted) {
				await finish();
				return;
			}
			if (draft.modified) till?.adoptDraft(draft.name, draft.modified);
			busy.value = false;
			await chooseReader();
		} catch (err) {
			busy.value = false;
			step.value = "idle";
			error.value = isNetworkError(err)
				? __("The connection dropped before the card reader was started. Nothing was charged; try again.")
				: extractErrorMessage(err);
		} finally {
			busy.value = false;
		}
	}

	/** Find the reader: resume what the server already has, else pick a free reader. */
	async function chooseReader(): Promise<void> {
		const record = pending.value;
		if (!record) return;
		const available = await availableTerminals(record.doctype, record.invoice);
		const known = available.active_attempt || available.posted_attempt;
		if (known) {
			persist({ attempt: known });
			step.value = "collecting";
			await poll();
			return;
		}
		devices.value = available.devices.filter((device) => !device.busy);
		if (!devices.value.length) {
			step.value = "idle";
			error.value = available.devices.length
				? __("The card reader is busy with another payment. Wait, or choose another tender.")
				: __("No card reader is available for this register. Choose another tender.");
			return;
		}
		if (!devices.value.some((device) => device.name === terminal.value)) {
			terminal.value = devices.value.length === 1 ? devices.value[0].name : "";
		}
		step.value = terminal.value ? (cash.value > 0 ? "confirm" : "starting") : "pick";
		if (step.value === "starting") await start();
	}

	function pickReader(name: string): void {
		terminal.value = name;
		step.value = cash.value > 0 ? "confirm" : "starting";
		if (step.value === "starting") void start();
	}

	/** The cashier confirmed the cash beside the card is in the drawer. */
	function confirmCash(): Promise<void> {
		step.value = "starting";
		return start(true);
	}

	async function start(cashConfirmed = false): Promise<void> {
		const record = pending.value;
		if (!record || busy.value || !terminal.value) return;
		busy.value = true;
		error.value = "";
		step.value = "starting";
		persist({ terminal: terminal.value, attempt: undefined });
		try {
			const result = await startCardPayment(record.doctype, record.invoice, terminal.value, cashConfirmed);
			persist({ attempt: result.attempt });
			step.value = "collecting";
			apply(result);
		} catch (err) {
			if (isNetworkError(err) || !(err as { excType?: string })?.excType) {
				// The server may have sent it to the reader: find that payment, never start another.
				step.value = "collecting";
				connectionLost.value = true;
				schedule();
			} else {
				step.value = cash.value > 0 && !cashConfirmed ? "confirm" : "idle";
				error.value = extractErrorMessage(err);
			}
		} finally {
			busy.value = false;
		}
	}

	async function poll(): Promise<void> {
		stopPolling();
		const record = pending.value;
		if (!record) return;
		try {
			if (!record.attempt) {
				const available = await availableTerminals(record.doctype, record.invoice);
				const known = available.active_attempt || available.posted_attempt;
				connectionLost.value = false;
				if (!known) {
					// Nothing reached the reader: the card was not charged.
					step.value = "idle";
					view.value = null;
					error.value = __("The card reader did not start. Nothing was charged; try again or choose another tender.");
					return;
				}
				persist({ attempt: known });
			}
			const result = await cardPaymentStatus(pending.value!.attempt!);
			connectionLost.value = false;
			apply(result);
		} catch (err) {
			// Keep watching through a dropped connection: the reader may still take the card.
			connectionLost.value = isNetworkError(err) || !(err as { excType?: string })?.excType;
			if (!connectionLost.value) error.value = extractErrorMessage(err);
			schedule();
		}
	}

	function apply(result: CardPaymentStatus): void {
		status.value = result;
		view.value = describeCardStatus(result);
		if (view.value.phase === "paid") {
			void finish();
			return;
		}
		if (view.value.phase === "review") {
			// Money may have moved: the sale is kept for a manager, never charged again from here.
			stopPolling();
			step.value = "done";
			persist({ attempt: undefined });
			clearPendingCard();
			return;
		}
		if (view.value.settled) {
			// Declined or cancelled: the reader is free and the draft is kept.
			stopPolling();
			step.value = "idle";
			persist({ attempt: undefined });
			return;
		}
		schedule();
	}

	async function cancel(): Promise<void> {
		const attempt = pending.value?.attempt;
		if (!attempt || busy.value) return;
		busy.value = true;
		try {
			apply(await cancelCardPayment(attempt));
		} catch (err) {
			connectionLost.value = isNetworkError(err);
			if (!connectionLost.value) error.value = extractErrorMessage(err);
			schedule();
		} finally {
			busy.value = false;
		}
	}

	/** Try the card again on the same draft (after a decline or cancel). */
	async function retry(): Promise<void> {
		if (!pending.value || pending.value.attempt) return;
		error.value = "";
		status.value = null;
		view.value = null;
		busy.value = false;
		await chooseReader().catch((err) => {
			error.value = isNetworkError(err)
				? __("No connection. Pay by Card needs the connection.")
				: extractErrorMessage(err);
		});
	}

	/** Leave the reader: the draft stays, and Pay (cash, check…) completes that same sale. */
	function otherTender(): void {
		if (pending.value?.attempt) return;
		const invoice = pending.value?.invoice;
		reset();
		open.value = false;
		if (invoice) showSuccess(__("Card not charged. {0} is kept; finish it with another tender.", [invoice]));
	}

	async function finish(): Promise<void> {
		const record = pending.value;
		stopPolling();
		step.value = "done";
		if (!record) return;
		clearPendingCard();
		pending.value = null;
		showSuccess(__("Card approved. Invoice {0} saved.", [record.invoice]));
		try {
			await till?.complete(record.invoice, !!record.withPrint);
		} catch (err) {
			showError(__("Sale saved. Receipt printing failed; use Reprint.") + " " + extractErrorMessage(err));
		}
	}

	/** After a reload: watch the payment this browser started, for this register only. */
	async function resume(profile: string): Promise<boolean> {
		const record = loadPendingCard();
		pending.value = record;
		if (!record || record.profile !== profile) return false;
		open.value = true;
		cash.value = Number(record.cash || 0);
		terminal.value = record.terminal || "";
		step.value = "collecting";
		connectionLost.value = false;
		await poll();
		return true;
	}

	function close(): void {
		// Never hide a payment the reader may still be taking.
		if (pending.value?.attempt && step.value !== "done") return;
		if (step.value === "done" || !pending.value?.attempt) reset();
		open.value = false;
	}

	return {
		config,
		configProfile,
		pending,
		step,
		open,
		status,
		view,
		error,
		connectionLost,
		busy,
		cash,
		devices,
		terminal,
		inProgress,
		isCardMode,
		bindTill,
		loadConfig,
		begin,
		pickReader,
		confirmCash,
		start,
		poll,
		cancel,
		retry,
		otherTender,
		resume,
		close,
		reset,
	};
});
