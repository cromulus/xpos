import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { fileURLToPath } from "url";
import { offlineShellPlugin } from "./scripts/offlineShell";
import { ASSET_PREFIX, OFFLINE_SHELL_FILE } from "./sw/policy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
	base: "/xpos/",
	plugins: [
		vue(),
		offlineShellPlugin(),
		VitePWA({
			registerType: "autoUpdate",
			injectRegister: false,
			includeAssets: ["pwa-192x192.svg", "pwa-512x512.svg", "apple-touch-icon.svg"],
			manifest: {
				name: "X POS - Point of Sale",
				short_name: "X POS",
				description: "Modern Point of Sale application with offline support",
				theme_color: "#f97316",
				background_color: "#ffffff",
				display: "standalone",
				orientation: "any",
				// The worker's scope (MuleCity-q8aq): /xpos itself, as Frappe serves it.
				scope: "/xpos",
				start_url: "/xpos",
				id: "/xpos/",
				categories: ["business", "finance"],
				icons: [
					{
						src: "pwa-192x192.svg",
						sizes: "192x192",
						type: "image/svg+xml",
					},
					{
						src: "pwa-512x512.svg",
						sizes: "512x512",
						type: "image/svg+xml",
					},
					{
						src: "pwa-512x512.svg",
						sizes: "512x512",
						type: "image/svg+xml",
						purpose: "any maskable",
					},
				],
				screenshots: [
					{
						src: "pwa-512x512.svg",
						sizes: "512x512",
						type: "image/svg+xml",
						form_factor: "wide",
						label: "X POS Dashboard",
					},
					{
						src: "pwa-512x512.svg",
						sizes: "512x512",
						type: "image/svg+xml",
						form_factor: "narrow",
						label: "X POS Mobile",
					},
				],
			},
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
				// offline-shell.html (no boot, no CSRF) is precached; index.html, the template
				// Frappe fills with the session's boot and token, never is.
				globPatterns: ["**/*.{js,css,svg,png,ico,woff,woff2,ttf,eot}", OFFLINE_SHELL_FILE],
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
