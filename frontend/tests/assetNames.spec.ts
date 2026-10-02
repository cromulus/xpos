/**
 * MuleCity-68mo: nothing the till loads may sit at a fixed name under /assets, which Frappe serves
 * with a one-year max-age and Cloudflare keeps. scripts/checkAssetNames.mjs runs after every
 * `yarn build`; these tests pin what it catches, with mc31's real build as the bad case.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { ASSET_PREFIX as CHECK_PREFIX, checkBuild, isVersioned, readBuild } from "../scripts/checkAssetNames.mjs";
import { MANIFEST_ROUTE, webManifest } from "../scripts/webManifest";
import { ASSET_PREFIX } from "../sw/policy";

const MC31 = resolve(__dirname, "fixtures/assetNames/mc31");
const mc31 = () => ({
	rootFiles: readFileSync(resolve(MC31, "root-files.txt"), "utf8").trim().split("\n"),
	indexHtml: readFileSync(resolve(MC31, "index.html"), "utf8"),
	precache: JSON.parse(readFileSync(resolve(MC31, "precache.json"), "utf8")),
	manifest: JSON.parse(readFileSync(resolve(MC31, "manifest.webmanifest"), "utf8")),
});

describe("which names count as content-named", () => {
	it("takes Vite's hash, the shell's hash and a version query", () => {
		expect(isVersioned("/assets/xpos/xpos/assets/index-sDFGewAf.js")).toBe(true);
		expect(isVersioned("/assets/xpos/xpos/assets/offlineDbStatus-C7-aCoAk.js")).toBe(true);
		expect(isVersioned("/assets/xpos/xpos/offline-shell-ad6317b44e7b.html")).toBe(true);
		expect(isVersioned("/assets/mulecity_erpnext/js/mule_print.js?v=bb9a91b3d698")).toBe(true);
	});

	it("refuses fixed names, including ones with dashes", () => {
		for (const url of [
			"/assets/xpos/xpos/manifest.webmanifest",
			"/assets/xpos/xpos/apple-touch-icon.svg",
			"/assets/xpos/xpos/pwa-192x192.svg",
			"/assets/xpos/xpos/offline-shell.html",
			"/assets/xpos/xpos/sw.js",
		]) {
			expect(isVersioned(url), url).toBe(false);
		}
	});

	it("uses the worker's asset prefix", () => {
		expect(CHECK_PREFIX).toBe(ASSET_PREFIX);
	});
});

describe("mc31's build (the bad case)", () => {
	const problems = checkBuild(mc31());

	it("is caught precaching bare names, which resolve to /xpos/<name>: the logged-in till page", () => {
		for (const name of ["apple-touch-icon.svg", "pwa-192x192.svg", "pwa-512x512.svg", "manifest.webmanifest"]) {
			expect(problems).toContain(
				`precache: ${name} is not under ${ASSET_PREFIX} (a bare name resolves to /xpos/<name>, the logged-in till page)`,
			);
		}
	});

	it("is caught linking a relative manifest and a fixed-name one under /assets", () => {
		expect(problems.some((p) => p.includes("relative URL ./manifest.webmanifest"))).toBe(true);
		expect(problems.some((p) => p.includes("fixed-name /assets/xpos/xpos/manifest.webmanifest"))).toBe(true);
		expect(problems.some((p) => p.includes("relative URL ./apple-touch-icon.svg"))).toBe(true);
	});

	it("is caught shipping fixed-name icons and relative manifest icons", () => {
		expect(problems).toContain(
			"top level: pwa-192x192.svg is a fixed name under /assets/xpos/xpos/ (put it in assets/ via an import)",
		);
		expect(problems.some((p) => p.startsWith("manifest icons: pwa-192x192.svg"))).toBe(true);
		expect(problems.some((p) => p.startsWith("precache: fixed-name /assets/xpos/xpos/pwa-192x192.svg"))).toBe(true);
	});

	it("is caught referencing a fixed-name logic file", () => {
		const build = mc31();
		build.indexHtml = build.indexHtml.replace(
			"/assets/xpos/xpos/assets/index-sDFGewAf.js",
			"/assets/xpos/xpos/assets/index.js",
		);
		build.precache = [{ url: "/assets/xpos/xpos/offline-shell.html", revision: "abc" }];
		const found = checkBuild(build);
		expect(found.some((p) => p.includes("fixed-name /assets/xpos/xpos/assets/index.js"))).toBe(true);
		expect(found.some((p) => p.includes("precache: fixed-name /assets/xpos/xpos/offline-shell.html"))).toBe(true);
	});
});

describe("the page and the manifest", () => {
	it("links the manifest at the worker route xpos/pwa.py serves with no-store, by absolute URL", () => {
		const template = readFileSync(resolve(__dirname, "../index.html"), "utf8");
		expect(MANIFEST_ROUTE).toBe("/xpos/manifest.webmanifest");
		expect([...template.matchAll(/<link rel="manifest" href="([^"]+)"/g)].map((m) => m[1])).toEqual([MANIFEST_ROUTE]);
		expect(template).not.toMatch(/href="\.\//);
	});

	it("gives every icon the URL the build gave it", () => {
		const manifest = webManifest((file) => `${ASSET_PREFIX}assets/${file.replace(".svg", "-AbCdEf12.svg")}`);
		expect(manifest.icons.map((icon) => icon.src)).toEqual([
			"/assets/xpos/xpos/assets/pwa-192x192-AbCdEf12.svg",
			"/assets/xpos/xpos/assets/pwa-512x512-AbCdEf12.svg",
			"/assets/xpos/xpos/assets/pwa-512x512-AbCdEf12.svg",
		]);
		expect(manifest.scope).toBe("/xpos");
		expect(manifest.start_url).toBe("/xpos");
	});
});

const BUILD = resolve(__dirname, "../../xpos/public/xpos");
const built = existsSync(resolve(BUILD, "sw.js")) && existsSync(resolve(BUILD, "manifest.webmanifest"));

describe.skipIf(!built)("the current build", () => {
	it("has no fixed-name file the till loads, and precaches only absolute /assets/xpos/xpos/ URLs", () => {
		expect(checkBuild(readBuild(BUILD))).toEqual([]);
	});
});
