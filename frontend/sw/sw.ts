/// <reference lib="webworker" />
/**
 * X POS service worker (vite-plugin-pwa injectManifest; built to /xpos/sw.js, served by xpos/pwa.py).
 *
 * MuleCity-q8aq. Before this, the generated worker bound its navigation route to index.html, which
 * is never precached (Frappe renders /xpos with the session's boot and CSRF token), so it threw
 * non-precached-url while starting up and registered none of its routes: the till could not start
 * or reload offline. Now:
 *
 * - /xpos navigations go to the network, always. Only when the network cannot be reached at all
 *   (fetch throws) does the worker answer with the precached static shell, which carries no boot
 *   and no token; the page then starts from the last boot saved on the device (services/
 *   sessionBoot.ts). A server answer (any status, a 503 included) is passed through as it is.
 * - No HTML cache: the server-rendered page is never stored.
 * - GET /api/method/ answers are cached only for policy.API_GET_CACHE_ALLOWLIST (empty).
 * - Assets and public files are cached as before; private files are not.
 */
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import {
	API_CACHE,
	ASSETS_CACHE,
	FILES_CACHE,
	NAVIGATION_ALLOWLIST,
	OFFLINE_SHELL_URL,
	RETIRED_CACHES,
	isAsset,
	isCacheableApiGet,
	isPublicFile,
} from "./policy";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "SKIP_WAITING") void self.skipWaiting();
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("activate", (event) => {
	event.waitUntil(Promise.all(RETIRED_CACHES.map((name) => caches.delete(name))));
});

registerRoute(
	new NavigationRoute(
		async ({ request }) => {
			try {
				return await fetch(request);
			} catch (error) {
				const shell = await matchPrecache(OFFLINE_SHELL_URL);
				if (shell) return shell;
				throw error;
			}
		},
		{ allowlist: NAVIGATION_ALLOWLIST },
	),
);

registerRoute(
	({ url, request, sameOrigin }) => sameOrigin && isCacheableApiGet(url, request.method),
	new NetworkFirst({
		cacheName: API_CACHE,
		networkTimeoutSeconds: 5,
		plugins: [
			new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 }),
			new CacheableResponsePlugin({ statuses: [200] }),
		],
	}),
	"GET",
);

registerRoute(
	({ url, sameOrigin }) => sameOrigin && isAsset(url),
	new CacheFirst({
		cacheName: ASSETS_CACHE,
		plugins: [
			new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
			new CacheableResponsePlugin({ statuses: [200] }),
		],
	}),
	"GET",
);

registerRoute(
	({ url, sameOrigin }) => sameOrigin && isPublicFile(url),
	new CacheFirst({
		cacheName: FILES_CACHE,
		plugins: [
			new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 }),
			new CacheableResponsePlugin({ statuses: [200] }),
		],
	}),
	"GET",
);
