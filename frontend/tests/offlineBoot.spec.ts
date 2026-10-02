/**
 * @vitest-environment jsdom
 *
 * User story (Mule City, MuleCity-q8aq): the store's internet is down when the counter PC is
 * switched on, or Leslie presses F5 while offline. The till still opens: the service worker serves
 * the static app shell, and the page starts from the boot saved at the last online start. That
 * saved boot never holds the CSRF token or another secret. When the internet returns, the till
 * fetches a fresh boot and token before it sends anything; if the session has expired it sends
 * nothing and asks for the login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { meta } = vi.hoisted(() => ({ meta: new Map<string, unknown>() }));

vi.mock("@/composables/useToast", () => ({ showSuccess: vi.fn(), showError: vi.fn(), showInfo: vi.fn() }));
vi.mock("@/utils", () => ({
	isOnline: () => true,
	isNetworkError: (e: unknown) => (e instanceof Error ? e.message : String(e)) === "__offline__",
}));
vi.mock("@/services/electronBridge", () => ({
	isElectron: () => false,
	getApiBaseUrlSync: () => "",
	getApiCredentialsSync: () => ({}),
}));
vi.mock("@/services/errorLog", () => ({ captureError: vi.fn() }));
vi.mock("@/composables/useCurrency", () => ({ formatWithSymbol: vi.fn() }));
vi.mock("@/services/idbService", () => ({
	setMeta: vi.fn(async (key: string, value: unknown) => {
		meta.set(key, JSON.parse(JSON.stringify(value)));
	}),
	getMeta: vi.fn(async (key: string) => meta.get(key)),
	deleteMeta: vi.fn(async (key: string) => {
		meta.delete(key);
	}),
}));

import { call } from "@/services/api";
import {
	OFFLINE_BOOT_KEY,
	SESSION_EXPIRED_EVENT,
	clearOfflineBoot,
	initSessionBoot,
	isSessionExpired,
	markSessionStale,
	resetSessionState,
	sanitizeBoot,
	saveOfflineBoot,
	sessionIsStale,
} from "@/services/sessionBoot";

const SERVER_TOKEN = "csrf-from-the-page-0123456789";

/** A boot as Frappe renders it, with secrets planted at every depth. */
function serverBoot(user = "leslie@mulecity.com") {
	return {
		user: { name: user, email: user, roles: ["Mule POS Cashier"], api_key: "user-api-key" },
		user_info: { [user]: { user_fullname: "Leslie", image: "" } },
		sysdefaults: { currency: "USD", company: "Mule City" },
		__messages: { Password: "Password", "Session token": "Session token" },
		csrf_token: SERVER_TOKEN,
		sentry_dsn: "https://key@sentry.example/1",
		ipinfo: { ip: "10.0.0.5" },
		sid: "session-id",
		pos_settings: { invoice_type: "Sales Invoice", nested: [{ api_secret: "s", ok: 1 }] },
		integrations: { refresh_token: "r", password: "p", webhook_secret: "w" },
	};
}

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function posts(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	meta.clear();
	resetSessionState();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the boot saved for an offline start", () => {
	it("keeps what the till needs and drops the CSRF token and every other secret, at any depth", () => {
		const clean = sanitizeBoot(serverBoot());
		const text = JSON.stringify(clean);

		expect(text).not.toContain(SERVER_TOKEN);
		for (const secret of ["user-api-key", "key@sentry", "10.0.0.5", "session-id", '"s"', '"r"', '"p"', '"w"']) {
			expect(text).not.toContain(secret);
		}
		expect(clean).not.toHaveProperty("csrf_token");
		expect(clean.user).toEqual({ name: "leslie@mulecity.com", email: "leslie@mulecity.com", roles: ["Mule POS Cashier"] });
		expect(clean.sysdefaults).toEqual({ currency: "USD", company: "Mule City" });
		expect(clean.pos_settings).toEqual({ invoice_type: "Sales Invoice", nested: [{ ok: 1 }] });
		// Translations are text keyed by text: kept whole.
		expect(clean.__messages).toEqual({ Password: "Password", "Session token": "Session token" });
	});

	it("is saved on an online start without the page's token, and never for a Guest", async () => {
		(window as any).xpos = { boot: serverBoot(), csrf_token: SERVER_TOKEN };
		await initSessionBoot();
		await vi.waitFor(() => expect(meta.has(OFFLINE_BOOT_KEY)).toBe(true));

		const saved = meta.get(OFFLINE_BOOT_KEY) as { boot: Record<string, unknown>; user: string };
		expect(saved.user).toBe("leslie@mulecity.com");
		expect(JSON.stringify(saved)).not.toMatch(/csrf/i);
		expect(JSON.stringify(saved)).not.toContain(SERVER_TOKEN);
		expect(sessionIsStale()).toBe(false);

		meta.clear();
		await saveOfflineBoot({ user: { name: "Guest" } });
		expect(meta.has(OFFLINE_BOOT_KEY)).toBe(false);
	});

	it("is removed at logout", async () => {
		await saveOfflineBoot(serverBoot());
		await clearOfflineBoot();
		expect(meta.has(OFFLINE_BOOT_KEY)).toBe(false);
	});

	it("starts the till from the app shell: saved boot and translations in place, no token, session stale", async () => {
		await saveOfflineBoot(serverBoot());
		(window as any).xpos = { offlineShell: true };

		await initSessionBoot();

		expect(window.xpos!.boot?.user?.name).toBe("leslie@mulecity.com");
		expect(window.xpos!._messages).toEqual({ Password: "Password", "Session token": "Session token" });
		expect(window.xpos!.csrf_token).toBeUndefined();
		expect(sessionIsStale()).toBe(true);
	});

	it("marks the session stale when the network drops", async () => {
		(window as any).xpos = { boot: serverBoot(), csrf_token: SERVER_TOKEN };
		await initSessionBoot();
		expect(sessionIsStale()).toBe(false);
		window.dispatchEvent(new Event("offline"));
		expect(sessionIsStale()).toBe(true);
	});
});

