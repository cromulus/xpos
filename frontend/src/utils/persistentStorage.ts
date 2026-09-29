/**
 * Ask the browser to keep XPOS's offline data (items, prices, queued sales in
 * IndexedDB) when disk space runs low. Without it the browser may clear "best
 * effort" storage and take unsynced offline sales with it. Chrome grants it to
 * an installed app or a site the user engages with; a refusal leaves storage
 * as it was, so this never blocks the till.
 *
 * Returns whether storage is (now) persistent; false when the browser has no
 * Storage API.
 */
export async function requestPersistentStorage(): Promise<boolean> {
	const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
	if (!storage?.persist || !storage.persisted) return false;
	try {
		if (await storage.persisted()) return true;
		const granted = await storage.persist();
		if (!granted) console.warn("[XPOS] The browser did not make offline storage persistent");
		return granted;
	} catch (error) {
		console.warn("[XPOS] Persistent storage request failed", error);
		return false;
	}
}
