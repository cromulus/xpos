/**
 * User story (Mule City, 2026-09-29): the counter sells offline in the browser.
 * XPOS asks the browser to keep its offline data, so queued sales are not
 * cleared when the disk runs low; a refusal never blocks the till.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "@/utils/persistentStorage";

function withStorage(storage: unknown) {
	vi.stubGlobal("navigator", { storage });
}

afterEach(() => vi.unstubAllGlobals());

describe("requestPersistentStorage", () => {
	it("asks once and reports a grant", async () => {
		const persist = vi.fn(async () => true);
		withStorage({ persisted: vi.fn(async () => false), persist });
		await expect(requestPersistentStorage()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();
	});

	it("does not ask again when storage is already persistent", async () => {
		const persist = vi.fn(async () => true);
		withStorage({ persisted: vi.fn(async () => true), persist });
		await expect(requestPersistentStorage()).resolves.toBe(true);
		expect(persist).not.toHaveBeenCalled();
	});

	it("carries on when the browser refuses or has no Storage API", async () => {
		withStorage({ persisted: vi.fn(async () => false), persist: vi.fn(async () => false) });
		await expect(requestPersistentStorage()).resolves.toBe(false);
		withStorage({ persisted: vi.fn(async () => false), persist: vi.fn(async () => Promise.reject(new Error("x"))) });
		await expect(requestPersistentStorage()).resolves.toBe(false);
		withStorage(undefined);
		await expect(requestPersistentStorage()).resolves.toBe(false);
	});
});
