/**
 * @vitest-environment jsdom
 *
 * Pay by Card on the register's card reader (Mule City, MuleCity-bjjv.3).
 *
 * User stories, with the site mocked (no Stripe, no network):
 * - Pay by Card is offered only when a reader is set up, online, for a plain
 *   sale: not for a refund, On Account, a mix order, points or a check beside it;
 * - the cashier sees the reader's prompts, a decline or cancel says why, and
 *   they can try the card again or choose another tender (the draft stays);
 * - a cash + card split asks the cashier to confirm the cash first;
 * - on approval the till loads the invoice the payments app submitted, clears
 *   the cart and prints, and never calls create_invoice (no double sale);
 * - a reload resumes the payment in progress instead of charging again, and
 *   polling keeps going through a dropped connection;
 * - Close Shift waits for an unfinished card payment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { calls, answers, online } = vi.hoisted(() => ({
	calls: [] as { method: string; args: Record<string, unknown> }[],
	answers: {} as Record<string, unknown[]>,
	online: { value: true },
}));

vi.mock("@/services/api", () => ({
	call: vi.fn(async (method: string, args: Record<string, unknown>) => {
		calls.push({ method, args });
		const queue = answers[method] || [];
		const next = queue.length > 1 ? queue.shift() : queue[0];
		if (next instanceof Error) throw next;
		if (next === undefined) throw new Error(`unexpected call ${method}`);
		return typeof next === "function" ? (next as (a: unknown) => unknown)(args) : next;
	}),
	showSuccess: vi.fn(),
	showError: vi.fn(),
	isNetworkError: (error: unknown) => (error as Error)?.message === "__offline__",
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));
vi.mock("@/utils", () => ({
	isOnline: () => online.value,
	extractErrorMessage: (error: unknown) => (error as Error)?.message || String(error),
}));
vi.mock("@/lib/translate", () => {
	const t = (text: string, args: unknown[] = []) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
	return { default: t, __: t };
});

import {
	CARD_OFF,
	cardPayBlockReason,
	describeCardStatus,
	reasonText,
	type CardPayContext,
	type CardPaymentStatus,
} from "@/services/cardTerminal";
import { loadPendingCard } from "@/utils/cardPending";
import { useCardPaymentStore } from "@/stores/cardPaymentStore";

const TILL = "xpos.api.card_terminal";
const SERVICE = "payments.transactions.service";
const READY = {
	enabled: true,
	card_modes: ["Stripe Card"],
	mode_of_payment: "Stripe Card",
	terminals: [{ name: "PT-1", label: "Counter reader" }],
};

function status(fields: Partial<CardPaymentStatus>): CardPaymentStatus {
	return {
		attempt: "pta-1",
		collection_state: "PENDING",
		accounting_state: "Not ready",
		received: false,
		paid: false,
		amount: "20.74",
		currency: "USD",
		reason: null,
		retryable: false,
		...fields,
	};
}

function context(fields: Partial<CardPayContext> = {}): CardPayContext {
	return {
		config: READY,
		online: true,
		electron: false,
		isReturn: false,
		onAccount: false,
		hasOrderLines: false,
		billsAnOrder: false,
		redeemsPoints: false,
		writeOff: 0,
		total: 20.74,
		cash: 0,
		nonCashLegs: [],
		foreignTender: false,
		...fields,
	};
}

const DRAFT = { name: "ACC-SINV-1", doctype: "Sales Invoice", modified: "2026-11-03 10:00:00", grand_total: 20.74, card_amount: 20.74 };
const FREE = { devices: [{ name: "PT-1", label: "Counter reader", busy: false }], active_attempt: null, posted_attempt: null };

function answer(method: string, ...values: unknown[]) {
	answers[method] = values;
}

function till() {
	return { adoptDraft: vi.fn(), complete: vi.fn(async () => {}) };
}

beforeEach(() => {
	setActivePinia(createPinia());
	calls.length = 0;
	for (const key of Object.keys(answers)) delete answers[key];
	online.value = true;
	window.localStorage.clear();
	vi.useRealTimers();
});

describe("when Pay by Card is offered", () => {
	it("is offered for a plain sale with a reader set up", () => {
		expect(cardPayBlockReason(context())).toBeNull();
	});

	it("is off without a reader, offline, or on the desktop app", () => {
		expect(cardPayBlockReason(context({ config: CARD_OFF }))).toMatch(/No card reader/);
		expect(cardPayBlockReason(context({ online: false }))).toMatch(/needs the connection/);
		expect(cardPayBlockReason(context({ electron: true }))).toMatch(/browser/);
	});

	it("is not for refunds, On Account, mix orders or points", () => {
		expect(cardPayBlockReason(context({ isReturn: true }))).toMatch(/Return/);
		expect(cardPayBlockReason(context({ onAccount: true }))).toMatch(/On Account/);
		expect(cardPayBlockReason(context({ hasOrderLines: true }))).toMatch(/mix orders/);
		expect(cardPayBlockReason(context({ billsAnOrder: true }))).toMatch(/mix orders/);
		expect(cardPayBlockReason(context({ redeemsPoints: true }))).toMatch(/points/);
		expect(cardPayBlockReason(context({ writeOff: 1 }))).toMatch(/write-off/);
	});

	it("takes only cash beside the card, and something must be left to charge", () => {
		expect(cardPayBlockReason(context({ cash: 5 }))).toBeNull();
		expect(cardPayBlockReason(context({ nonCashLegs: ["Check"] }))).toMatch(/Check/);
		expect(cardPayBlockReason(context({ foreignTender: true }))).toMatch(/Foreign/);
		expect(cardPayBlockReason(context({ cash: 20.74 }))).toMatch(/cash covers/);
	});
});

describe("what the cashier sees", () => {
	it("shows the reader's prompts while collecting, with Cancel", () => {
		expect(describeCardStatus(status({ collection_state: "Dispatching" })).phase).toBe("sending");
		const waiting = describeCardStatus(status({ collection_state: "PENDING" }));
		expect(waiting.phase).toBe("waiting");
		expect(waiting.message).toMatch(/tap, insert or swipe/);
		expect(waiting.canCancel).toBe(true);
		expect(describeCardStatus(status({ collection_state: "IN_PROGRESS" })).phase).toBe("processing");
	});

	it("a decline says why and lets the cashier try again", () => {
		const view = describeCardStatus(status({ collection_state: "Failed", reason: "card_declined", retryable: true }));
		expect(view).toMatchObject({ phase: "declined", settled: true, canRetry: true, moneyTaken: false });
		expect(view.reason).toBe("The card was declined.");
	});

	it("a reader decline or customer cancel (fork: Failed + Stripe code, retryable) offers a retry with a friendly reason", () => {
		const cancelled = describeCardStatus(status({ collection_state: "Failed", reason: "customer_canceled", retryable: true }));
		expect(cancelled).toMatchObject({ phase: "declined", canRetry: true, settled: true });
		expect(cancelled.reason).toBe("The customer cancelled on the reader.");
		expect(reasonText(status({ reason: "insufficient_funds" }))).toMatch(/insufficient funds/);
		expect(reasonText(status({ reason: "do_not_honor" }))).toMatch(/another card/);
		expect(describeCardStatus(status({ collection_state: "Failed", reason: "card_declined", retryable: false })).canRetry).toBe(false);
	});

	it("a richer reason from a later payments fork is shown as sent", () => {
		expect(reasonText(status({ reason: "card_declined", reason_message: "Do not honor" }))).toBe("Do not honor");
		expect(reasonText(status({ decline_reason: { code: "insufficient_funds" } } as never))).toMatch(/insufficient funds/);
		expect(reasonText(status({ reason: "SOMETHING_NEW" }))).toBe("SOMETHING_NEW");
		expect(reasonText(status({}))).toBe("");
	});

	it("approved but not yet recorded, or in review, is never offered again", () => {
		expect(describeCardStatus(status({ collection_state: "Captured", received: true }))).toMatchObject({
			phase: "posting",
			moneyTaken: true,
			canRetry: false,
		});
		expect(describeCardStatus(status({ collection_state: "Review", accounting_state: "Review" }))).toMatchObject({
			phase: "review",
			moneyTaken: true,
			canRetry: false,
		});
		expect(describeCardStatus(status({ collection_state: "Unknown" }))).toMatchObject({ phase: "checking", canRetry: false });
	});
});

describe("Pay by Card, end to end against a mocked site", () => {
	it("saves the draft, starts the reader, and on approval completes that invoice without create_invoice", async () => {
		const store = useCardPaymentStore();
		const t = till();
		store.bindTill(t);
		answer(`${TILL}.get_card_terminal_config`, READY);
		await store.loadConfig("Mule City Retail");
		expect(store.isCardMode("Stripe Card")).toBe(true);

		answer(`${TILL}.save_card_draft`, DRAFT);
		answer(`${SERVICE}.get_available_terminals`, FREE);
		answer(`${SERVICE}.start_terminal_payment`, status({ collection_state: "PENDING" }));
		await store.begin({
			profile: "Mule City Retail",
			invoiceData: { local_id: "inv_1", customer: "C1", payments: [] },
			cash: 0,
			withPrint: true,
		});
		expect(t.adoptDraft).toHaveBeenCalledWith("ACC-SINV-1", DRAFT.modified);
		expect(store.view?.phase).toBe("waiting");
		expect(loadPendingCard()).toMatchObject({ invoice: "ACC-SINV-1", attempt: "pta-1", terminal: "PT-1" });
		const saved = JSON.parse(String(calls.find((c) => c.method === `${TILL}.save_card_draft`)?.args.data));
		expect(saved.card_mode).toBe("Stripe Card");

		answer(`${SERVICE}.get_terminal_payment_status`, status({ collection_state: "Captured", received: true, paid: true, accounting_state: "Posted" }));
		await store.poll();
		expect(t.complete).toHaveBeenCalledWith("ACC-SINV-1", true);
		expect(loadPendingCard()).toBeNull();
		expect(calls.some((c) => c.method.endsWith("create_invoice"))).toBe(false);
		expect(calls.filter((c) => c.method === `${SERVICE}.start_terminal_payment`)).toHaveLength(1);
		store.reset();
	});

	it("a cash + card split confirms the cash before the reader starts", async () => {
		const store = useCardPaymentStore();
		store.bindTill(till());
		answer(`${TILL}.save_card_draft`, { ...DRAFT, card_amount: 15.74 });
		answer(`${SERVICE}.get_available_terminals`, FREE);
		answer(`${SERVICE}.start_terminal_payment`, status({ amount: "15.74" }));
		await store.begin({ profile: "P", invoiceData: { local_id: "inv_2" }, cash: 5, withPrint: false });
		expect(store.step).toBe("confirm");
		expect(calls.some((c) => c.method === `${SERVICE}.start_terminal_payment`)).toBe(false);

		await store.confirmCash();
		const start = calls.find((c) => c.method === `${SERVICE}.start_terminal_payment`);
		expect(start?.args).toMatchObject({ reference_docname: "ACC-SINV-1", terminal: "PT-1", confirm_cash: 1 });
		store.reset();
	});

	it("after a cancel the cashier can try the card again or choose another tender", async () => {
		const store = useCardPaymentStore();
		store.bindTill(till());
		answer(`${TILL}.save_card_draft`, DRAFT);
		answer(`${SERVICE}.get_available_terminals`, FREE);
		answer(`${SERVICE}.start_terminal_payment`, status({ collection_state: "PENDING" }));
		await store.begin({ profile: "P", invoiceData: {}, cash: 0, withPrint: false });

		answer(`${SERVICE}.cancel_terminal_payment`, status({ collection_state: "CANCELED", retryable: true }));
		await store.cancel();
		expect(store.view?.phase).toBe("cancelled");
		expect(store.step).toBe("idle");
		expect(store.pending?.attempt).toBeUndefined();

		answer(`${SERVICE}.start_terminal_payment`, status({ attempt: "pta-2", collection_state: "PENDING" }));
		await store.retry();
		expect(store.pending?.attempt).toBe("pta-2");
		answer(`${SERVICE}.cancel_terminal_payment`, status({ attempt: "pta-2", collection_state: "CANCELED", retryable: true }));
		await store.cancel();

		store.otherTender();
		expect(store.pending).toBeNull();
		expect(store.open).toBe(false);
		expect(loadPendingCard()).toBeNull();
	});

	it("cannot be closed while the reader may still take the card", async () => {
		const store = useCardPaymentStore();
		store.bindTill(till());
		answer(`${TILL}.save_card_draft`, DRAFT);
		answer(`${SERVICE}.get_available_terminals`, FREE);
		answer(`${SERVICE}.start_terminal_payment`, status({ collection_state: "PENDING" }));
		await store.begin({ profile: "P", invoiceData: {}, cash: 0, withPrint: false });
		store.close();
		expect(store.open).toBe(true);
		store.reset();
	});

	it("a reload resumes the payment in progress instead of charging again", async () => {
		window.localStorage.setItem(
			"xpos:card-payment",
			JSON.stringify({ profile: "P", doctype: "Sales Invoice", invoice: "ACC-SINV-1", attempt: "pta-1", startedAt: "x", withPrint: true }),
		);
		const store = useCardPaymentStore();
		const t = till();
		store.bindTill(t);
		expect(await store.resume("Other profile")).toBe(false);

		answer(`${SERVICE}.get_terminal_payment_status`, status({ paid: true, received: true, accounting_state: "Posted", collection_state: "Captured" }));
		expect(await store.resume("P")).toBe(true);
		expect(t.complete).toHaveBeenCalledWith("ACC-SINV-1", true);
		expect(calls.some((c) => c.method === `${SERVICE}.start_terminal_payment`)).toBe(false);
		expect(calls.some((c) => c.method === `${TILL}.save_card_draft`)).toBe(false);
	});

	it("a lost start response finds the payment the server started, never starting another", async () => {
		const store = useCardPaymentStore();
		store.bindTill(till());
		answer(`${TILL}.save_card_draft`, DRAFT);
		answer(`${SERVICE}.get_available_terminals`, FREE, { ...FREE, active_attempt: "pta-9" });
		answer(`${SERVICE}.start_terminal_payment`, new Error("__offline__"));
		vi.useFakeTimers();
		await store.begin({ profile: "P", invoiceData: {}, cash: 0, withPrint: false });
		expect(store.connectionLost).toBe(true);
		expect(store.step).toBe("collecting");

		answer(`${SERVICE}.get_terminal_payment_status`, status({ attempt: "pta-9", collection_state: "PENDING" }));
		await vi.advanceTimersByTimeAsync(2600);
		expect(store.pending?.attempt).toBe("pta-9");
		expect(store.view?.phase).toBe("waiting");
		expect(calls.filter((c) => c.method === `${SERVICE}.start_terminal_payment`)).toHaveLength(1);
		store.reset();
	});

	it("keeps polling through a dropped connection", async () => {
		window.localStorage.setItem(
			"xpos:card-payment",
			JSON.stringify({ profile: "P", doctype: "Sales Invoice", invoice: "ACC-SINV-1", attempt: "pta-1", startedAt: "x" }),
		);
		const store = useCardPaymentStore();
		const t = till();
		store.bindTill(t);
		vi.useFakeTimers();
		answer(`${SERVICE}.get_terminal_payment_status`, new Error("__offline__"));
		await store.resume("P");
		expect(store.connectionLost).toBe(true);
		expect(loadPendingCard()?.attempt).toBe("pta-1");

		answer(`${SERVICE}.get_terminal_payment_status`, status({ paid: true, received: true, accounting_state: "Posted", collection_state: "Captured" }));
		await vi.advanceTimersByTimeAsync(2600);
		expect(store.connectionLost).toBe(false);
		expect(t.complete).toHaveBeenCalledWith("ACC-SINV-1", false);
	});

	it("a sale the payments app already posted (reload during save) is completed, not charged", async () => {
		const store = useCardPaymentStore();
		const t = till();
		store.bindTill(t);
		answer(`${TILL}.save_card_draft`, { ...DRAFT, submitted: true });
		await store.begin({ profile: "P", invoiceData: { local_id: "inv_1" }, cash: 0, withPrint: true });
		expect(t.complete).toHaveBeenCalledWith("ACC-SINV-1", true);
		expect(calls.some((c) => c.method.startsWith(SERVICE))).toBe(false);
	});

	it("an offline boot keeps the reader's mode off the tender buttons", async () => {
		const store = useCardPaymentStore();
		answer(`${TILL}.get_card_terminal_config`, READY);
		await store.loadConfig("P");
		setActivePinia(createPinia());
		const offline = useCardPaymentStore();
		answer(`${TILL}.get_card_terminal_config`, new Error("__offline__"));
		await offline.loadConfig("P");
		expect(offline.isCardMode("Stripe Card")).toBe(true);
		expect(offline.config.enabled).toBe(false);
	});
});
