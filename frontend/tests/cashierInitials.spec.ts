/**
 * @vitest-environment jsdom
 *
 * Bill (2026-09-29, MuleCity-fb00.2): Mule City signs the register in as one
 * shared "POS" user, and several cashiers use it. On every sale, returns too,
 * the cashier types their initials at Pay. Honor system (no PIN), but they must
 * be on the POS Profile's cashier list, and they go on the invoice as
 * `pos_cashier` so we know who rang each sale. The box starts empty on every
 * sale; a register that does not ask for initials pays exactly as before.
 *
 * Bill (2026-09-30, MuleCity-1p4i): owners and front desk also sell under their
 * own logins. Only a login marked as the register's shared login is asked; a
 * named login pays with no box, and the server records their name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import type { InvoiceData, XposCashier } from "@/types/pos.types";
import { initialsOf, tillInitials } from "@/utils/cashierInitials";

const mocks = vi.hoisted(() => ({
	online: true,
	submitDurableInvoice: vi.fn(async (_data: unknown, _receipt: unknown, send: () => Promise<unknown>) =>
		send(),
	),
	completeOfflineSale: vi.fn(async () => true),
	call: vi.fn(async () => ({ name: "ACC-SINV-2026-00001" })),
}));

vi.mock("@/services/api", () => ({
	call: mocks.call,
	showSuccess: vi.fn(),
	showError: vi.fn(),
	showInfo: vi.fn(),
	isNetworkError: vi.fn(() => false),
	default: { call: mocks.call },
}));
vi.mock("@/services/invoiceSubmission", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/invoiceSubmission")>()),
	submitDurableInvoice: mocks.submitDurableInvoice,
}));
vi.mock("@/composables/useOfflineSale", () => ({
	useOfflineSale: () => ({ completeOfflineSale: mocks.completeOfflineSale }),
}));
vi.mock("@/composables/usePrintInvoice", () => ({
	usePrintInvoice: () => ({ printInvoice: vi.fn(), printInvoiceLocal: vi.fn() }),
}));
vi.mock("@/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils")>()),
	isOnline: () => mocks.online,
}));

import PaymentDialog from "@/components/dialogs/PaymentDialog.vue";
import CashierInitialsField from "@/components/dialogs/CashierInitialsField.vue";
import { usePosStore } from "@/stores/posStore";
import { useCartStore } from "@/stores/cartStore";
import { useAuthStore } from "@/stores/authStore";
import {
	applyCashier,
	cashierInitialsOk,
	initialsRequiredFor,
	matchCashier,
	normalizeInitials,
} from "@/utils/cashierInitials";

const CASHIERS: XposCashier[] = [
	{ initials: "LE", cashier_name: "Lee Evans" },
	{ initials: " bc", cashier_name: "Bill Cromie" },
];

describe("cashier initials rules", () => {
	it("compares initials trimmed and uppercase, against rows typed either way", () => {
		expect(normalizeInitials(" le ")).toBe("LE");
		expect(matchCashier(CASHIERS, "le")?.cashier_name).toBe("Lee Evans");
		expect(matchCashier(CASHIERS, "BC ")?.cashier_name).toBe("Bill Cromie");
		expect(matchCashier(CASHIERS, "ZZ")).toBeUndefined();
		expect(matchCashier(CASHIERS, "  ")).toBeUndefined();
	});

	it("lets Pay complete only with listed initials, and always when not required", () => {
		expect(cashierInitialsOk(true, CASHIERS, "le")).toBe(true);
		expect(cashierInitialsOk(true, CASHIERS, "")).toBe(false);
		expect(cashierInitialsOk(true, CASHIERS, "zz")).toBe(false);
		expect(cashierInitialsOk(false, CASHIERS, "")).toBe(true);
	});

	it("puts the initials on the invoice payload only when the profile asks for them", () => {
		const data = () => ({ pos_profile: "Counter", customer: "C", items: [] }) as InvoiceData;
		expect(applyCashier(data(), true, " le ").pos_cashier).toBe("LE");
		expect(applyCashier(data(), false, "le")).not.toHaveProperty("pos_cashier");
	});
});

// The register's shared login, and an owner who sells under his own login.
const SHARED_LOGIN = "pos@example.com";
const NAMED_LOGIN = "ben@example.com";
const REGISTER_USERS = [
	{ user: SHARED_LOGIN, xpos_shared_login: 1 },
	{ user: NAMED_LOGIN, xpos_shared_login: 0 },
];

describe("who is asked for initials", () => {
	const profile = (require: number) =>
		({ name: "Counter", xpos_require_cashier_initials: require, applicable_for_users: REGISTER_USERS }) as never;

	it("asks only the shared login, and only when the profile requires initials", () => {
		expect(initialsRequiredFor(profile(1), [SHARED_LOGIN])).toBe(true);
		expect(initialsRequiredFor(profile(1), [NAMED_LOGIN])).toBe(false);
		expect(initialsRequiredFor(profile(0), [SHARED_LOGIN])).toBe(false);
	});

	it("does not ask a user who has no row, or when there is no profile", () => {
		expect(initialsRequiredFor(profile(1), ["Guest", ""])).toBe(false);
		expect(initialsRequiredFor(null, [SHARED_LOGIN])).toBe(false);
	});
});

describe("the Cashier initials box", () => {
	it("names the matched cashier as they type, and says when initials are not on the list", async () => {
		const box = mount(CashierInitialsField, { props: { cashiers: CASHIERS, modelValue: "" } });
		expect(box.text()).toContain("Required");

		await box.setProps({ modelValue: "le" });
		expect(box.find('[data-testid="cashier-initials-match"]').text()).toBe("Lee Evans");

		await box.setProps({ modelValue: "zz" });
		expect(box.find('[data-testid="cashier-initials-unknown"]').text()).toContain("ZZ");
	});

	it("hands Enter on to the amount", async () => {
		const box = mount(CashierInitialsField, { props: { cashiers: CASHIERS, modelValue: "LE" } });
		await box.find("input").trigger("keydown", { key: "Enter" });
		expect(box.emitted("done")).toHaveLength(1);
	});
});

describe("Pay with cashier initials", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		mocks.online = true;
	});

	function ringUp(requireInitials: boolean, user = SHARED_LOGIN) {
		useAuthStore().user = { user, user_email: user, user_fullname: user } as never;
		const pos = usePosStore();
		pos.posProfile = {
			name: "Mule City Counter",
			payments: [{ mode_of_payment: "Cash", default: 1 }],
			xpos_require_cashier_initials: requireInitials ? 1 : 0,
			xpos_cashiers: CASHIERS,
			applicable_for_users: REGISTER_USERS,
		} as never;
		const cart = useCartStore();
		cart.customer = { name: "Walk-In Customer" } as never;
		cart.items.push({
			item_code: "LAYER-PELLET",
			item_name: "Layer Pellet",
			qty: 1,
			rate: 20,
			uom: "Nos",
			discount_percentage: 0,
			discount_amount: 0,
		} as never);
		cart.showPaymentDialog = true;
		vi.spyOn(cart, "revalidateStock").mockResolvedValue({ valid: true, messages: [] });
		return cart;
	}

	// The amount box, stubbed, still takes focus like the real one.
	const NumberInput = defineComponent({
		setup(_props, { expose }) {
			expose({ focus: () => undefined, setValue: () => undefined });
			return () => h("input", { "data-testid": "amount" });
		},
	});

	async function openPay() {
		const wrapper = shallowMount(PaymentDialog, {
			attachTo: document.body,
			global: {
				renderStubDefaultSlot: true,
				stubs: { NumberInput, CashierInitialsField: false, Input: false },
			},
		});
		await flushPromises();
		return wrapper;
	}

	const saveButton = (wrapper: Awaited<ReturnType<typeof openPay>>) =>
		wrapper.find('[data-testid="save-payment"]');

	async function type(wrapper: Awaited<ReturnType<typeof openPay>>, initials: string) {
		await wrapper.find('[data-testid="cashier-initials-input"]').setValue(initials);
		await flushPromises();
	}

	async function saveOnly(wrapper: Awaited<ReturnType<typeof openPay>>) {
		await saveButton(wrapper).trigger("click");
		await flushPromises();
	}

	function sentPayload(): InvoiceData {
		const [, args] = mocks.call.mock.calls.find(
			([method]) => method === "xpos.api.invoices.create_invoice",
		)!;
		return JSON.parse((args as { data: string }).data);
	}

	it("asks for initials, blocks payment until they are on the list, and sends them", async () => {
		ringUp(true);
		const wrapper = await openPay();

		expect(wrapper.findComponent(CashierInitialsField).exists()).toBe(true);
		expect(document.activeElement?.getAttribute("data-testid")).toBe("cashier-initials-input");
		expect(saveButton(wrapper).attributes("disabled")).toBe("true");

		await type(wrapper, "zz");
		expect(saveButton(wrapper).attributes("disabled")).toBe("true");

		await type(wrapper, " le");
		expect(saveButton(wrapper).attributes("disabled")).toBe("false");

		await saveOnly(wrapper);
		expect(sentPayload().pos_cashier).toBe("LE");
		wrapper.unmount();
	});

	it("starts empty on the next sale", async () => {
		ringUp(true);
		const first = await openPay();
		await type(first, "LE");
		first.unmount();

		ringUp(true);
		const next = await openPay();
		expect(next.findComponent(CashierInitialsField).props("modelValue")).toBe("");
		expect(saveButton(next).attributes("disabled")).toBe("true");
		next.unmount();
	});

	it("keeps the initials on a sale queued while offline", async () => {
		ringUp(true);
		mocks.online = false;
		const wrapper = await openPay();
		await type(wrapper, "le");

		await saveOnly(wrapper);

		expect(mocks.completeOfflineSale).toHaveBeenCalledTimes(1);
		const queued = (mocks.completeOfflineSale.mock.calls[0] as unknown[])[0] as InvoiceData;
		expect(queued.pos_cashier).toBe("LE");
		wrapper.unmount();
	});

	it("is not shown, and payment works as before, when the profile does not ask for initials", async () => {
		ringUp(false);
		const wrapper = await openPay();

		expect(wrapper.findComponent(CashierInitialsField).exists()).toBe(false);
		expect(saveButton(wrapper).attributes("disabled")).toBe("false");

		await saveOnly(wrapper);
		expect(sentPayload()).not.toHaveProperty("pos_cashier");
		wrapper.unmount();
	});

	/**
	 * Bill (2026-10-01, MuleCity-qajl.6): "we should do initials for returns as well."
	 * A return on the shared login goes through the same Pay dialog: it cannot be
	 * saved without listed initials, and the return carries them as pos_cashier.
	 */
	function ringUpReturn() {
		const cart = ringUp(true);
		cart.items[0].qty = -1;
		cart.enterReturnMode("ACC-SINV-2026-00001", ["LAYER-PELLET"]);
		cart.orderNotes = "Torn bag";
		return cart;
	}

	it("a return asks for initials, is blocked until they are on the list, and sends them", async () => {
		ringUpReturn();
		const wrapper = await openPay();

		expect(wrapper.findComponent(CashierInitialsField).exists()).toBe(true);
		expect(saveButton(wrapper).attributes("disabled")).toBe("true");

		await type(wrapper, "zz");
		expect(saveButton(wrapper).attributes("disabled")).toBe("true");

		await type(wrapper, "le");
		expect(saveButton(wrapper).attributes("disabled")).toBe("false");

		await saveOnly(wrapper);
		const sent = sentPayload();
		expect([sent.is_return, sent.return_against, sent.pos_cashier, sent.pos_notes]).toEqual([
			true,
			"ACC-SINV-2026-00001",
			"LE",
			"Torn bag",
		]);
		wrapper.unmount();
	});

	it("negative: a return with no initials is never sent", async () => {
		ringUpReturn();
		const wrapper = await openPay();
		await saveOnly(wrapper);
		expect(mocks.call.mock.calls.some(([method]) => method === "xpos.api.invoices.create_invoice")).toBe(false);
		wrapper.unmount();
	});

	it("keeps the initials and the note on a return queued while offline", async () => {
		ringUpReturn();
		mocks.online = false;
		const wrapper = await openPay();
		await type(wrapper, "LE");

		await saveOnly(wrapper);

		expect(mocks.completeOfflineSale).toHaveBeenCalledTimes(1);
		const queued = (mocks.completeOfflineSale.mock.calls[0] as unknown[])[0] as InvoiceData;
		expect([queued.is_return, queued.pos_cashier, queued.pos_notes]).toEqual([true, "LE", "Torn bag"]);
		wrapper.unmount();
	});

	it("is not shown to a named login, which pays without initials", async () => {
		ringUp(true, NAMED_LOGIN);
		const wrapper = await openPay();

		expect(wrapper.findComponent(CashierInitialsField).exists()).toBe(false);
		expect(saveButton(wrapper).attributes("disabled")).toBe("false");

		await saveOnly(wrapper);
		expect(sentPayload()).not.toHaveProperty("pos_cashier");
		wrapper.unmount();
	});
});

/** Bill 2026-10-01 (MuleCity-qajl.1): "we do need the initials of the current user where the profile is." */

describe("initials in the top bar's avatar", () => {
	it("a named login shows its own initials", () => {
		expect(initialsOf("Leslie Ann Smith")).toBe("LS");
		expect(initialsOf("bill cromie")).toBe("BC");
		expect(initialsOf("Administrator")).toBe("A");
		expect(initialsOf("  ")).toBe("");
		expect(initialsOf(null)).toBe("");
		expect(tillInitials(false, "LE", "Madison Brown")).toBe("MB");
	});
	it("the shared register login shows the initials last accepted at Pay, a neutral mark before the first sale", () => {
		expect(tillInitials(true, "", "Mule City Register")).toBe("");
		expect(tillInitials(true, " le ", "Mule City Register")).toBe("LE");
	});
});
