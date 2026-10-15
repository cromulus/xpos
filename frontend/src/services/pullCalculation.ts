import { call } from "@/services/api";
import { isValidationRefusal } from "@/utils/refusals";
import __ from "@/lib/translate";

/** Native Frappe/RQ status polling. XPOS runs outside Desk, so it uses its
 * existing API client and modal, not frappe.dom or a second websocket client.
 * Pending responses intentionally contain no usable prices. */
export async function withPullCalculation<T>(
	method: string,
	data: string,
	current: () => boolean,
	busy: (value: boolean) => void,
): Promise<T> {
	let active = true;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(__("The calculation is taking longer than expected. Please retry."))), 60000);
	});
	const ensureCurrent = () => {
		if (!active || !current()) throw new Error(__("The order changed. Check the pull list again."));
	};
	const calculate = async () => {
		while (true) {
			ensureCurrent();
			const result = await call<T & { pending_jobs?: string[] }>(method, { data }, undefined, { answers: isValidationRefusal });
			ensureCurrent();
			if (!result?.pending_jobs?.length) return result;
			const keys = result.pending_jobs;
			while (true) {
				ensureCurrent();
				const state = await call<Record<string, string>>("mulecity_erpnext.mule_feed_formula.pull_jobs.status", { keys });
				ensureCurrent();
				if (keys.some(key => !state?.[key] || ["failed", "expired"].includes(state[key]))) {
					throw new Error(__("The pull calculation could not finish. Please retry."));
				}
				if (keys.every(key => state[key] === "ready")) break;
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
			// Re-price/validate current server inputs; never apply the worker's
			// snapshot directly. A changed recipe can require a new calculation.
		}
	};
	busy(true);
	try { return await Promise.race([calculate(), timeout]); }
	finally { active = false; clearTimeout(timer!); busy(false); }
}
