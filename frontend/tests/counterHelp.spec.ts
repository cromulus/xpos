/**
 * @vitest-environment jsdom
 *
 * User story (Mule City MuleCity-vz28.17.20): the till's "?" lists the counter's
 * procedures from the manual (mulecity_erpnext.in_app_help.get_help, screen
 * "xpos"), each opening its /manual page in a new tab. On a site without that
 * help (no Wiki or help API yet, or offline) it says so instead of opening a
 * manual page that is not there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/services/api", () => ({ call: mocks.call }));

// The popover's parts render in place, so the test reads what the cashier sees.
vi.mock("@/components/ui/popover", async () => {
	const { defineComponent, h } = await import("vue");
	const Pass = defineComponent({ setup: (_p, { slots }) => () => h("div", slots.default?.()) });
	return { Popover: Pass, PopoverTrigger: Pass, PopoverContentStyled: Pass };
});

import CounterHelp from "@/components/CounterHelp.vue";
import { useSiteExtension } from "./helpers/siteExtension";

// A site with the till extensions (boot xpos_site).
useSiteExtension();

const ENTRY = { id: "C-2", title: "Ring a sale", use_when: "A customer is buying", url: "/manual/counter#c-2" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => vi.restoreAllMocks());

describe("the till's Help (?) button", () => {
	it("lists the counter procedures once each, linking to the manual in a new tab", async () => {
		mocks.call.mockResolvedValue({ entries: [ENTRY, ENTRY] });
		const w = mount(CounterHelp);
		await w.get("[data-testid=counter-help]").trigger("click");
		await flushPromises();
		expect(mocks.call).toHaveBeenCalledWith("mulecity_erpnext.in_app_help.get_help", { screen: "xpos" });
		const links = w.findAll("[data-testid=counter-help-entry]");
		expect(links).toHaveLength(1);
		expect(links[0].attributes("href")).toBe("/manual/counter#c-2");
		expect(links[0].attributes("target")).toBe("_blank");
		expect(w.text()).toContain("Ring a sale");
		expect(window.open).not.toHaveBeenCalled();
	});

	it("no entries for this login: opens the manual's counter page", async () => {
		mocks.call.mockResolvedValue({ entries: [] });
		const w = mount(CounterHelp);
		await w.get("[data-testid=counter-help]").trigger("click");
		await flushPromises();
		expect(window.open).toHaveBeenCalledWith("/manual/counter", "_blank", "noopener");
	});

	it("negative: a site without the help says so and opens nothing", async () => {
		mocks.call.mockRejectedValue(new Error("Failed to get method for command mulecity_erpnext.in_app_help.get_help"));
		const w = mount(CounterHelp);
		await w.get("[data-testid=counter-help]").trigger("click");
		await flushPromises();
		expect(w.find("[data-testid=counter-help-unavailable]").exists()).toBe(true);
		expect(w.findAll("[data-testid=counter-help-entry]")).toHaveLength(0);
		expect(window.open).not.toHaveBeenCalled();
	});
});
