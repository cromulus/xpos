/**
 * What the site's apps add to the till (boot `xpos_site`, server `xpos.api.site_hooks.site_map`).
 *
 * XPOS never names a site app. A site's `xpos_site_extensions` hook fills a map
 * of feature flags and whitelisted method names, e.g.
 *
 *   { tax_context: "site_app.pos.tax_context", practice_site: true,
 *     mix: { quote: "site_app.mixes.quote", ... } }
 *
 * `siteMethod("mix.quote")` returns the method name (or undefined: the feature
 * is not on this site) and the caller passes it to `call` like any other
 * method, so each call reaches only a method that is already whitelisted and
 * keeps that method's own permission checks. The till never asks the server to
 * run "the method for a key".
 *
 * The map rides in the boot, so the offline boot copy keeps it.
 *
 * The page can start with a Guest boot (the login is part of the SPA) and get
 * the signed-in user's boot later (services/sessionBoot.ts applyBoot). Reads are
 * therefore reactive: a `computed(() => siteFeature("mix"))` or a template that
 * reads a flag re-evaluates when the boot is replaced. Never keep a flag in a
 * plain const at setup time.
 */
import { shallowRef } from "vue";

export type SiteValue = string | number | boolean | null | undefined | SiteMap | SiteValue[];
export interface SiteMap {
	[key: string]: SiteValue;
}

/** Keys whose stock XPOS method is used when no site sets one (mirrors site_hooks.SITE_DEFAULTS). */
export const SITE_DEFAULTS: Record<string, string> = {
	tax_context: "xpos.api.party_taxes.tax_context",
	tax_contexts: "xpos.api.party_taxes.tax_contexts",
};

/** Bumped whenever the boot (and so the map) is replaced; reads depend on it. */
const revision = shallowRef(0);

/** The boot was replaced: every reactive read of the map re-evaluates. */
export function siteMapChanged(): void {
	revision.value++;
}

/** The boot's site map (empty with no site extension or no boot). */
export function siteMap(): SiteMap {
	void revision.value;
	try {
		const boot = (globalThis as { xpos?: { boot?: Record<string, unknown> } }).xpos?.boot;
		const map = boot?.xpos_site;
		return map && typeof map === "object" ? (map as SiteMap) : {};
	} catch {
		return {};
	}
}

/** A value from the site map by dotted key ("mix.quote"), or undefined. */
export function siteValue(key: string): SiteValue {
	let value: SiteValue = siteMap();
	for (const part of key.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		value = (value as SiteMap)[part];
	}
	return value;
}

/** The whitelisted method a feature calls on this site, or undefined when it is off. */
export function siteMethod(key: string): string | undefined {
	const value = siteValue(key);
	if (typeof value === "string" && value) return value;
	// A site may turn a default off by setting its key to "" or false.
	if (value === undefined) return SITE_DEFAULTS[key];
	return undefined;
}

/** The method for `key`; throws when the site has none (a caller already gated on the feature). */
export function requireSiteMethod(key: string): string {
	const method = siteMethod(key);
	if (!method) throw new Error(`This site has no "${key}" feature`);
	return method;
}

/**
 * Whether the boot carries the site's whole map: the boot is a signed-in
 * server boot (it always has `xpos_site`) and no site extension failed while
 * building it (`extension_errors`, site_hooks.site_map). False on a Guest
 * boot, the desktop app (no boot) or a server older than the site hooks: a
 * feature that is off may then only be unknown.
 */
export function siteMapComplete(): boolean {
	void revision.value;
	try {
		const boot = (globalThis as { xpos?: { boot?: Record<string, unknown> } }).xpos?.boot;
		const map = boot?.xpos_site as SiteMap | undefined;
		if (!map || typeof map !== "object") return false;
		const errors = map.extension_errors;
		return !(Array.isArray(errors) ? errors.length : errors);
	} catch {
		return false;
	}
}

/** Whether a feature is on: a truthy flag, a method name, or a group with anything in it. */
export function siteFeature(key: string): boolean {
	const value = siteValue(key);
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === "object") return Object.keys(value).length > 0;
	return !!value;
}
