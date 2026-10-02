/**
 * Build the till's static app shell (MuleCity-q8aq) from the built index.html.
 *
 * index.html is a Jinja template Frappe renders at /xpos with the session's boot and CSRF token
 * (xpos/www/xpos.html), so it is never precached. The shell is the same page with the boot script
 * replaced by a marker and every other placeholder filled with a literal: no boot, no token,
 * nothing per user. The service worker precaches it and serves it only for an /xpos navigation the
 * network could not answer; the page then starts from the last boot saved on the device
 * (src/services/sessionBoot.ts).
 */
import { createHash } from "crypto";
import type { Plugin } from "vite";
import { offlineShellFile } from "../sw/policy";

const BOOT_SCRIPT = /<script>\s*window\.xpos = window\.xpos \|\| \{\};\s*window\.xpos\.boot = \{\{ boot \| json \}\};[\s\S]*?<\/script>/;

const LITERALS: Record<string, string> = {
	"{{ lang }}": "en",
	"{{ layout_direction }}": "ltr",
	"{{ app_name }}": "X POS",
};

/** The shell for a built index.html; throws when anything per-session would remain in it. */
export function toOfflineShell(indexHtml: string): string {
	if (!BOOT_SCRIPT.test(indexHtml)) {
		throw new Error("offline shell: the boot script was not found in index.html");
	}
	let html = indexHtml.replace(
		BOOT_SCRIPT,
		"<script>\n\t\t\twindow.xpos = { offlineShell: true };\n\t\t</script>",
	);
	for (const [placeholder, literal] of Object.entries(LITERALS)) {
		html = html.split(placeholder).join(literal);
	}
	const leftover = /\{\{|\{%|csrf/i.exec(html);
	if (leftover) {
		throw new Error(`offline shell: "${leftover[0]}" left in the shell; it must carry no boot or token`);
	}
	return html;
}

/** Emit offline-shell-<content hash>.html next to index.html, for the service worker to precache. */
export function offlineShellPlugin(): Plugin {
	return {
		name: "xpos-offline-shell",
		apply: "build",
		enforce: "post",
		generateBundle(_options, bundle) {
			const index = bundle["index.html"];
			if (!index || index.type !== "asset") {
				this.error("offline shell: index.html is not in the bundle");
			}
			const shell = toOfflineShell(String(index.source));
			const hash = createHash("sha256").update(shell).digest("hex").slice(0, 12);
			this.emitFile({ type: "asset", fileName: offlineShellFile(hash), source: shell });
		},
	};
}
