/**
 * Shared steps for the offline stories in tests/e2e/bench/offline-*.cy.ts
 * (Mule City's offline suite, MuleCity-ispl; built on the bench harness of
 * MuleCity-p7i5). A story reads as the counter works: open the till online so
 * it caches items, customers, prices and taxes, cut the internet, ring up,
 * bring it back, and read the server's documents. The cashier-switching phase
 * (fb00.7) reuses these.
 *
 * Every story file registers ``restoreNetworkAfterEach()``: the network cut is
 * the browser's, not the page's, so a failed story would otherwise leave the
 * next one offline before it can load.
 */
import { IDB_NAME } from "./bench";

export const item = () => Cypress.env("item") as string;
export const customer = () => Cypress.env("customer") as string;
export const secondMode = () => (Cypress.env("secondMode") as string) || "Cash";

/** Retry `read` until `ok(result)` or about a minute passes (sync runs on reconnect). */
export function waitUntil<T>(read: () => Cypress.Chainable<T>, ok: (value: T) => boolean, message: string, tries = 60) {
	read().then((value) => {
		if (ok(value)) return;
		// Say what was last read (e.g. a queued sale's sync error) so a failure explains itself.
		if (tries <= 0) throw new Error(`Timed out waiting: ${message}; last read: ${JSON.stringify(value).slice(0, 2000)}`);
		cy.wait(1000);
		waitUntil(read, ok, message, tries - 1);
	});
}

/** An open till for the bench user, as the counter opens it in the morning. */
export function ensureOpenShift() {
	cy.benchCall("xpos.api.shifts.check_open_shift").then((open) => {
		if (open) return;
		cy.benchCall("xpos.api.shifts.open_shift", {
			pos_profile: Cypress.env("profile"),
			company: Cypress.env("company"),
			balance_details: JSON.stringify([{ mode_of_payment: "Cash", amount: 100 }]),
		});
	});
}

/**
 * Open XPOS online from an empty offline store, so the story proves the
 * warm-up (items, customers, prices and taxes reach the browser), and wait
 * for the item list.
 */
export function openTillOnline() {
	cy.visit("/xpos/", {
		onBeforeLoad(win) {
			win.indexedDB.deleteDatabase(IDB_NAME);
		},
	});
	cy.contains(item(), { timeout: 30000 }).should("exist");
}

/**
 * Pick `name` (the bench customer by default) with the cart's customer button;
 * skipped when the cart already has them (a new ticket starts on the profile's
 * default).
 */
export function chooseCustomer(name: string = customer()) {
	// X POS renders the cart twice (desktop and a hidden narrow layout), so the
	// test id matches two buttons: use the one on screen.
	cy.get("[data-testid='cart-customer']:visible").first().then(($button) => {
		if ($button.text().includes(name)) return;
		cy.wrap($button).click();
		cy.get("[role='dialog'] input").first().type(name);
		cy.contains("[role='dialog'] *", name, { timeout: 15000 }).first().click();
		cy.get("[role='dialog']").should("not.exist");
	});
}

/** The listed cashier initials the stories type at Pay (XPOS_BENCH_INITIALS; "LE" by default). */
export const cashierInitials = () => (Cypress.env("initials") as string) || "LE";

/** The bench user is a Shared Login (XPOS_BENCH_SHARED_LOGIN), so Pay must ask for initials. */
export const sharedLogin = () => Boolean(Cypress.env("sharedLogin"));

/**
 * Save & Print with Enter, as the counter does. On a register that asks for cashier
 * initials at Pay (Mule City's shared counter login, MuleCity-fb00), type listed
 * initials first: Enter in that box moves to the amount, whose Enter completes the
 * sale. A site without the flag shows no box and Enter goes to the dialog as before.
 * When the bench user is the Shared Login (erp2's offline suite, MuleCity-g4gj) the
 * box must be there: a till that stopped asking would otherwise pass unnoticed.
 * With `tendered`, that amount is typed into the Tendered box before Enter (more
 * than the total gives change, MuleCity-ztb9); without it the tender stays as filled.
 */
export function payWithEnter(initials: string = cashierInitials(), tendered?: number) {
	if (sharedLogin()) cy.get("[role='dialog'] [data-testid='cashier-initials-input']").should("exist");
	cy.get("[role='dialog']").then(($dialog) => {
		const field = $dialog.find("[data-testid='cashier-initials-input']");
		if (field.length) cy.wrap(field).clear().type(`${initials}{enter}`);
		if (tendered !== undefined) {
			cy.get("[role='dialog'] input[type='text']:not([data-testid='cashier-initials-input'])")
				.first()
				.clear()
				.type(`${tendered}{enter}`);
		} else if (field.length) {
			cy.focused().type("{enter}");
		} else {
			cy.wrap($dialog).type("{enter}");
		}
	});
}

/** One bag for `buyer`, paid in full with `mode`, Save & Print. */
export function ringUpOneBag(mode: string, buyer: string = customer()) {
	chooseCustomer(buyer);
	cy.contains(item()).first().click();
	cy.cartRows().should("have.length", 1);
	cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
	cy.get(`[data-testid='payment-method'][data-mode='${mode}']`).click();
	// Selecting the tender fills the remaining amount; Enter is Save & Print.
	payWithEnter();
	cy.get("[role='dialog']").should("not.exist");
	cy.cartRows().should("have.length", 0);
}

/**
 * One bag for `buyer`, paid with `tendered` of `mode` typed into the Tendered
 * box (more than the total, so the register owes change), Save & Print.
 * ``ringUpOneBag`` is the exact-amount sibling.
 */
