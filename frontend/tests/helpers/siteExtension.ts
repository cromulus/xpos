/**
 * A site with every till extension (the boot `xpos_site` map, server
 * xpos.api.site_hooks.site_map) for specs of the site features: customer mixes,
 * orders in flight, the manager override, help, item details, print brand, VFD.
 *
 * The method names are the first site's, so these specs keep asserting the exact
 * methods that site's till calls. XPOS itself never names them: they come only from
 * the boot. Specs without this helper run as a plain ERPNext site (no extensions).
 */
import { afterEach, beforeEach } from "vitest";
import { siteMapChanged } from "@/services/siteExtensions";

const PREFIX = "mulecity_erpnext";

export const SITE_FIXTURE = {
	tax_context: `${PREFIX}.pos_workspace.tax_context`,
	tax_contexts: `${PREFIX}.pos_workspace.tax_contexts`,
	find_orders: `${PREFIX}.pos_workspace.find_orders`,
	pickup_invoice: `${PREFIX}.pos_workspace.pickup_invoice`,
	mix: {
		find_mixes: `${PREFIX}.pos_workspace.find_mixes`,
		mix_details: `${PREFIX}.pos_workspace.mix_details`,
		desk_users: `${PREFIX}.counter_mix_orders.counter_desk_users`,
		send_to_desk: `${PREFIX}.counter_mix_orders.counter_send_to_desk`,
		check: `${PREFIX}.counter_mix_orders.counter_check`,
		quote: `${PREFIX}.counter_mix_orders.counter_quote`,
		checkout: `${PREFIX}.counter_mix_orders.counter_checkout`,
		validate_jobs: `${PREFIX}.mule_feed_formula.pull_jobs.validate_jobs`,
		job_status: `${PREFIX}.mule_feed_formula.pull_jobs.status`,
	},
	charge_override: {
		approvers: `${PREFIX}.credit_override.override_approvers`,
		sale: `${PREFIX}.credit_override.till_sale_with_override`,
	},
	item_details: `${PREFIX}.pos_product_context.product_details`,
	print_brand: `${PREFIX}.printouts.print_brand`,
	help: `${PREFIX}.in_app_help.get_help`,
	help_manual: "/manual/counter",
	vfd: {
		context: `${PREFIX}.vfd_offline.context`,
		prepare: `${PREFIX}.vfd_offline.prepare`,
		replay: `${PREFIX}.vfd_offline.replay`,
	},
	order_line_fields: [
		"mule_vfd", "mule_processing_instructions", "mule_stored_grain_use",
		"mule_stored_grain_use_lbs", "mule_bulk_no_bags", "mule_pull_remedy_json",
	],
	line_identity_fields: ["mule_vfd", "mule_processing_instructions"],
	customer_codes_field: "mule_filepro_alias_codes",
};

type Holder = { xpos?: { boot?: Record<string, unknown> } & Record<string, unknown> };

/** Put `map` in the boot now (window.xpos.boot.xpos_site), creating the boot if needed. */
export function installSiteExtension(map: Record<string, unknown> = SITE_FIXTURE): void {
	const holder = globalThis as unknown as Holder;
	holder.xpos = holder.xpos || {};
	holder.xpos.boot = holder.xpos.boot || {};
	holder.xpos.boot.xpos_site = map;
	// As sessionBoot.applyBoot does: reactive reads of the map re-evaluate.
	siteMapChanged();
}

/** Every test in this file runs on a site with the extensions (or `map`). */
export function useSiteExtension(map: Record<string, unknown> = SITE_FIXTURE): void {
	beforeEach(() => installSiteExtension(map));
	afterEach(() => {
		const boot = (globalThis as unknown as Holder).xpos?.boot;
		if (boot) delete boot.xpos_site;
		siteMapChanged();
	});
}
