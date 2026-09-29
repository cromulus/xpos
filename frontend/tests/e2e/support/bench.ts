/**
 * Commands for specs that drive XPOS on a real bench (cypress.bench.config.ts).
 * Setup and read-back go through Frappe's own API with the test user's session;
 * the sale itself goes through the screen.
 */
import "./slowMotion";

// The browser's offline store; support/offline.ts empties it before each warm-up.
export const IDB_NAME = "xpos_offline_v3";

Cypress.on("uncaught:exception", (err) => {
	// Offline on purpose: the app's own background calls fail and say so.
	if (/Failed to fetch|NetworkError|Load failed|offline/i.test(err.message)) return false;
	return true;
});

/**
 * Log in with the bench user's password (a session cookie, as the browser has).
 * With XPOS_BENCH_IMPERSONATE set, an administrator login then continues as that
 * cashier (Frappe's own Impersonate, logged with a reason), so a site's real
 * counter login can be used without its password.
 */
Cypress.Commands.add("benchLogin", () => {
	cy.request("POST", "/api/method/login", {
		usr: Cypress.env("user"),
		pwd: Cypress.env("password"),
	});
	const cashier = Cypress.env("impersonate") as string;
	if (cashier) {
		cy.benchCall("frappe.core.doctype.user.user.impersonate", {
			user: cashier,
			reason: "XPOS offline-selling e2e",
		});
	}
});

/** Call a whitelisted method as the logged-in user and yield its message. */
Cypress.Commands.add("benchCall", (method: string, args: Record<string, unknown> = {}) => {
	return cy
		.request("/api/method/xpos.api.auth.get_csrf_token")
		.then((token) =>
			cy.request({
				method: "POST",
				url: `/api/method/${method}`,
				headers: { "X-Frappe-CSRF-Token": token.body.message },
				body: args,
			}),
		)
		// Frappe leaves "message" out of the body when a method returns None
		// (check_open_shift on a till with no open shift): that is null, not an error.
		.then((response) => response.body.message ?? null);
});

/**
 * Cut the page off the network for real (Chrome DevTools Protocol): fetches
 * fail, navigator.onLine turns false and the browser fires "offline", as when
 * the store's internet drops. cy.request keeps working (it runs in Node).
 */
function emulateNetwork(offline: boolean) {
	return Cypress.automation("remote:debugger:protocol", { command: "Network.enable", params: {} }).then(() =>
		Cypress.automation("remote:debugger:protocol", {
			command: "Network.emulateNetworkConditions",
			params: { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
		}),
	);
}

Cypress.Commands.add("networkOff", () => {
	cy.wrap(null).then(() => emulateNetwork(true));
	cy.window().its("navigator.onLine").should("eq", false);
});

Cypress.Commands.add("networkOn", () => {
	cy.wrap(null).then(() => emulateNetwork(false));
	cy.window().its("navigator.onLine").should("eq", true);
});

/** Every row of XPOS's offline sale queue, read straight from IndexedDB. */
Cypress.Commands.add("pendingInvoices", () => {
	return cy.window().then(
		(win) =>
			new Cypress.Promise<Array<Record<string, any>>>((resolve, reject) => {
				const open = win.indexedDB.open(IDB_NAME);
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const rows = db.transaction("pendingInvoices").objectStore("pendingInvoices").getAll();
					rows.onsuccess = () => {
						db.close();
						resolve(rows.result);
					};
					rows.onerror = () => reject(rows.error);
				};
			}),
	);
});

/** Put a sale in the offline queue, as the till does when Pay is pressed offline. */
Cypress.Commands.add("queueInvoice", (row: Record<string, unknown>) => {
	return cy.window().then(
		(win) =>
			new Cypress.Promise<void>((resolve, reject) => {
				const open = win.indexedDB.open(IDB_NAME);
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction("pendingInvoices", "readwrite");
					tx.objectStore("pendingInvoices").add(row);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
	);
});

/**
 * XPOS prints an offline receipt from a hidden iframe (printHtml). Keep each
 * printed page for the spec and stop the browser's print dialog from opening.
 */
Cypress.Commands.add("capturePrints", () => {
	cy.window().then((win) => {
		const printed: string[] = [];
		(win as unknown as { __printed: string[] }).__printed = printed;
		const body = win.document.body;
		const append = body.appendChild.bind(body);
		cy.stub(body, "appendChild").callsFake((node: Node) => {
			if (node instanceof win.HTMLIFrameElement && node.srcdoc) {
				printed.push(node.srcdoc);
				const onload = node.onload;
				node.onload = (event) => {
					if (node.contentWindow) node.contentWindow.print = () => {};
					return onload?.call(node, event);
				};
			}
			return append(node);
		});
	});
});

Cypress.Commands.add("printedPages", () => {
	return cy.window().its("__printed");
});

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Cypress {
		interface Chainable {
			benchLogin(): Chainable<void>;
			benchCall(method: string, args?: Record<string, unknown>): Chainable<any>;
			networkOff(): Chainable<void>;
			networkOn(): Chainable<void>;
			pendingInvoices(): Chainable<Array<Record<string, any>>>;
			queueInvoice(row: Record<string, unknown>): Chainable<void>;
			capturePrints(): Chainable<void>;
			printedPages(): Chainable<string[]>;
		}
	}
}

export {};
