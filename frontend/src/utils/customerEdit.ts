/**
 * Edit Customer saves only what the cashier changed (Mule City, nfxn.8).
 *
 * The form opens with the customer's phone and email, which for an imported
 * customer come from their Contact. Sending unchanged values back would copy
 * them onto the Customer itself; a blank field is left out, as it always was.
 */
export function changedFields<T extends Record<string, string>>(current: T, before: T): Partial<T> {
	const changed: Partial<T> = {};
	for (const key of Object.keys(current) as (keyof T)[]) {
		if (current[key] && current[key] !== before[key]) changed[key] = current[key];
	}
	return changed;
}
