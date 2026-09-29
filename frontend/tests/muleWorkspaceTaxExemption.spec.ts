/** Bill (2026-09-29): the tax exemption is set in Edit Customer only, and why a
 * customer is exempt shows with the customer's status icons on the cart. The
 * Mule City bar above the sale no longer carries either. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import MuleWorkspace from "@/components/MuleWorkspace.vue";

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

describe("The Mule City bar", () => {
	it("has no tax exemption text or link", () => {
		mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn(), customer: "MC-CUST-4112" } });
		expect(mounted.text()).not.toContain("Tax exempt");
		expect(mounted.findAll("a").find(a => a.text() === "Set tax exemption")).toBeUndefined();
	});
});

/** Bill (2026-09-29, MuleCity-nfxn.1): "Practice site" showed on production. */
describe("The practice-site label", () => {
	afterEach(() => { delete (window as any).xpos; });

	it("shows on a practice (staging) site", () => {
		(window as any).xpos = { boot: { mule_practice_site: true } };
		mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn() } });
		expect(mounted.text()).toContain("Practice site");
	});

	it("never shows on production, or when the site does not say", () => {
		(window as any).xpos = { boot: { mule_practice_site: false } };
		mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn() } });
		expect(mounted.text()).not.toContain("Practice site");
		mounted.unmount();
		(window as any).xpos = { boot: {} };
		mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn() } });
		expect(mounted.text()).not.toContain("Practice site");
	});
});
