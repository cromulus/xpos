import {
	createRouter,
	createWebHistory,
	createWebHashHistory,
	type Router,
	type RouteRecordRaw,
} from "vue-router";
import { useAuthStore } from "@/stores/authStore";
import { isElectron } from "@/services/electronBridge";
import routes from "./routes";
import { usePosStore } from "@/stores/posStore";

const history = isElectron() ? createWebHashHistory() : createWebHistory("/xpos");

export const router: Router = createRouter({
	history,
	routes,
});

let _firstRunChecked = false;
let _isFirstRun = false;

async function checkFirstRun(): Promise<boolean> {
	if (_firstRunChecked) return _isFirstRun;
	if (!isElectron()) {
		_firstRunChecked = true;
		_isFirstRun = false;
		return false;
	}
	try {
		_isFirstRun = await window.electronAPI!.isFirstRun();
	} catch {
		_isFirstRun = true;
	}
	_firstRunChecked = true;
	return _isFirstRun;
}

export function markSetupComplete(): void {
	_isFirstRun = false;
	_firstRunChecked = true;
}

const PROFILE_GATED_ROUTES: Record<string, () => boolean> = {
	"purchase-order": () => usePosStore().allowPurchaseOrder,
	"purchase-orders": () => usePosStore().allowPurchaseOrder,
	"purchase-invoice": () => usePosStore().allowPurchaseOrder,
	"purchase-invoices": () => usePosStore().allowPurchaseOrder,
	"stock-receiving": () => usePosStore().allowPurchaseReceipt,
	expenses: () => usePosStore().allowPosExpense,
	"bank-drops": () => usePosStore().allowCashDeposit,
};

/** The profile flag for a gated route, or undefined when the route isn't gated. */
function profileFlagFor(name: unknown): boolean | undefined {
	const flag = typeof name === "string" ? PROFILE_GATED_ROUTES[name] : undefined;
	return flag ? flag() : undefined;
}

router.beforeEach(async (to, _from, next) => {
	const firstRun = await checkFirstRun();
	if (firstRun && to.meta.isSetupPage !== true) {
		next({ name: "setup" });
		return;
	}
	if (!firstRun && to.meta.isSetupPage === true) {
		next({ name: "login" });
		return;
	}
	if (to.meta.isSetupPage === true) {
		next();
		return;
	}

	const authStore = useAuthStore();
	const posStore = usePosStore();

	if (!authStore.isAuthenticated && !authStore.isLoading) {
		await authStore.checkAuth();
	}

	const requiresAuth = to.meta.requiresAuth !== false;
	const isAuthPage = to.meta.isAuthPage === true;

	if (requiresAuth && !authStore.isAuthenticated) {
		next({
			name: "login",
			query: { redirect: to.fullPath },
		});
		return;
	}

	if (isAuthPage && authStore.isAuthenticated) {
		next({ name: "pos" });
		return;
	}

	if (to.name === "settings" && !isElectron()) {
		next({ name: "pos" });
		return;
	}
	if (to.name === "cashier" && (!posStore.enableCashierSettlement || !posStore.isCashier)) {
		next({ name: "pos" });
		return;
	}
	// Purchasing and cash-out screens only when the POS Profile allows them (the
	// same flags the sidebar and the server use), so keyboard shortcuts and
	// typed URLs don't open screens whose every action would be refused.
	if (posStore.posProfile && profileFlagFor(to.name) === false) {
		next({ name: "pos" });
		return;
	}
	if (to.meta.requiresAdmin === true && (isElectron() || !authStore.canManagePermissions)) {
		next({ name: "pos" });
		return;
	}

	if (to.meta.title) {
		document.title = `${to.meta.title} | X POS`;
	}

	next();
});
