/**
 * The till's web app manifest (MuleCity-68mo), written by this plugin instead of vite-plugin-pwa.
 *
 * vite-plugin-pwa put the manifest at a fixed /assets/xpos/xpos/manifest.webmanifest (a year in
 * Cloudflare), linked it next to the page's own `./manifest.webmanifest`, and added the manifest and
 * its icons to the precache as bare names. Those resolve against /xpos/sw.js to /xpos/<name>, which
 * Frappe answers with the logged-in till page, so the worker precached that page (boot and CSRF token)
 * as "icons". Here:
 *   - the icons are content-named assets (assets/pwa-192x192-<hash>.svg), linked by absolute URL;
 *   - the manifest is still written as manifest.webmanifest, but the page links /xpos/manifest.webmanifest,
 *     which xpos/pwa.py serves with no-store, so no cache keeps an older one;
 *   - nothing here enters the precache except through the glob (absolute, under /assets/xpos/xpos/).
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { Plugin } from "vite";
import { ASSET_PREFIX } from "../sw/policy";

/** Where the page links the manifest: xpos/pwa.py serves the built file there with no-store. */
export const MANIFEST_ROUTE = "/xpos/manifest.webmanifest";
export const MANIFEST_FILE = "manifest.webmanifest";

const ICON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/assets/pwa");

type Icon = { file: string; sizes: string; purpose?: string };

const ICONS: Icon[] = [
	{ file: "pwa-192x192.svg", sizes: "192x192" },
	{ file: "pwa-512x512.svg", sizes: "512x512" },
	{ file: "pwa-512x512.svg", sizes: "512x512", purpose: "any maskable" },
];

export const MANIFEST = {
	name: "X POS - Point of Sale",
	short_name: "X POS",
	description: "Modern Point of Sale application with offline support",
	theme_color: "#f97316",
	background_color: "#ffffff",
	display: "standalone",
	orientation: "any",
	lang: "en",
	// The worker's scope (MuleCity-q8aq): /xpos itself, as Frappe serves it.
	scope: "/xpos",
	start_url: "/xpos",
	id: "/xpos/",
	categories: ["business", "finance"],
};

/** The manifest, with each icon at the URL the build gave it. */
export function webManifest(iconUrl: (file: string) => string) {
	return {
		...MANIFEST,
		icons: ICONS.map(({ file, sizes, purpose }) => ({
			src: iconUrl(file),
			sizes,
			type: "image/svg+xml",
			...(purpose ? { purpose } : {}),
		})),
		screenshots: [
			{ src: iconUrl("pwa-512x512.svg"), sizes: "512x512", type: "image/svg+xml", form_factor: "wide", label: "X POS Dashboard" },
			{ src: iconUrl("pwa-512x512.svg"), sizes: "512x512", type: "image/svg+xml", form_factor: "narrow", label: "X POS Mobile" },
		],
	};
}

export function webManifestPlugin(): Plugin {
	return {
		name: "xpos-web-manifest",
		apply: "build",
		generateBundle() {
			const urls = new Map<string, string>();
			for (const file of new Set(ICONS.map((icon) => icon.file).concat("pwa-512x512.svg"))) {
				const ref = this.emitFile({ type: "asset", name: file, source: readFileSync(resolve(ICON_DIR, file)) });
				urls.set(file, `${ASSET_PREFIX}${this.getFileName(ref)}`);
			}
			const manifest = webManifest((file) => urls.get(file)!);
			this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: `${JSON.stringify(manifest, null, "\t")}\n` });
		},
	};
}
