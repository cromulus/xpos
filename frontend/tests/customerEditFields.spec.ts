/**
 * Bill (2026-09-29, MuleCity-nfxn.7): the counter's Edit Customer shows the
 * name, phone and email (and the Tax exemption button), not Customer Group,
 * Territory, Tax ID, Gender, Referral Code or Birthday.
 */
import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const info = { name: "CUST-9", customer_name: "Sharp Farms", mobile_no: "919-555-0199", email_id: "sharp@example.com" };
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => ({ customer: { name: "CUST-9" }, setCustomer: vi.fn() }) }));
vi.mock("@/stores/customerStore", () => ({
	useCustomerStore: () => ({ showCustomerEditDialog: true, getCustomerInfo: vi.fn(async () => info), updateCustomer: vi.fn() }),
}));
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));
vi.mock("@/services/customerTax", () => ({ openCustomerTaxSection: vi.fn() }));
vi.mock("@/lib/translate", () => ({ default: (text: string) => text, __: (text: string) => text }));

import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";

const passthrough = { template: "<div><slot /></div>" };
const stubs = {
	Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough,
	DialogDescription: passthrough, DialogFooter: passthrough,
	Button: { template: "<button><slot /></button>" },
	Input: { props: ["modelValue"], template: "<input :value='modelValue' />" },
	Loader2: true,
};

describe("Edit Customer at the counter", () => {
	it("shows name, phone and email only", async () => {
		const wrapper = mount(CustomerEditDialog, { global: { stubs } });
		await flushPromises();
		const text = wrapper.text();
		for (const label of ["Customer Name", "Mobile No", "Email", "Tax exemption"]) expect(text).toContain(label);
		for (const label of ["Customer Group", "Territory", "Tax ID", "Gender", "Referral Code", "Birthday"]) {
			expect(text).not.toContain(label);
		}
	});
});
