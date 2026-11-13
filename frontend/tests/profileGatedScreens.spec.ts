/**
 * @vitest-environment jsdom
 *
 * Purchasing and cash-out screens open only when the POS Profile allows them.
 * The server refuses their actions otherwise, so the router sends the sidebar's
 * links, keyboard shortcuts and typed URLs back to the POS instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/router/routes", () => ({
	default: [
		"pos",
		"orders",
		"purchase-order",
		"purchase-orders",
		"purchase-invoice",
		"purchase-invoices",
		"stock-receiving",
		"expenses",
		"bank-drops",
	].map((name) => ({ path: `/${name}`, name, component: { render: () => null }, meta: { requiresAuth: true } })),
}));

vi.mock("@/services/electronBridge", () => ({ isElectron: () => false }));

vi.mock("@/stores/authStore", () => ({
	useAuthStore: () => ({ isAuthenticated: true, isLoading: false, canManagePermissions: false }),
}));

const pos = vi.hoisted(() => ({
	posProfile: null as Record<string, unknown> | null,
	allowPurchaseOrder: false,
	allowPurchaseReceipt: false,
	allowPosExpense: false,
	allowCashDeposit: false,
	enableCashierSettlement: false,
	isCashier: false,
}));
vi.mock("@/stores/posStore", () => ({ usePosStore: () => pos }));

import { profileFlagFor, router } from "@/router";

function allow(flags: Partial<typeof pos>) {
	Object.assign(pos, {
		posProfile: { name: "POS-1" },
		allowPurchaseOrder: false,
		allowPurchaseReceipt: false,
		allowPosExpense: false,
		allowCashDeposit: false,
		...flags,
	});
}

async function visit(path: string): Promise<string | null | undefined> {
	await router.push("/pos");
	await router.push(path);
	return router.currentRoute.value.name as string;
}

describe("profile-gated screens", () => {
	beforeEach(() => allow({}));

	it("maps each gated route to its POS Profile flag", () => {
		allow({ allowPurchaseOrder: true });
		expect(profileFlagFor("purchase-order")).toBe(true);
		expect(profileFlagFor("purchase-orders")).toBe(true);
		expect(profileFlagFor("purchase-invoice")).toBe(true);
		expect(profileFlagFor("purchase-invoices")).toBe(true);
		expect(profileFlagFor("stock-receiving")).toBe(false);
		expect(profileFlagFor("expenses")).toBe(false);
		expect(profileFlagFor("bank-drops")).toBe(false);
		expect(profileFlagFor("orders")).toBeUndefined();
		expect(profileFlagFor(undefined)).toBeUndefined();
	});

	it("sends a screen the profile does not allow back to the POS", async () => {
		for (const path of ["/purchase-order", "/purchase-invoices", "/stock-receiving", "/expenses", "/bank-drops"]) {
			expect(await visit(path)).toBe("pos");
		}
		expect(await visit("/orders")).toBe("orders");
	});

	it("opens each screen once its flag is on", async () => {
		allow({ allowPurchaseOrder: true });
		expect(await visit("/purchase-order")).toBe("purchase-order");
		expect(await visit("/purchase-invoices")).toBe("purchase-invoices");
		expect(await visit("/stock-receiving")).toBe("pos");

		allow({ allowPurchaseReceipt: true, allowPosExpense: true, allowCashDeposit: true });
		expect(await visit("/stock-receiving")).toBe("stock-receiving");
		expect(await visit("/expenses")).toBe("expenses");
		expect(await visit("/bank-drops")).toBe("bank-drops");
	});

	it("does not gate before the POS Profile has loaded", async () => {
		pos.posProfile = null;
		expect(await visit("/purchase-order")).toBe("purchase-order");
	});
});
