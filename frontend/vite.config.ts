import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { fileURLToPath } from "url";
import { offlineShellPlugin } from "./scripts/offlineShell";
import { webManifestPlugin } from "./scripts/webManifest";
import { ASSET_PREFIX, OFFLINE_SHELL_GLOB } from "./sw/policy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
	base: "/xpos/",
	plugins: [
		vue(),
		offlineShellPlugin(),
		webManifestPlugin(),
		VitePWA({
			registerType: "autoUpdate",
			injectRegister: false,
			// The manifest and its icons come from scripts/webManifest.ts (MuleCity-68mo): content-named
			// icons, the manifest linked at /xpos/manifest.webmanifest (no-store). The plugin's own
			// manifest sat at a fixed /assets name and put bare icon names in the precache, which
			// resolved to /xpos/<name>: the logged-in till page.
			manifest: false,
			includeManifestIcons: false,
			devOptions: {
				enabled: false,
			},
			// Our own worker (sw/sw.ts) instead of a generated one: the generated navigation fallback
			// served index.html, which is never precached (Frappe renders it with the session), and
			// threw before any route registered (MuleCity-q8aq).
			strategies: "injectManifest",
			srcDir: "sw",
			filename: "sw.ts",
			injectManifest: {
				rollupFormat: "iife",
				// offline-shell-<hash>.html (no boot, no CSRF) is precached; index.html, the template
				// Frappe fills with the session's boot and token, never is.
				globPatterns: ["**/*.{js,css,svg,png,ico,woff,woff2,ttf,eot}", OFFLINE_SHELL_GLOB],
				globIgnores: ["**/index.html"],
				modifyURLPrefix: { "": ASSET_PREFIX },
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB
			},
		}),
	],
	css: {
		postcss: "./postcss.config.js",
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	server: {
		port: 5174,
		middlewareMode: false,
		proxy: {
			"/api": {
				target: "http://localhost:8000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, "/api"),
				configure: (proxy) => {
					proxy.on("proxyReq", (_proxyReq, req) => {
						console.log("Request:", req.method, req.url);
					});
				},
			},
			"/method": {
				target: "http://localhost:8000",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/method/, "/method"),
			},
			"/assets": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/files": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/upload_file": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/api/resource": {
				target: "http://localhost:8000",
				changeOrigin: true,
			},
			"/socket.io": {
				target: "http://localhost:9000",
				changeOrigin: true,
				ws: true,
				rewrite: (path) => path.replace(/^\/socket.io/, "/socket.io"),
			},
		},
	},
	optimizeDeps: {
		exclude: ["@vite/client", "@vite/env"],
	},
	build: {
		outDir: path.resolve(__dirname, "../xpos/public/xpos"),
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: path.resolve(__dirname, "index.html"),
			output: {
				manualChunks(id) {
					if (!id.includes("node_modules")) return;

					if (
						id.includes("node_modules/vue") ||
						id.includes("node_modules/vue-router") ||
						id.includes("node_modules/pinia")
					) {
						return "vendor-vue";
					}

					const parts = id.split("node_modules/")[1]?.split("/") || [];
					const pkgName = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
					if (pkgName) return `vendor-${pkgName.replace("/", "-")}`;
				},
			},
		},
	},
});
