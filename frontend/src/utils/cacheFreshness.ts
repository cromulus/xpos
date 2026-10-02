/**
 * How often the till refreshes its offline caches, and how old a cache may be
 * before the status control says "check data sync" (MuleCity-rcxk).
 *
 * The stale limit used to equal the interval, so a refresh that ran a little
 * late, or one skipped while the till was offline, turned the status amber for
 * up to five minutes although everything was cached. The limit now has half an
 * interval of margin; a failed, incomplete or missing refresh still reads stale.
 */
export const CACHE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const CACHE_STALE_MS = CACHE_SYNC_INTERVAL_MS * 1.5;

/** After the network comes back, wait this long for it to settle before refreshing. */
export const RECONNECT_REFRESH_DELAY_MS = 3000;

export interface CacheFreshnessState {
	complete: boolean;
	error: boolean;
	loading: boolean;
	updatedAt: number;
}

export function isCacheFresh(state: CacheFreshnessState | undefined, now: number): boolean {
	return !!state && state.complete && !state.error && !state.loading && now - state.updatedAt < CACHE_STALE_MS;
}
