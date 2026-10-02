/**
 * @vitest-environment jsdom
 *
 * User story (Mule City, MuleCity-q8aq, mc29 staging walk): the counter PC is switched on with the
 * internet down and Leslie opens her X POS bookmark. The till starts from the app shell; with a
 * boot saved on this device it signs her in offline as that user. With nothing saved, the login
 * says she is offline and why, instead of a bare "Sign in".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { online } = vi.hoisted(() => ({ online: { value: false } }));

vi.mock("@/utils", () => ({
	isOnline: () => online.value,
	isNetworkError: (e: unknown) => (e instanceof Error ? e.message : String(e)) === "__offline__",
}));
vi.mock("@/services/electronBridge", () => ({ isElectron: () => false, getApiBaseUrlSync: () => "" }));
vi.mock("@/services/api", () => ({ call: vi.fn(async () => Promise.reject(new Error("__offline__"))) }));
vi.mock("@/services/userRights", () => ({ loadPermissions: vi.fn(async () => {}), resetPermissions: vi.fn() }));

import { OFFLINE_NO_SESSION, useAuthStore } from "@/stores/authStore";

beforeEach(() => {
	setActivePinia(createPinia());
	online.value = false;
});

describe("an offline cold start from the app shell", () => {
	it("signs in offline as the user of the saved boot", async () => {
		(window as any).xpos = {
			offlineShell: true,
			boot: {
				user: { name: "pos@mulecity.com", email: "pos@mulecity.com" },
				user_info: { "pos@mulecity.com": { user_fullname: "Counter" } },
			},
		};
		const auth = useAuthStore();

		expect(await auth.checkAuth()).toBe(true);
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.isOfflineAuth).toBe(true);
		expect(auth.userName).toBe("pos@mulecity.com");
		expect(auth.userFullName).toBe("Counter");
		expect(auth.notice).toBe("");
	});

	it("says it is offline with no saved session when this device has none", async () => {
		(window as any).xpos = { offlineShell: true };
		const auth = useAuthStore();

		expect(await auth.checkAuth()).toBe(false);
		expect(auth.isAuthenticated).toBe(false);
		expect(auth.notice).toBe(OFFLINE_NO_SESSION);
	});

	it("resumes when the network is up but the server cannot be reached (the store's internet down)", async () => {
		online.value = true;
		(window as any).xpos = { offlineShell: true, boot: { user: { name: "pos@mulecity.com" } } };
		expect(await useAuthStore().checkAuth()).toBe(true);
	});

	it("carries on offline in a page the server rendered while the browser was offline (mc30 walk, /xpos/)", async () => {
		// The browser was offline, but its worker still reached the server: the page has its own
		// boot and token, and the app's calls fail. Before mc31 this ended on the login.
		(window as any).xpos = { boot: { user: { name: "pos@mulecity.com" } }, csrf_token: "t" };
		const auth = useAuthStore();
		expect(await auth.checkAuth()).toBe(true);
		expect(auth.isOfflineAuth).toBe(true);
		expect(auth.userName).toBe("pos@mulecity.com");
	});

	it("does not sign in a Guest page, and keeps the offline notice for the shell only", async () => {
		(window as any).xpos = { boot: { user: { name: "Guest" } }, csrf_token: "" };
		const auth = useAuthStore();
		expect(await auth.checkAuth()).toBe(false);
		expect(auth.notice).toBe("");
	});
});
