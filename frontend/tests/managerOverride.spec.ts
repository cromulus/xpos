/**
 * @vitest-environment jsdom
 *
 * User stories (Mule City MuleCity-zstm.13, Bill 2026-09-30 and 2026-10-14):
 * - Leslie charges a ticket for a customer over their credit limit (or past
 *   due). Instead of a red error toast she sees "Charge refused" with the
 *   site's message (who, how much) and a "Manager override" button.
 * - Ben picks his name and types his PIN; the same cart is paid again under his
 *   approval. The PIN goes to the site in that one request, as override_pwd,
 *   never inside the cart (which the till queues on disk), and the box is empty
 *   again after every try.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

vi.mock("@/services/api", () => ({ call: vi.fn() }));

import { call } from "@/services/api";
import { captureError, clearErrors, entries } from "@/services/errorLog";
import ManagerOverride from "@/components/dialogs/ManagerOverride.vue";
import { isChargeRefusal, isOverrideAnswer, payWithOverride } from "@/services/chargeOverride";
import type { InvoiceData } from "@/types/pos.types";

const mockedCall = vi.mocked(call);
const MESSAGE =
	"Steve Smith is over their credit limit: this charge brings what they owe to $1,620.74, $120.74 over their $1,500.00 limit. Take cash or card, or Ben or Matt can override with their PIN (Manager override).";

beforeEach(() => {
	vi.clearAllMocks();
	mockedCall.mockImplementation(async (method: string) =>
		method === "mulecity_erpnext.credit_override.override_approvers"
			? [
					{ user: "ben@mulecity.com", full_name: "Ben", has_pin: true },
					{ user: "matt@mulecity.com", full_name: "Matt", has_pin: false },
				]
			: undefined,
	);
});

describe("a refused charge at the till", () => {
	it("is recognised by the site's exception, and its refusals stay out of the error log", () => {
		expect(isChargeRefusal({ excType: "CreditHoldValidationError" })).toBe(true);
		expect(isChargeRefusal({ excType: "ValidationError" })).toBe(false);
		expect(isChargeRefusal(null)).toBe(false);
		expect(isOverrideAnswer({ status: 417, excType: "OverridePinError", message: "Wrong PIN" })).toBe(
			true,
		);
		expect(isOverrideAnswer({ status: 417, excType: "ValidationError", message: "x" })).toBe(false);
	});

	it("shows the message and asks a manager with a PIN for name and PIN", async () => {
		const wrapper = mount(ManagerOverride, { props: { message: MESSAGE } });
		expect(wrapper.get('[data-testid="charge-refusal-message"]').text()).toBe(MESSAGE);
		await wrapper.get('[data-testid="manager-override"]').trigger("click");
		await flushPromises();
		// Only managers who have set a PIN are offered; one is picked for her.
		const options = wrapper.findAll('[data-testid="manager-override-approver"] option:not([disabled])');
		expect(options.map((o) => o.text())).toEqual(["Ben"]);
		const pin = wrapper.get('[data-testid="manager-override-pin"]');
		expect(pin.attributes("type")).toBe("password");
		expect(pin.attributes("autocomplete")).toBe("off");
		await pin.setValue("482913");
		await wrapper.get("form").trigger("submit");
		expect(wrapper.emitted("approve")).toEqual([[{ approver: "ben@mulecity.com", pin: "482913" }]]);
		expect((pin.element as HTMLInputElement).value).toBe("");
	});

	it("negative: no manager has a PIN yet", async () => {
		mockedCall.mockResolvedValue([{ user: "ben@mulecity.com", full_name: "Ben", has_pin: false }]);
		const wrapper = mount(ManagerOverride, { props: { message: MESSAGE } });
		await wrapper.get('[data-testid="manager-override"]').trigger("click");
		await flushPromises();
		expect(wrapper.find("form").exists()).toBe(false);
		expect(wrapper.get('[data-testid="manager-override-error"]').text()).toMatch(
			/No manager has set an override PIN/,
		);
	});

	it("pays the same cart again with the PIN as its own argument, never inside the cart", async () => {
		const cart = { customer: "Steve Smith", local_id: "inv_1", items: [] } as unknown as InvoiceData;
		await payWithOverride(cart, "ben@mulecity.com", "482913");
		const [method, args, , options] = mockedCall.mock.calls[0];
		expect(method).toBe("mulecity_erpnext.credit_override.till_sale_with_override");
		expect(args).toEqual({
			data: JSON.stringify(cart),
			approver: "ben@mulecity.com",
			override_pwd: "482913",
			mix: 0,
		});
		expect(String((args as Record<string, unknown>).data)).not.toContain("482913");
		expect(options?.answers).toBe(isOverrideAnswer);
		expect(cart).not.toHaveProperty("override_pwd");
	});

	it("negative: a failed override call never keeps the PIN in the till's error log", () => {
		clearErrors();
		captureError({
			source: "api",
			title: "500 mulecity_erpnext.credit_override.till_sale_with_override",
			message: "Server error",
			args: { data: "{}", approver: "ben@mulecity.com", override_pwd: "482913", mix: 0 },
		});
		expect(JSON.stringify(entries.value)).not.toContain("482913");
		expect((entries.value[0].args as Record<string, unknown>).override_pwd).toBe("[redacted]");
	});
});