describe("before the first write after reconnecting", () => {
	beforeEach(async () => {
		await saveOfflineBoot(serverBoot());
		(window as any).xpos = { offlineShell: true };
		await initSessionBoot();
	});

	it("fetches a fresh boot and token first, then sends the write with that token", async () => {
		const fresh = { ...serverBoot(), sysdefaults: { currency: "USD", company: "Mule City", fresh: 1 } };
		fetchMock
			.mockResolvedValueOnce(jsonResponse(200, { message: { boot: fresh, csrf_token: "fresh-token" } }))
			.mockResolvedValueOnce(jsonResponse(200, { message: { name: "ACC-SINV-1" } }))
			.mockResolvedValueOnce(jsonResponse(200, { message: { name: "ACC-SINV-2" } }));

		await call("xpos.api.invoices.create_invoice", { data: "{}" });
		await call("xpos.api.invoices.create_invoice", { data: "{}" });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/api/method/xpos.api.auth.get_session_boot");
		expect(init.method).toBe("GET");
		expect(init.cache).toBe("no-store");
		// Both writes carry the fresh token; the boot is fetched once.
		expect(posts(fetchMock).map(([, i]) => i.headers["X-Frappe-CSRF-Token"])).toEqual(["fresh-token", "fresh-token"]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(window.xpos!.csrf_token).toBe("fresh-token");
		expect(window.xpos!.boot?.sysdefaults?.fresh).toBe(1);
		expect(sessionIsStale()).toBe(false);
		// The refreshed boot is saved for the next offline start, again without the token.
		await vi.waitFor(() =>
			expect((meta.get(OFFLINE_BOOT_KEY) as any).boot.sysdefaults.fresh).toBe(1),
		);
		expect(JSON.stringify(meta.get(OFFLINE_BOOT_KEY))).not.toContain("fresh-token");
	});

	it("sends one refresh when several writes start together", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("get_session_boot")
				? jsonResponse(200, { message: { boot: serverBoot(), csrf_token: "fresh-token" } })
				: jsonResponse(200, { message: 1 }),
		);
		await Promise.all([call("a.b.c"), call("a.b.d"), call("a.b.e")]);
		expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("get_session_boot"))).toHaveLength(1);
		expect(posts(fetchMock)).toHaveLength(3);
	});

	it("sends nothing when the session has expired, says so, and asks again next time", async () => {
		const expired = vi.fn();
		window.addEventListener(SESSION_EXPIRED_EVENT, expired);
		fetchMock.mockResolvedValueOnce(jsonResponse(401, { exc_type: "AuthenticationError" }));

		const error = await call("xpos.api.invoices.create_invoice", { data: "{}" }).catch((e) => e);

		expect(isSessionExpired(error)).toBe(true);
		expect(posts(fetchMock)).toHaveLength(0);
		expect(expired).toHaveBeenCalledTimes(1);
		expect(sessionIsStale()).toBe(true);
		window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
	});

	it("treats an unreachable server as offline and sends nothing", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const error = await call("xpos.api.invoices.create_invoice", { data: "{}" }).catch((e) => e);
		expect(error.message).toBe("__offline__");
		expect(posts(fetchMock)).toHaveLength(0);

		fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
		const again = await call("xpos.api.invoices.create_invoice", { data: "{}" }).catch((e) => e);
		expect(again.message).toBe("__offline__");
		expect(posts(fetchMock)).toHaveLength(0);
		expect(sessionIsStale()).toBe(true);
	});

	it("lets the login through, then refreshes before the next call", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse(200, { message: "Logged In" }))
			.mockResolvedValueOnce(jsonResponse(200, { message: { boot: serverBoot(), csrf_token: "new-session-token" } }))
			.mockResolvedValueOnce(jsonResponse(200, { message: "leslie@mulecity.com" }));

		await call("login", { usr: "leslie@mulecity.com", pwd: "x" });
		expect(fetchMock.mock.calls[0][0]).toBe("/api/method/login");
		markSessionStale();
		await call("frappe.auth.get_logged_user");
		expect(fetchMock.mock.calls[1][0]).toBe("/api/method/xpos.api.auth.get_session_boot");
		expect(fetchMock.mock.calls[2][1].headers["X-Frappe-CSRF-Token"]).toBe("new-session-token");
	});
});