export function ringUpOneBagTendering(mode: string, tendered: number, buyer: string = customer()) {
	chooseCustomer(buyer);
	cy.contains(item()).first().click();
	cy.cartRows().should("have.length", 1);
	cy.window().then((win) => win.dispatchEvent(new CustomEvent("xpos:process-payment")));
	cy.get(`[data-testid='payment-method'][data-mode='${mode}']`).click();
	// Type the tender (after the cashier's initials, where asked); Enter is Save & Print.
	payWithEnter(cashierInitials(), tendered);
	cy.get("[role='dialog']").should("not.exist");
	cy.cartRows().should("have.length", 0);
}

/** `buyer`'s submitted Sales Invoices, newest first. */
export function customerInvoices(buyer: string = customer(), fields: string[] = ["name", "grand_total"]) {
	return cy.benchCall("frappe.client.get_list", {
		doctype: "Sales Invoice",
		filters: { customer: buyer, docstatus: 1 },
		fields,
		order_by: "creation desc",
		limit_page_length: 50,
	});
}

/** Always put the network back after a story, pass or fail. */
export function restoreNetworkAfterEach() {
	afterEach(() => {
		cy.wrap(null).then(() =>
			Cypress.automation("remote:debugger:protocol", {
				command: "Network.emulateNetworkConditions",
				params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
			}),
		);
	});
}

/** The session refresh a till asks before its first write after reconnecting (MuleCity-q8aq). */
export const SESSION_BOOT = "/api/method/xpos.api.auth.get_session_boot";

/** The page's X POS globals (window.xpos). */
export type TillGlobals = { offlineShell?: boolean; csrf_token?: string; boot?: { user?: { name?: string } } };
export const till = (win: Cypress.AUTWindow) => (win as unknown as { xpos: TillGlobals }).xpos;

/** What the till saved for an offline start (IndexedDB meta "offline_boot"). */
export function savedBoot() {
	return cy.window().then(
		(win) =>
			new Cypress.Promise<Record<string, any> | undefined>((resolve, reject) => {
				const open = win.indexedDB.open(IDB_NAME);
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction("meta").objectStore("meta").get("offline_boot");
					get.onsuccess = () => {
						db.close();
						resolve(get.result?.value);
					};
					get.onerror = () => reject(get.error);
				};
			}),
	);
}

/**
 * The server as the browser reaches it. While `down`, every request to it fails as a network
 * error, the service worker's fetches included (a page-level CDP offline does not reach the
 * worker). Requests to /xpos and /api are recorded, in order, with the CSRF token they carried;
 * the session refresh is aliased "@freshBoot". Register before any cy.intercept that stubs a
 * response (the newer one answers first).
 */
export function interceptServer() {
	const server = {
		down: false,
		seen: [] as Array<{ method: string; path: string; token?: string }>,
	};
	cy.intercept({ url: /.*/ }, (req) => {
		const path = new URL(req.url).pathname;
		if (server.down) {
			req.destroy();
			return;
		}
		if (!/^\/(xpos|api)(\/|$)/.test(path)) return;
		server.seen.push({ method: req.method, path, token: req.headers["x-frappe-csrf-token"] as string | undefined });
		if (path === SESSION_BOOT) req.alias = "freshBoot";
	});
	return server;
}

/** The internet drops: the server out of reach and the browser offline. */
export function internetDown(server: ReturnType<typeof interceptServer>) {
	cy.then(() => {
		server.down = true;
	});
	cy.networkOff();
}

/**
 * The internet returns. The till must fetch a fresh boot and CSRF token before any write, and
 * every write after that carries the fresh token; resolves once the offline queue is empty.
 */
export function internetBackAndSynced(server: ReturnType<typeof interceptServer>) {
	cy.then(() => {
		server.down = false;
		server.seen.length = 0;
	});
	cy.networkOn();
	cy.wait("@freshBoot", { timeout: 30000 }).then(({ response }) => {
		const fresh = response?.body?.message?.csrf_token as string;
		expect(fresh, "the server's token").to.be.a("string").and.not.equal("");
		waitUntil(() => cy.pendingInvoices(), (rows) => rows.length === 0, "the offline sale to sync");
		cy.then(() => {
			const posts = server.seen.filter((r) => r.method === "POST");
			const firstBoot = server.seen.findIndex((r) => r.path === SESSION_BOOT);
			const firstPost = server.seen.findIndex((r) => r.method === "POST");
			expect(firstBoot, "the boot is fetched before any write").to.be.within(0, firstPost);
			expect(posts.length, "writes after reconnecting").to.be.greaterThan(0);
			posts.forEach((r) => expect(r.token, `${r.path} carries the fresh token`).to.equal(fresh));
		});
		cy.window().its("xpos.csrf_token").should("equal", fresh);
	});
}

/**
 * A browser that has never run X POS: no service worker, no caches, no offline database. Done
 * from a page outside the till (a 404), so no till code re-registers the worker meanwhile.
 */
export function freshBrowser() {
	cy.visit("/q8aq-fresh-browser", { failOnStatusCode: false });
	cy.window().then(async (win) => {
		for (const registration of await win.navigator.serviceWorker.getRegistrations()) await registration.unregister();
		for (const name of await win.caches.keys()) await win.caches.delete(name);
		await new Promise((resolve) => {
			const request = win.indexedDB.deleteDatabase(IDB_NAME);
			request.onsuccess = request.onerror = request.onblocked = () => resolve(null);
		});
	});
}

Cypress.Commands.add("cartRows", () => cy.get("[data-cart-index]:visible"));

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Cypress {
		interface Chainable {
			cartRows(): Chainable<JQuery<HTMLElement>>;
		}
	}
}
