/**
 * Cashier initials at Pay (Mule City, MuleCity-fb00.2).
 *
 * Several cashiers share one register login, so the login does not say who rang
 * a sale. When the POS Profile's `xpos_require_cashier_initials` is on and the
 * signed-in user's row on the profile is a shared login (`xpos_shared_login`,
 * MuleCity-1p4i), the cashier types their initials at Pay (honor system, no
 * PIN); they must be on the profile's cashier list and are saved on the invoice
 * as `pos_cashier`. Anyone signed in as themselves is not asked; the server
 * records their name. The server (`xpos.api.invoices.apply_pos_cashier`)
 * applies the same rules.
 */
import type { InvoiceData, POSProfile, XposCashier } from "@/types/pos.types";

/** Whether Pay asks this user for initials: the profile requires them and the user's row is a shared login. */
export function initialsRequiredFor(profile: POSProfile | null | undefined, users: string[]): boolean {
	if (!profile?.xpos_require_cashier_initials) return false;
	return (profile.applicable_for_users ?? []).some(
		(row) => users.includes(row.user) && !!row.xpos_shared_login,
	);
}

/** Initials as stored and compared: trimmed and uppercase ("le " -> "LE"). */
export function normalizeInitials(value: string | null | undefined): string {
	return (value ?? "").trim().toUpperCase();
}

/** The listed cashier these initials name, if any. */
export function matchCashier(cashiers: XposCashier[], typed: string): XposCashier | undefined {
	const initials = normalizeInitials(typed);
	if (!initials) return undefined;
	return cashiers.find((cashier) => normalizeInitials(cashier.initials) === initials);
}

/** Whether Pay may complete: always when not required, else only for listed initials. */
export function cashierInitialsOk(required: boolean, cashiers: XposCashier[], typed: string): boolean {
	return !required || !!matchCashier(cashiers, typed);
}

/** Put the typed initials on the invoice payload when the profile asks for them. */
export function applyCashier(data: InvoiceData, required: boolean, typed: string): InvoiceData {
	if (required) data.pos_cashier = normalizeInitials(typed);
	return data;
}
