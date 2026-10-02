/**
 * Counter story (MuleCity-6nb1): a delivery order picked up at the counter.
 * The server switches it to pickup and drops its delivery charge; the clerk is
 * told so before the ticket loads for payment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const toast = vi.hoisted(() => ({ showInfo: vi.fn() }));
vi.mock("@/services/api", () => toast);

import MuleWorkspace from "@/components/MuleWorkspace.vue";

const order = { name: "SAL-ORD-1", customer_name: "ALBERT ADKINS", delivery_date: "2026-09-30", status: "To Deliver and Bill" };

let mounted: ReturnType<typeof mount> | null = null;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { mounted?.unmount(); mounted = null; });

async function loadOrder(doc: Record<string, unknown>) {
	HTMLDialogElement.prototype.showModal ??= function () {};
	HTMLDialogElement.prototype.close ??= function () {};
	const request = vi.fn((method: string) => Promise.resolve(method.endsWith("find_orders") ? [order] : doc));
	const wrapper = mount(MuleWorkspace, { props: { customer: "MC-CUST-4112", profile: "Till", request }, attachTo: document.body });
	mounted = wrapper;
	// Still reachable through the exposed open('orders'); the till's Orders view is the usual way in.
	await (wrapper.vm as unknown as { open: (mode: string) => Promise<void> }).open("orders");
	await flushPromises();
	[...document.body.querySelectorAll("button")].find((b) => b.textContent === "Load for payment")!.click();
	await flushPromises();
	return wrapper;
}

describe("Picking up a delivery order at the counter", () => {
	it("tells the clerk the delivery was switched to pickup, then loads the ticket", async () => {
		const notice = "Switched to pickup: the delivery charge was removed.";
		const wrapper = await loadOrder({ name: "ACC-SINV-1", mule_notice: notice });
		expect(toast.showInfo).toHaveBeenCalledWith(notice);
		expect(wrapper.emitted("pickup")?.[0]?.[0]).toMatchObject({ name: "ACC-SINV-1" });
	});

	it("says nothing extra for an ordinary pickup order", async () => {
		const wrapper = await loadOrder({ name: "ACC-SINV-2" });
		expect(toast.showInfo).not.toHaveBeenCalled();
		expect(wrapper.emitted("pickup")).toHaveLength(1);
	});
});
