/**
 * Pay by Card on a card reader (MuleCity-bjjv.3).
 *
 * The till saves the cart as a draft (xpos.api.card_terminal.save_card_draft),
 * then the payments app's terminal framework collects the card balance on a
 * paired reader and submits that same draft once the processor confirms the
 * capture. The till only watches: it never submits a card sale, never queues
 * one for create_invoice, and never queues one offline.
 *
 * This module is the part without Vue: the server calls, what each payment
 * status means for the cashier, whether Pay by Card is allowed for a cart,
 * and the in-progress payment kept in this browser so a reload resumes it
 * instead of charging again.
 */
import { call } from "@/services/api";
import { __ } from "@/lib/translate";

/**
 * The payments app's terminal service module (its whitelisted start/status/cancel).
 * The server names it in the card config (`service`: the site's
 * xpos_payment_terminal_app, e.g. pay_ng). A call made before the config arrives
 * (a reload resuming a payment) asks the server for it first; no app is assumed.
 */
let TERMINAL: string | null = null;
const TILL = "xpos.api.card_terminal";

export interface CardTerminalConfig {
	enabled: boolean;
	/** Modes of Payment only the reader fills in: never offered as ordinary tender buttons. */
	card_modes: string[];
	mode_of_payment: string | null;
	terminals: { name: string; label: string; mode_of_payment?: string | null }[];
	/** The payments app's terminal service module, e.g. "pay_ng.transactions.service". */
	service?: string | null;
}

export const CARD_OFF: CardTerminalConfig = {
	enabled: false,
	card_modes: [],
	mode_of_payment: null,
	terminals: [],
};

export interface CardDraft {
	name: string;
	doctype: string;
	modified?: string;
	docstatus?: number;
	grand_total: number;
	card_amount?: number;
	mode_of_payment?: string;
	/** The payments app already posted this sale (a reload or lost response). */
	submitted?: boolean;
	/** A card payment is still unresolved on this draft; it was returned untouched. */
	active?: boolean;
}

/** payments.transactions.service status (mule-v16-mc1), plus fields a later fork may add. */
export interface CardPaymentStatus {
	attempt: string;
	collection_state: string;
	accounting_state: string;
	received: boolean;
	paid: boolean;
	amount: string;
	currency: string;
	reason?: string | null;
	retryable: boolean;
	payment_ids?: string[];
	[key: string]: unknown;
}

export interface AvailableTerminals {
	devices: { name: string; label: string; busy: boolean; mode_of_payment?: string | null }[];
	active_attempt: string | null;
	posted_attempt: string | null;
}

export type { PendingCardPayment } from "@/utils/cardPending";

export async function fetchCardTerminalConfig(posProfile: string): Promise<CardTerminalConfig> {
	const config = await call<CardTerminalConfig>(`${TILL}.get_card_terminal_config`, { pos_profile: posProfile });
	if (config?.service) TERMINAL = config.service;
	return config;
}

/** The terminal service module; asks the server when no config has named it yet. */
async function terminalService(): Promise<string> {
	if (!TERMINAL) {
		const service = await call<string | null>(`${TILL}.get_card_terminal_service`);
		// A refusal (excType), not a dropped connection: the cashier sees it, nothing retries.
		if (!service) throw Object.assign(new Error(__("This site has no card reader app.")), { excType: "ValidationError" });
		TERMINAL = service;
	}
	return TERMINAL;
}

/** For tests: forget the module a config named. */
export function resetCardTerminalService(): void {
	TERMINAL = null;
}

export function saveCardDraft(data: Record<string, unknown>): Promise<CardDraft> {
	return call<CardDraft>(`${TILL}.save_card_draft`, { data: JSON.stringify(data) });
}

export async function availableTerminals(doctype: string, name: string): Promise<AvailableTerminals> {
	return call<AvailableTerminals>(`${await terminalService()}.get_available_terminals`, {
		reference_doctype: doctype,
		reference_docname: name,
	});
}

export async function startCardPayment(
	doctype: string,
	name: string,
	terminal: string,
	confirmCash: boolean,
): Promise<CardPaymentStatus> {
	return call<CardPaymentStatus>(`${await terminalService()}.start_terminal_payment`, {
		reference_doctype: doctype,
		reference_docname: name,
		terminal,
		confirm_cash: confirmCash ? 1 : 0,
	});
}

