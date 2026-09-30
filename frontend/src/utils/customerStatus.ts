/** The customer flags the status icons read (from xpos.api.customers search rows). */
export interface CustomerStatus {
	xpos_has_address?: boolean;
	/** How many places they take delivery (MuleCity-6nb1). */
	xpos_address_count?: number;
	xpos_has_email?: boolean;
	xpos_has_phone?: boolean;
}

export interface StatusDetail {
	key: "address" | "email" | "phone" | "tax";
	present: boolean;
	label: string;
	/** A count shown beside the icon (delivery locations, when more than one). */
	count?: number;
}

/**
 * The status icons for a customer, in display order. A flag the server did not
 * send is left out; tax exemption shows only when there is a reason.
 */
export function customerStatusDetails(
	customer: CustomerStatus | null | undefined,
	taxExemptReason: string | undefined,
	translate: (text: string, args?: string[]) => string,
): StatusDetail[] {
	const details: StatusDetail[] = [];
	if (customer && typeof customer.xpos_has_address === "boolean") {
		const count = customer.xpos_has_address ? customer.xpos_address_count || 1 : 0;
		details.push({
			key: "address",
			present: customer.xpos_has_address,
			label: !customer.xpos_has_address
				? translate("Address missing: no delivery")
				: count > 1
					? translate("{0} addresses on file: can take delivery", [String(count)])
					: translate("Address on file: can take delivery"),
			...(count > 1 ? { count } : {}),
		});
	}
	if (customer && typeof customer.xpos_has_email === "boolean")
		details.push({
			key: "email",
			present: customer.xpos_has_email,
			label: customer.xpos_has_email ? translate("Email on file") : translate("Email missing"),
		});
	if (customer && typeof customer.xpos_has_phone === "boolean")
		details.push({
			key: "phone",
			present: customer.xpos_has_phone,
			label: customer.xpos_has_phone ? translate("Phone on file") : translate("Phone missing"),
		});
	if (taxExemptReason)
		details.push({ key: "tax", present: true, label: translate("Tax exempt: {0}", [taxExemptReason]) });
	return details;
}
