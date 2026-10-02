/**
 * Build check (MuleCity-68mo): nothing the till loads may sit at a fixed name under /assets.
 *
 * Frappe serves /assets with `Cache-Control: max-age=31536000` and Cloudflare keeps it for that
 * year, so a file whose name stays the same across builds can come back from Cloudflare as the
 * previous build's copy (mc30 got mc29's offline-shell.html that way, MuleCity-q8aq). Workbox
 * precaches from the plain URL (its revision is only in the cache key), so the precache is no
 * protection. What the till loads must therefore be:
 *   - content-named (Vite's `name-<8 char hash>.ext`, or the shell's `offline-shell-<12 hex>.html`), or
 *   - versioned with a query (`?v=...`), or
 *   - one of the worker routes xpos/pwa.py serves with no-store (/xpos/sw.js, /xpos/manifest.webmanifest).
 *
 * It also checks that every precache entry is an absolute URL under /assets/xpos/xpos/. mc31's
 * precache held bare `pwa-192x192.svg`, `apple-touch-icon.svg` and `manifest.webmanifest` (added by
 * vite-plugin-pwa outside the glob, so modifyURLPrefix never touched them). They resolve against
 * /xpos/sw.js to /xpos/<name>, which Frappe answers with the logged-in till page, so the worker
 * stored that page, CSRF token and all, in the precache.
 *
 * Run after `vite build` (sw.js is written last): `node scripts/checkAssetNames.mjs [outDir]`.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/** Keep in step with sw/policy.ts ASSET_PREFIX (tests/assetNames.spec.ts checks it). */
export const ASSET_PREFIX = "/assets/xpos/xpos/";

/** Routes xpos/pwa.py serves from the build with Cache-Control: no-store. */
export const NO_STORE_ROUTES = ["/xpos/sw.js", "/xpos/manifest.webmanifest"];

/** The only files allowed at the build's top level (everything else goes in assets/ with a hash). */
export const ROOT_FILES = [/^index\.html$/, /^sw\.js(\.map)?$/, /^manifest\.webmanifest$/, /^offline-shell-[0-9a-f]{12}\.html$/, /^assets$/];

/** Vite's `[name]-[hash].[ext]` (8 url-safe characters) or the shell's 12 hex characters. */
const CONTENT_NAMED = /(?:-[A-Za-z0-9_-]{8}|^offline-shell-[0-9a-f]{12})\.[a-z0-9]+$/;

function basename(path) {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** True when the URL's file name carries a content hash or the URL a version query. */
export function isVersioned(url) {
	const [path, query = ""] = url.split(/[?#]/, 2);
	if (/(^|&)v(er)?=[^&]+/.test(query)) return true;
	return CONTENT_NAMED.test(basename(path));
}

/** Every src/href in the HTML (scripts, styles, preloads, icons, the manifest). */
export function htmlReferences(html) {
	return [...html.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(
		(match) => ({ tag: match[0].replace(/\s+/g, " ").slice(0, 120), url: match[1] }),
	);
}

/** The precache manifest workbox-build injected into sw.js. */
export function precacheEntries(swJs) {
	return [...swJs.matchAll(/\{"revision":(null|"[0-9a-f]+"),"url":"([^"]+)"\}/g)].map((match) => ({
		revision: match[1] === "null" ? null : JSON.parse(match[1]),
		url: match[2],
	}));
}

function checkUrl(url, where, problems) {
	if (/^(data:|https?:\/\/|\/\/)/.test(url)) return;
	if (!url.startsWith("/")) {
		// "./x" resolves to /x from /xpos and to /xpos/x from /xpos/...: a different file per page.
		problems.push(`${where}: relative URL ${url} (make it absolute)`);
		return;
	}
	if (NO_STORE_ROUTES.includes(url)) return;
	if (url.startsWith("/assets/")) {
		if (!isVersioned(url)) problems.push(`${where}: fixed-name ${url} (content-name it or add ?v=)`);
		return;
	}
	problems.push(`${where}: ${url} is neither under /assets nor a no-store worker route`);
}

/**
 * Problems in a build, as messages; empty when the build is clean.
 * @param {{ rootFiles: string[], indexHtml: string, shellHtml?: string, swJs?: string, precache?: {url: string, revision: string|null}[], manifest: any }} build
 */
export function checkBuild(build) {
	const problems = [];

	for (const name of build.rootFiles) {
		if (!ROOT_FILES.some((pattern) => pattern.test(name))) {
			problems.push(`top level: ${name} is a fixed name under ${ASSET_PREFIX} (put it in assets/ via an import)`);
		}
	}

	const pages = [["index.html", build.indexHtml]];
	if (build.shellHtml !== undefined) pages.push(["offline shell", build.shellHtml]);
	for (const [page, html] of pages) {
		const manifestLinks = htmlReferences(html).filter((ref) => /rel=["']manifest["']/i.test(ref.tag));
		if (manifestLinks.length !== 1 || manifestLinks[0].url !== "/xpos/manifest.webmanifest") {
			problems.push(`${page}: needs exactly one <link rel="manifest" href="/xpos/manifest.webmanifest">, has ${JSON.stringify(manifestLinks.map((ref) => ref.url))}`);
		}
		for (const ref of htmlReferences(html)) checkUrl(ref.url, `${page} ${ref.tag}`, problems);
	}

	const precache = build.precache ?? precacheEntries(build.swJs ?? "");
	if (!precache.length) problems.push("sw.js: no precache manifest found");
	for (const entry of precache) {
		if (!entry.url.startsWith(ASSET_PREFIX)) {
			problems.push(`precache: ${entry.url} is not under ${ASSET_PREFIX} (a bare name resolves to /xpos/<name>, the logged-in till page)`);
		} else if (!isVersioned(entry.url)) {
			problems.push(`precache: fixed-name ${entry.url} (workbox fetches the plain URL; Cloudflare can answer with an older build's copy)`);
		}
	}

	for (const key of ["icons", "screenshots", "shortcuts"]) {
		for (const item of build.manifest?.[key] ?? []) {
			const src = item.src ?? item.url;
			if (!src || !src.startsWith(ASSET_PREFIX) || !isVersioned(src)) {
				problems.push(`manifest ${key}: ${src} must be an absolute, content-named URL under ${ASSET_PREFIX}`);
			}
		}
	}
	return problems;
}

/** Read a build directory into checkBuild's input. */
export function readBuild(outDir) {
	const rootFiles = readdirSync(outDir);
	const shell = rootFiles.find((name) => /^offline-shell-[0-9a-f]{12}\.html$/.test(name));
	return {
		rootFiles,
		indexHtml: readFileSync(resolve(outDir, "index.html"), "utf8"),
		shellHtml: shell ? readFileSync(resolve(outDir, shell), "utf8") : undefined,
		swJs: existsSync(resolve(outDir, "sw.js")) ? readFileSync(resolve(outDir, "sw.js"), "utf8") : "",
		manifest: JSON.parse(readFileSync(resolve(outDir, "manifest.webmanifest"), "utf8")),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../xpos/public/xpos"));
	const problems = checkBuild(readBuild(outDir));
	if (problems.length) {
		console.error(`asset names: ${problems.length} problem(s) in ${outDir} (MuleCity-68mo):`);
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log(`asset names: every file the till loads is content-named, versioned or no-store (${outDir})`);
}