export async function cardPaymentStatus(attempt: string): Promise<CardPaymentStatus> {
	return call<CardPaymentStatus>(`${await terminalService()}.get_terminal_payment_status`, { attempt });
}

export async function cancelCardPayment(attempt: string): Promise<CardPaymentStatus> {
	return call<CardPaymentStatus>(`${await terminalService()}.cancel_terminal_payment`, { attempt });
}

// ------------------------------------------------------------------ eligibility

export interface CardPayContext {
	config: CardTerminalConfig;
	online: boolean;
	electron: boolean;
	isReturn: boolean;
	onAccount: boolean;
	hasOrderLines: boolean;
	/** The cart holds a "Pay balance" line (MuleCity-biez). */
	paysBalance?: boolean;
	billsAnOrder: boolean;
	redeemsPoints: boolean;
	writeOff: number;
	/** The cart total and the cash already tendered beside the card. */
	total: number;
	cash: number;
	/** Tender legs that are not cash (a check, the Heartland card): not allowed beside the reader. */
	nonCashLegs: string[];
	foreignTender: boolean;
}

/** Why Pay by Card is not offered for this cart right now, or null when it is. */
export function cardPayBlockReason(ctx: CardPayContext): string | null {
	if (!ctx.config.enabled) return __("No card reader is set up for this register.");
	if (ctx.electron) return __("Pay by Card runs in the browser till only.");
	if (!ctx.online) return __("Pay by Card needs the connection. Take another tender, or wait.");
	if (ctx.isReturn) return __("Refunds go back through Return, not the card reader.");
	if (ctx.onAccount) return __("A sale charged On Account is not paid by card.");
	if (ctx.hasOrderLines || ctx.billsAnOrder)
		return __("Custom mix orders are not paid on the card reader yet.");
	if (ctx.paysBalance)
		return __("A balance payment is not taken on the card reader yet; use Credit Card, cash or check.");
	if (ctx.redeemsPoints) return __("Loyalty points and the card reader cannot be combined.");
	if (ctx.writeOff > 0) return __("A write-off and the card reader cannot be combined.");
	if (ctx.foreignTender) return __("Foreign cash cannot be combined with the card reader.");
	if (ctx.nonCashLegs.length)
		return __("Only cash can be taken beside the card reader; remove {0}.", [ctx.nonCashLegs.join(", ")]);
	if (roundCents(ctx.total - ctx.cash) <= 0) return __("The cash covers this sale; finish it with Pay.");
	return null;
}

