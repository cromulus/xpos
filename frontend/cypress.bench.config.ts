import { defineConfig } from "cypress";
import loadEnv from "./scripts/loadEnv.mjs";

loadEnv();

/**
 * Specs that run against a real Frappe bench (not the stubbed dev server):
 * `yarn test:e2e:bench`. They log in, sell and read back real documents, so
 * they need a site with XPOS installed and the settings in tests/e2e/bench/README.md.
 */
export default defineConfig({
	e2e: {
		baseUrl: process.env.XPOS_BENCH_URL || "http://localhost:8000",
		env: {
			slowMo: Number(process.env.CYPRESS_SLOW_MO || 0),
			user: process.env.XPOS_BENCH_USER || "Administrator",
			password: process.env.XPOS_BENCH_PASSWORD || "",
			impersonate: process.env.XPOS_BENCH_IMPERSONATE || "",
			profile: process.env.XPOS_BENCH_PROFILE || "",
			company: process.env.XPOS_BENCH_COMPANY || "",
			item: process.env.XPOS_BENCH_ITEM || "",
			customer: process.env.XPOS_BENCH_CUSTOMER || "",
			secondMode: process.env.XPOS_BENCH_SECOND_MODE || "",
		},
		supportFile: "tests/e2e/support/bench.ts",
		specPattern: "tests/e2e/bench/**/*.cy.ts",
		screenshotsFolder: "tests/e2e/screenshots",
		video: false,
		viewportWidth: 1440,
		viewportHeight: 900,
		defaultCommandTimeout: 15000,
		retries: 0,
		setupNodeEvents() {},
	},
});
