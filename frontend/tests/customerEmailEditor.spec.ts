/** Clicking the email action reuses the customer editor and saves a real email. */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import CustomerEditDialog from "@/components/dialogs/CustomerEditDialog.vue";
const mocks = vi.hoisted(() => ({ customer: null as any, cart: null as any, info: vi.fn(), update: vi.fn() }));
vi.mock("@/stores/customerStore", () => ({ useCustomerStore: () => mocks.customer }));
vi.mock("@/stores/cartStore", () => ({ useCartStore: () => mocks.cart }));
vi.mock("@/services/api", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));
const container = { template: '<div><slot /></div>' };
const input = { props: ["modelValue"], emits: ["update:modelValue"], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' };
let wrapper: ReturnType<typeof mount>;
describe("email editor", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.customer = reactive({ showCustomerEditDialog: false, customerEditFocus: "email", getCustomerInfo: mocks.info, updateCustomer: mocks.update });
		mocks.cart = reactive({ customer: { name: "BUYER", customer_name: "Buyer", xpos_has_email: false }, setCustomer: vi.fn((c) => { mocks.cart.customer = c; }) });
	});
	afterEach(() => wrapper?.unmount());
	it.each(["", "old@example.com"])("prefills and focuses email (%s), then refreshes the saved status", async (email) => {
		mocks.info.mockResolvedValue({ customer_name: "Buyer", email_id: email, mobile_no: "555" });
		mocks.update.mockResolvedValue({ email_id: "new@example.com" });
		wrapper = mount(CustomerEditDialog, { attachTo: document.body, global: { stubs: {
			Dialog: container, DialogContent: container, DialogHeader: container, DialogTitle: container,
			DialogDescription: container, DialogFooter: container, CustomerAddresses: true, Input: input,
			Button: { template: '<button><slot /></button>' },
		} } });
		mocks.customer.showCustomerEditDialog = true;
		await flushPromises();
		const field = wrapper.get('input[type="email"]');
		expect((field.element as HTMLInputElement).value).toBe(email);
		expect(document.activeElement).toBe(field.element);
		await field.setValue("new@example.com");
		await wrapper.findAll("button").find(b => b.text() === "Save Changes")!.trigger("click");
		await flushPromises();
		expect(mocks.update).toHaveBeenCalledWith("BUYER", { email_id: "new@example.com" });
		expect(mocks.cart.customer).toMatchObject({ email_id: "new@example.com", xpos_has_email: true });
		expect(mocks.customer.showCustomerEditDialog).toBe(false);
	});
});
