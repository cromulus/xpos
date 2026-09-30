/**
 * Bill (2026-09-29): the counter sees at a glance, on the cart, whether the chosen
 * customer can take a delivery (an address on file), has email and phone on
 * file, and is tax-exempt (and why). The same icons show in the customer search.
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import CustomerStatusIcons from "@/components/customer/CustomerStatusIcons.vue";
import { customerStatusDetails } from "@/utils/customerStatus";

const t = (text: string, args: string[] = []) => text.replace("{0}", args[0] ?? "");

describe("customer status icons", () => {
	it("says a customer with an address can take a delivery, and why they are tax exempt", () => {
		const details = customerStatusDetails(
			{ xpos_has_address: true, xpos_has_email: false, xpos_has_phone: true },
			"Farm",
			t,
		);
		expect(details.map((d) => [d.key, d.present, d.label])).toEqual([
			["address", true, "Address on file: can take delivery"],
			["email", false, "Email missing"],
			["phone", true, "Phone on file"],
			["tax", true, "Tax exempt: Farm"],
		]);
	});

	it("says how many places a customer takes delivery when there are several (MuleCity-6nb1)", () => {
		const [address] = customerStatusDetails({ xpos_has_address: true, xpos_address_count: 3 }, "", t);
		expect(address).toEqual({ key: "address", present: true, label: "3 addresses on file: can take delivery", count: 3 });
		const wrapper = mount(CustomerStatusIcons, { props: { customer: { xpos_has_address: true, xpos_address_count: 3 } } });
		expect(wrapper.get("[data-testid='address-count']").text()).toBe("3");
		const one = mount(CustomerStatusIcons, { props: { customer: { xpos_has_address: true, xpos_address_count: 1 } } });
		expect(one.find("[data-testid='address-count']").exists()).toBe(false);
	});

	it("leaves out what the server did not say, and shows no tax icon for a taxable customer", () => {
		expect(customerStatusDetails({ xpos_has_address: false }, "", t)).toEqual([
			{ key: "address", present: false, label: "Address missing: no delivery" },
		]);
		expect(customerStatusDetails(null, undefined, t)).toEqual([]);
	});

	it("renders one labelled icon per detail on the cart's customer card", () => {
		const wrapper = mount(CustomerStatusIcons, {
			props: { customer: { xpos_has_address: true }, taxExemptReason: "Reseller (resale certificate)" },
		});
		const icons = wrapper.findAll("[role='img']");
		expect(icons.map((i) => i.attributes("data-status"))).toEqual(["address", "tax"]);
		expect(icons[1].attributes("aria-label")).toContain("Tax exempt");
	});
});
