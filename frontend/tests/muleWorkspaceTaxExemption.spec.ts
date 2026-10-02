/** Bill (2026-09-29): the tax exemption is set only from Edit Customer (its
 * button opens the desk), and why a customer is exempt shows with the
 * customer's status icons on the cart. The Mule City bar carries neither. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import MuleWorkspace from "@/components/MuleWorkspace.vue";
import PracticeSiteBanner from "@/components/PracticeSiteBanner.vue";

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

describe("The Mule City bar", () => {
	it("has no tax exemption text or link", () => {
		mounted = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn(), customer: "MC-CUST-4112" } });
		expect(mounted.text()).not.toContain("Tax exempt");
		expect(mounted.findAll("a").find(a => a.text() === "Set tax exemption")).toBeUndefined();
	});
});

/** Bill (2026-09-29, MuleCity-nfxn.1): "Practice site" showed on production. Since
 * 2026-10-01 (MuleCity-qajl.1) it is a red banner, lower left, not in the Mule City row. */
describe("The practice-site banner", () => {
	afterEach(() => { delete (window as any).xpos; });

	it("shows on a practice (staging) site", () => {
		(window as any).xpos = { boot: { mule_practice_site: true } };
		mounted = mount(PracticeSiteBanner);
		expect(mounted.get("[data-testid='practice-site-banner']").text()).toBe("Practice site");
		expect(mounted.get("[data-testid='practice-site-banner']").classes()).toContain("bg-red-600");
		// The old row's label is gone.
		const row = mount(MuleWorkspace, { props: { profile: "Till", request: vi.fn() } });
		expect(row.text()).not.toContain("Practice site");
		row.unmount();
	});

	it("never shows on production, or when the site does not say", () => {
		(window as any).xpos = { boot: { mule_practice_site: false } };
		mounted = mount(PracticeSiteBanner);
		expect(mounted.find("[data-testid='practice-site-banner']").exists()).toBe(false);
		mounted.unmount();
		(window as any).xpos = { boot: {} };
		mounted = mount(PracticeSiteBanner);
		expect(mounted.find("[data-testid='practice-site-banner']").exists()).toBe(false);
	});
});
