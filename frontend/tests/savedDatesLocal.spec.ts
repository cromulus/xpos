// The till's clock in US Eastern. 21:00 EDT on Oct 1 is already Oct 2 in UTC.
process.env.TZ = "America/New_York";

import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/services/api", () => ({ call: vi.fn(), default: { call: vi.fn() } }));
vi.mock("@/services/dbBridge", () => ({ cachePOSData: vi.fn(), getCachedPOSData: vi.fn(), cacheReceiptContext: vi.fn() }));
vi.mock("@/services/electronBridge", () => ({ isElectron: vi.fn(() => true) }));
vi.mock("@/stores/authStore", () => ({ useAuthStore: () => ({ userName: "pos@mulecity.com" }) }));

import { nowDate } from "@/utils/datetime";
import { usePosStore } from "@/stores/posStore";

/**
 * MuleCity-jh8j (mc35): Expense, Bank Drop, purchase invoices and the desktop
 * opening shift saved `new Date().toISOString().slice(0, 10)`, the UTC day:
 * after 8pm Eastern, tomorrow's date went into the books.
 */
describe("saved dates are the till's day, not UTC's", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 1, 21, 0, 0)); // Oct 1, 21:00 local
		setActivePinia(createPinia());
	});
	afterEach(() => {
		vi.useRealTimers();
		delete (window as { electronAPI?: unknown }).electronAPI;
		delete (window as { xpos?: unknown }).xpos;
	});

	it("runs at 21:00 Eastern, when the UTC day is already tomorrow", () => {
		expect(new Date().getHours()).toBe(21);
		expect(new Date().toISOString().slice(0, 10)).toBe("2026-10-02");
	});

	it("nowDate() is the local day, and the site's day from the boot time zone", () => {
		expect(nowDate()).toBe("2026-10-01");
		(window as { xpos?: unknown }).xpos = { boot: { time_zone: { system: "America/New_York", user: "America/New_York" } } };
		expect(nowDate()).toBe("2026-10-01");
	});

	it("the desktop opening shift saves today's local date", async () => {
		const createPosOpeningShift = vi.fn(async () => ({}));
		(window as { electronAPI?: unknown }).electronAPI = {
			db: {
				createPosOpeningShift,
				checkOpenShift: vi.fn(async () => ({ pos_opening_shift: { name: "POS-OPEN-1" } })),
			},
		};
		await usePosStore().openShift("Mule City Retail", "Mule City", []);
		expect(createPosOpeningShift).toHaveBeenCalledWith(expect.objectContaining({ opening_date: "2026-10-01" }));
	});

	it("no screen saves a UTC day (Expense, Bank Drop, purchase invoice, date pickers, pricing)", () => {
		const files = [
			"src/views/ExpenseView.vue",
			"src/views/BankDropView.vue",
			"src/views/PurchaseInvoiceView.vue",
			"src/stores/posStore.ts",
			"src/services/pricingEngine.ts",
			"src/components/ui/datetime-picker/DateTimePicker.vue",
			"src/components/ui/date-time-input/DateTimeInput.vue",
			"electron/database/ipcHandlers.ts",
		];
		for (const file of files) {
			const source = readFileSync(resolve(__dirname, "..", file), "utf8");
			expect([file, /toISOString\(\)\.(slice\(0, 1[09]\)|split\("T"\))/.test(source)]).toEqual([file, false]);
		}
	});
});
