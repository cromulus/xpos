/** Counter story (Mule City): the bar above the sale says why the chosen customer is tax-exempt,
 * and links to the customer's desk form, where the reason is set (runbook O-10). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import MuleWorkspace from "@/components/MuleWorkspace.vue";

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

function bar(props: Record<string, unknown>) {
	mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn(), ...props } });
	return mounted;
}
const link = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("a").find(a => a.text() === "Set tax exemption");

describe("Tax exemption on the counter", () => {
	it("shows the reason for an exempt customer", () => {
		const wrapper = bar({ customer: "MC-CUST-4112", taxExemptReason: "Farm" });
		expect(wrapper.text()).toContain("Tax exempt: Farm");
	});

	it("links to the customer's desk form in a new tab", () => {
		const wrapper = bar({ customer: "MC CUST/4112", taxExemptReason: "Reseller (resale certificate)" });
		const a = link(wrapper)!;
		expect(a.attributes("href")).toBe("/desk/customer/MC%20CUST%2F4112#tax_category");
		expect(a.attributes("target")).toBe("_blank");
	});

	it("shows no reason for a taxable customer, but still offers the link", () => {
		const wrapper = bar({ customer: "MC-CUST-4112", taxExemptReason: "" });
		expect(wrapper.text()).not.toContain("Tax exempt");
		expect(link(wrapper)).toBeDefined();
	});

	it("shows nothing when no customer is chosen", () => {
		const wrapper = bar({});
		expect(wrapper.text()).not.toContain("Tax exempt");
		expect(link(wrapper)).toBeUndefined();
	});
});