export function roundCents(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------------ status

export type CardPhase =
	| "sending"
	| "waiting"
	| "processing"
	| "cancelling"
	| "posting"
	| "paid"
	| "declined"
	| "cancelled"
	| "review"
	| "checking";

export interface CardView {
	phase: CardPhase;
	message: string;
	/** Why the card was not charged, when the processor or reader says. */
	reason: string;
	/** Nothing more will change without the cashier: stop polling. */
	settled: boolean;
	canCancel: boolean;
	/** The card was not charged: try the card again or choose another tender. */
	canRetry: boolean;
	/** The money was taken (or may have been): never charge this sale again. */
	moneyTaken: boolean;
}

const REASONS: Record<string, string> = {
	card_declined: "The card was declined.",
	generic_decline: "The card was declined.",
	do_not_honor: "The card was declined by the bank. Ask for another card.",
	call_issuer: "The card was declined. The customer should call their bank.",
	lost_card: "The card was declined. Ask for another card.",
	stolen_card: "The card was declined. Ask for another card.",
	pickup_card: "The card was declined. Ask for another card.",
	fraudulent: "The card was declined. Ask for another card.",
	card_not_supported: "This card type is not accepted. Ask for another card.",
	currency_not_supported: "This card cannot pay in dollars. Ask for another card.",
	card_velocity_exceeded: "The card was declined: over its limit.",
	withdrawal_count_limit_exceeded: "The card was declined: over its limit.",
	incorrect_pin: "Wrong PIN. Try the card again.",
	invalid_pin: "Wrong PIN. Try the card again.",
	pin_try_exceeded: "Too many PIN tries. Ask for another card.",
	offline_pin_required: "The card needs its PIN. Try the card again and enter the PIN.",
	online_or_offline_pin_required: "The card needs its PIN. Try the card again and enter the PIN.",
	transaction_not_allowed: "The bank does not allow this payment. Ask for another card.",
	try_again_later: "The bank did not answer. Try the card again.",
	authentication_required: "The bank wants more checks. Insert the card and enter the PIN.",
	customer_cancelled: "The customer cancelled on the reader.",
	insufficient_funds: "The card was declined: insufficient funds.",
	expired_card: "The card has expired.",
	incorrect_cvc: "The card was declined: incorrect security code.",
	processing_error: "The card could not be processed.",
	terminal_reader_busy: "The card reader is busy with another payment.",
	terminal_reader_offline: "The card reader is offline. Check its power and network.",
	terminal_reader_timeout: "The card reader did not answer in time.",
	customer_canceled: "The customer cancelled on the reader.",
	canceled_by_customer: "The customer cancelled on the reader.",
	reader_canceled: "The payment was cancelled on the reader.",
	PROVIDER_UNAVAILABLE: "Stripe could not be reached; still checking.",
	PROVIDER_REJECTED: "Stripe refused the payment.",
	OUTCOME_UNKNOWN: "The outcome is not known yet; still checking with Stripe.",
	REMOTE_OPERATION_NOT_FOUND: "Stripe has no record of this payment yet; still checking.",
};

/**
 * Why the card was not charged. A later payments fork may send a readable
 * message beside the code (MuleCity-bjjv.2); any of these keys is used when
 * present, else the code is translated, else shown as it is.
 */
export function reasonText(status: Partial<CardPaymentStatus> | null | undefined): string {
	if (!status) return "";
	for (const key of ["reason_message", "decline_message", "failure_message", "message"]) {
		const value = status[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	for (const key of ["decline_reason", "decline_code", "failure_code", "reason"]) {
		const value = status[key];
		if (typeof value === "string" && value.trim()) {
			const known = REASONS[value.trim()];
			return known ? __(known) : value.trim();
		}
		if (value && typeof value === "object") {
			const nested = value as { message?: unknown; code?: unknown };
			if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
			if (typeof nested.code === "string" && nested.code.trim())
				return REASONS[nested.code] ? __(REASONS[nested.code]) : nested.code;
		}
	}
	return "";
}

/** What the cashier sees for a payment status, and what they may do next. */
export function describeCardStatus(status: CardPaymentStatus): CardView {
	const reason = reasonText(status);
	const view = (phase: CardPhase, message: string, extra: Partial<CardView> = {}): CardView => ({
		phase,
		message,
		reason,
		settled: false,
		canCancel: false,
		canRetry: false,
		moneyTaken: false,
		...extra,
	});
	if (status.paid) return view("paid", __("Card approved. Sale complete."), { settled: true, moneyTaken: true });
	if (status.accounting_state === "Review" || status.collection_state === "Review")
		return view(
			"review",
			__("This payment needs a manager. Do not charge the card again; the sale is kept for review."),
			{ settled: true, moneyTaken: true },
		);
	if (status.received)
		return view("posting", __("Card approved. Recording the sale…"), { moneyTaken: true });
	switch (status.collection_state) {
		case "Created":
		case "Dispatching":
			return view("sending", __("Sending the amount to the card reader…"));
		case "PENDING":
			return view("waiting", __("Ask the customer to tap, insert or swipe their card on the reader."), {
				canCancel: true,
			});
		case "IN_PROGRESS":
			return view("processing", __("Card read. Waiting for the bank…"), { canCancel: true });
		case "CANCEL_REQUESTED":
			return view("cancelling", __("Cancelling on the reader…"));
		case "CANCELED":
			return view("cancelled", __("Card payment cancelled. The card was not charged."), {
				settled: true,
				canRetry: status.retryable,
			});
		case "Failed":
			return view("declined", __("The card was not charged."), {
				settled: true,
				canRetry: status.retryable,
			});
		default:
			// "Unknown" and anything new: the money may have moved; keep checking, never retry.
			return view("checking", __("Checking the payment with Stripe…"), { canCancel: true });
	}
}

// ------------------------------------------------------------------ this browser's pending payment

export { clearPendingCard, loadPendingCard, savePendingCard } from "@/utils/cardPending";
