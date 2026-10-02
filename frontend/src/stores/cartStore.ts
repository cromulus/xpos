import { prepareVfdPickup } from "@/services/vfdOffline";
import { newInvoiceId } from "@/services/invoiceSubmission";
import { muleOrderFields } from "@/services/muleOrderFields";
import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { call } from "@/services/api";
import { usePosStore } from "./posStore";
import { useSettingsStore } from "./settingsStore";
import {
	cacheTaxContext,
	getCachedCategoryTaxContext,
	getCachedItemByCode,
	getCachedStockForItem,
	getCachedTaxContext,
	getCustomer,
} from "@/services/dbBridge";
import type {
	CartItem,
	POSItem,
	InvoiceData,
	InvoiceItem,
	InvoiceChangeLeg,
	InvoicePayment,
	POSOffer,
	POSCoupon,
	CalculatedTax,
	DeliveryCharge,
	ReceiptSnapshot,
	OpenTab,
} from "@/types/pos.types";
import __ from "@/lib/translate";
import {
	evaluateOffers,
	computeGrandTotalDiscountPct,
	type OfferEvaluationResult,
} from "@/services/offerEngine";
import {
	resolveCartPricing,
	refreshPricingRuleSnapshot,
	type PricingSource,
	type ResolvedCartPricing,
} from "@/services/pricingService";
import type { CartPricingLine, FreeItemLine } from "@/services/pricingEngine";
import { nowDate, toDateOrNow } from "@/utils/datetime";
import { debounce, extractErrorMessage, isNetworkError, isOnline } from "@/utils";
import { hasPermission } from "@/services/userRights";
import {
	maxAdditionalDiscount as capAdditionalDiscount,
	maxLineDiscount as capLineDiscount,
	type CapLine,
	type DiscountKind,
} from "@/utils/discountCap";
import { lineDiscountFromPerUnit, perUnitDiscount } from "@/utils/lineDiscount";
import {
	TYPED_OFFLINE,
	isLocalAddress,
	fullAddress,
	type CustomerDelivery,
	type DeliveryAddress,
	type DeliveryMilesSource,
	type DeliveryPolicy,
	type DeliveryQuote,
} from "@/services/delivery";

let cartRowSeq = 0;

function nextRowId(): string {
	cartRowSeq += 1;
	return `row-${Date.now().toString(36)}-${cartRowSeq}`;
}

function parsePricingRules(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String);
	const raw = String(value).trim();
	if (!raw) return [];
	if (raw.startsWith("[")) {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function parseRuleName(value: unknown): string | undefined {
	return parsePricingRules(value)[0];
}

/** What ``xpos.api.invoices.preview_invoice`` returns, keyed to the cart it priced. */
interface ServerPreview {
	key: string;
	items: { item_code: string; item_name: string; description?: string; qty: number; uom: string; rate: number; amount: number; stored_grain?: number }[];
	taxes: { description: string; rate: number; tax_amount: number }[];
	net_total: number;
	grand_total: number;
	amount_due: number;
}

/**
 * What the Mule site's ``counter_mix_orders.counter_quote`` returns for a cart
 * holding made-to-order mixes, keyed to the cart it priced (Mule City,
 * MuleCity-3j1m): today's ticket and the orders, priced separately.
 */
interface CounterQuote {
	key: string;
	ticket_due: number;
	orders_total: number;
	orders: { item_code: string; qty: number; uom?: string; grand_total: number }[];
}

/** A cart's custom mixes are paid now (an advance on the order) or at pickup. */
export type MixPayMode = "now" | "pickup";

/** Stock quantities closer than this count as equal (9-place UOM factors). */
const STOCK_QTY_TOLERANCE = 1e-6;

/** Offline, and the till has no tax context for the buyer at all (MuleCity-ispl). */
class OfflineTaxMissing extends Error {}

/**
 * The buyer's tax context while offline (Mule City, MuleCity-ispl). Taxes depend
 * only on the customer's tax category, so the category the offline sync kept on
 * their customer row comes first: it is newer than a per-customer context kept
 * when this till last rang them up online (Brandy may have moved them from
 * Taxable to Farm since). The per-customer context is the fallback, for a row
 * synced before categories were. Null when neither is on this till.
 */
async function offlineTaxContext(profile: string, buyer: string, row: { tax_category?: string | null } | null): Promise<any | null> {
	const own = await getCachedTaxContext(profile, buyer);
	const synced = row && "tax_category" in row ? row : await getCustomer(buyer).catch(() => null);
	if (synced && "tax_category" in synced) {
		const byCategory = await getCachedCategoryTaxContext(profile, (synced as any).tax_category ?? "");
		if (byCategory) {
			// The site sends each category's exemption reason with it (it follows the
			// category one-to-one); an older sync without it falls back to this
			// customer's own reason when that was for the same category.
			const sameCategory = own && (own.tax_category ?? null) === (byCategory.tax_category ?? null);
			const reason = byCategory.tax_exempt_reason ?? (sameCategory ? own.tax_exempt_reason : null);
			return { ...byCategory, tax_exempt_reason: reason ?? null };
		}
	}
	return own;
}

export const useCartStore = defineStore("cart", () => {
	const posStore = usePosStore();
	const items = ref<CartItem[]>([]);
	const selectedCartIndex = ref(-1);
	const customer = ref<{
		name: string;
		customer_name?: string;
		image?: string;
		mobile_no?: string;
		email_id?: string;
		customer_group?: string;
		territory?: string;
		// What the status icons show (from the customer search row).
		xpos_has_address?: boolean;
		xpos_has_email?: boolean;
		xpos_has_phone?: boolean;
		xpos_address_count?: number;
		// The site's delivery details, for pricing a delivery offline (MuleCity-6nb1).
		xpos_delivery?: CustomerDelivery;
		// ERPNext's Tax Category, on synced rows (offline taxes, MuleCity-ispl).
		tax_category?: string | null;
	} | null>(null);
	const discountPercentage = ref(0);
	const discountAmount = ref(0);
	const showPaymentDialog = ref(false);
  const muleTaxPending = ref(false);
  const muleTaxError = ref("");
  const muleTaxCategory = ref("");
  // Why the buyer is tax-exempt (Mule City), for the counter's customer bar.
  const muleTaxExemptReason = ref("");
  let muleTaxRequest = 0;
  watch(() => [customer.value?.name, posStore.profileName], async ([buyer, profile]) => {
    if (!buyer || !profile) return;
    const request = ++muleTaxRequest;
    muleTaxPending.value = true;
    muleTaxError.value = "";
    muleTaxExemptReason.value = "";
    showPaymentDialog.value = false;
    try {
      // The context comes from the server when it can be reached, and is kept per
      // customer so a later cart for them is taxed the same while offline.
      let context: any;
      try {
        context = await call<any>("mulecity_erpnext.pos_workspace.tax_context", {customer: buyer, pos_profile: profile});
        cacheTaxContext(String(profile), String(buyer), context).catch(() => {});
      } catch (error) {
        const offline = !isOnline() || isNetworkError(error);
        context = offline ? await offlineTaxContext(String(profile), String(buyer), customer.value) : null;
        if (!context) throw offline ? new OfflineTaxMissing() : error;
      }
      const offlineContext = !isOnline();
      if (request !== muleTaxRequest) return;
      posStore.taxes = context.taxes;
      muleTaxCategory.value = context.tax_category || "";
      muleTaxExemptReason.value = context.tax_exempt_reason || "";
      // A customer's item overrides must not survive a buyer change.
      // Offline, the items keep the templates they were added with.
      for (const item of offlineContext ? [] : items.value) {
        const tax = await call<any>("xpos.api.taxes.get_item_tax_template", {item_code: item.item_code, company: posStore.companyName, tax_category: muleTaxCategory.value});
        if (request !== muleTaxRequest) return;
        item.item_tax_template = tax.item_tax_template || undefined;
        item.item_tax_map = tax.item_tax_map || {};
      }
    } catch (error) {
      if (request === muleTaxRequest) {
        muleTaxError.value = error instanceof OfflineTaxMissing
          ? "No tax information for this customer on this till yet. Go online once, or ring them up at the desk."
          : "Tax lookup failed. Reselect the customer to retry before taking payment.";
      }
    } finally { if (request === muleTaxRequest) muleTaxPending.value = false; }
  });

	// Server-priced ticket (MuleCity-9f4). Save-time rules can change a cart after the
	// register priced it (a grain depositor's own grain goes on a $0 line), so before
	// payment the server builds the ticket save would post and the register charges
	// that. It is kept only while the cart is unchanged (same key).
	const serverPreview = ref<ServerPreview | null>(null);
	// Custom mixes ordered at the counter (Mule City, MuleCity-3j1m).
	const pickupDate = ref("");
	const mixPayMode = ref<MixPayMode>("now");
	const counterQuote = ref<CounterQuote | null>(null);
	// Declared before anything reads the cart's invoice data (the preview key does).
	let invoiceLocalId = "";
	const serverPreviewPending = ref(false);
	const serverPreviewError = ref("");

	const isReturnMode = ref(false);
	const returnAgainst = ref("");
	const returnItemCodes = ref<string[]>([]);
	const orderNotes = ref("");
	const deliveryDate = ref("");
	const postingDate = ref(nowDate());
	const writeOffAmount = ref(0);
	const salesPerson = ref("");
	const redeemLoyaltyPoints = ref(false);
	const loyaltyPoints = ref(0);
	const loyaltyAmount = ref(0);
	const appliedOffers = ref<POSOffer[]>([]);
	const appliedCoupon = ref<POSCoupon | null>(null);
	const couponCode = ref("");
	const payments = ref<InvoicePayment[]>([]);
	const changeLegs = ref<InvoiceChangeLeg[]>([]);
	const changeAmount = ref(0);
	const currentDraftName = ref("");
	const currentDraftModified = ref("");
	const isSavingDraft = ref(false);
	const showDraftDialog = ref(false);
	const isLoadingDrafts = ref(false);
	const currency = ref("");
	const conversionRate = ref(1);
	const selectedDeliveryCharge = ref<DeliveryCharge | null>(null);
	// A quoted delivery (MuleCity-6nb1): where it goes, and the quote its line was priced from.
	const shippingAddress = ref<DeliveryAddress | null>(null);
	const deliveryQuote = ref<DeliveryQuote | null>(null);
	// The delivery line's item, and whether its miles were the Address's or typed (MuleCity-qajl).
	const deliveryItemCode = ref("");
	const deliveryMilesSource = ref<DeliveryMilesSource | null>(null);
	/** The quoted delivery, while its line is still in the cart (removing the line drops it). */
	const activeDelivery = computed(() => {
		const address = shippingAddress.value;
		if (!address) return null;
		if (deliveryItemCode.value && !items.value.some((i) => i.item_code === deliveryItemCode.value)) return null;
		const miles = deliveryQuote.value?.miles ?? address.miles ?? null;
		return { address, quote: deliveryQuote.value, miles: miles && miles > 0 ? miles : null, milesSource: deliveryMilesSource.value };
	});
	const settingsStore = useSettingsStore();

	const ruleDiscountPercentage = ref(0);
	const ruleDiscountAmount = ref(0);
	// A transaction Pricing Rule's apply_discount_on wins while its discount stands;
	// otherwise the POS Profile's, as ERPNext sets it on the invoice.
	const ruleDiscountOn = ref("");
	const applyDiscountOn = computed(
		() => ruleDiscountOn.value || posStore.posProfile?.apply_discount_on || "Grand Total",
	);

	/** The additional discount taken off the net before tax ("Net Total"), else 0. */
	const netTotalDiscount = computed(() => {
		if (applyDiscountOn.value !== "Net Total") return 0;
		if (discountPercentage.value > 0) return Math.round(subtotal.value * discountPercentage.value) / 100;
		return discountAmount.value > 0 ? discountAmount.value : 0;
	});
	const isPricingCart = ref(false);
	const pricingSource = ref<PricingSource>("server");

	// The invoice line's rate precision, so a cart rate is the rate the price lock
	// posts (a $23.47 35 lb bag is $0.670571439/lb at 9 places, not $0.671).
	const itemRatePrecision = computed(() => {
		const precision = settingsStore.currencyPrecision;
		for (const value of [precision?.item_rate_precision, precision?.float_precision]) {
			const val = parseInt(String(value ?? ""), 10);
			if (Number.isFinite(val) && val >= 0) return val;
		}
		return 3;
	});

	function normalizeItemRate(rate: number | string): number {
		const parsed = Number(rate || 0);
		if (!Number.isFinite(parsed)) {
			return 0;
		}
		const p = itemRatePrecision.value;
		return Math.round((parsed + Number.EPSILON) * 10 ** p) / 10 ** p;
	}

	const offerEvaluation = computed<OfferEvaluationResult>(() => {
		return evaluateOffers(appliedOffers.value, items.value);
	});

	const offerItemDiscountTotal = computed(() => {
		const eval_ = offerEvaluation.value;
		if (!eval_.itemDiscounts.length) return 0;

		let total = 0;
		for (const disc of eval_.itemDiscounts) {
			const item = items.value.find((i) => i.item_code === disc.item_code);
			if (!item) continue;
			const lineAmt = Math.abs(item.qty) * item.rate;
			if (disc.fixed_rate !== null) {
				total += Math.max(0, lineAmt - Math.abs(item.qty) * disc.fixed_rate);
			} else if (disc.discount_percentage > 0) {
				total += (lineAmt * disc.discount_percentage) / 100;
			} else if (disc.discount_amount > 0) {
				total += disc.discount_amount * Math.abs(item.qty);
			}
		}
		return Math.round(total * 100) / 100;
	});

	const offerGrandTotalDiscountPct = computed(() =>
		computeGrandTotalDiscountPct(offerEvaluation.value.grandTotalDiscounts),
	);

	const itemCount = computed(() =>
		items.value.reduce((sum: number, item: CartItem) => sum + Math.abs(item.qty), 0),
	);

	const subtotal = computed(() =>
		items.value.reduce((sum: number, item: CartItem) => {
			const itemTotal = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (itemTotal * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			return sum + (itemTotal - discount);
		}, 0),
	);

	const calculatedTaxes = computed(() => {
		const posStore = usePosStore();
		const taxDetails = posStore.taxes || [];
		const taxInclusive = posStore.taxInclusiveMode;

		const itemNets: { net: number; taxMap: Record<string, number> | undefined }[] = [];
		for (const item of items.value) {
			const itemTotal = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (itemTotal * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			itemNets.push({
				net: itemTotal - discount,
				taxMap: item.item_tax_map,
			});
		}

		if (itemNets.length === 0) return [];

		// On "Net Total" ERPNext spreads the discount over the lines by their net
		// (rounded to the cent, the last line taking the remainder), then taxes them.
		const discount = netTotalDiscount.value;
		if (discount && subtotal.value) {
			let remaining = discount;
			itemNets.forEach((line, i) => {
				const share =
					i === itemNets.length - 1
						? remaining
						: Math.round((discount * line.net * 100) / subtotal.value) / 100;
				line.net -= share;
				remaining -= share;
			});
		}

		const result: CalculatedTax[] = [];

		for (const tax of taxDetails) {
			const isIncluded = tax.included_in_print_rate === 1;
			let totalTaxAmount = 0;

			for (const { net, taxMap } of itemNets) {
				let effectiveRate = tax.rate;
				if (taxMap && tax.account_head in taxMap) {
					effectiveRate = taxMap[tax.account_head];
				}

				if (tax.charge_type === "On Net Total") {
					if (taxInclusive && isIncluded) {
						totalTaxAmount += (net * effectiveRate) / (100 + effectiveRate);
					} else if (!isIncluded) {
						totalTaxAmount += (net * effectiveRate) / 100;
					}
				}
			}

			if (tax.charge_type === "Actual") {
				totalTaxAmount = tax.rate;
			}

			if (totalTaxAmount !== 0) {
				result.push({
					description: tax.description || "Tax",
					rate: tax.rate,
					amount: Math.round(totalTaxAmount * 100) / 100,
					included_in_print_rate: isIncluded,
				});
			}
		}

		const profileAccountHeads = new Set(taxDetails.map((t) => t.account_head));
		const extraTaxAccounts: Map<string, number> = new Map();

		for (const { net, taxMap } of itemNets) {
			if (!taxMap) continue;
			for (const [accountHead, rate] of Object.entries(taxMap)) {
				if (profileAccountHeads.has(accountHead)) continue;
				const taxAmount = (net * rate) / 100;
				extraTaxAccounts.set(accountHead, (extraTaxAccounts.get(accountHead) || 0) + taxAmount);
			}
		}

		for (const [accountHead, amount] of extraTaxAccounts) {
			if (amount !== 0) {
				const desc = accountHead.split(" - ")[0] || "Tax";
				result.push({
					description: desc,
					rate: 0,
					amount: Math.round(amount * 100) / 100,
					included_in_print_rate: false,
				});
			}
		}

		return result;
	});

	const taxAmount = computed(() => {
		return calculatedTaxes.value
			.filter((t) => !t.included_in_print_rate)
			.reduce((sum, t) => sum + t.amount, 0);
	});

	const includedTaxAmount = computed(() => {
		return calculatedTaxes.value
			.filter((t) => t.included_in_print_rate)
			.reduce((sum, t) => sum + t.amount, 0);
	});

	const totalTaxAmount = computed(() => {
		return calculatedTaxes.value.reduce((sum, t) => sum + t.amount, 0);
	});

	const previewKey = computed(() => JSON.stringify(previewPayload()));

	const grandTotal = computed(() => {
		const posStore = usePosStore();
		// A cart with custom mix orders: today's ticket, plus the orders when paid now.
		if (counterQuote.value && counterQuote.value.key === previewKey.value) {
			return counterQuote.value.ticket_due + (mixPayMode.value === "now" ? counterQuote.value.orders_total : 0);
		}
		if (serverPreview.value && serverPreview.value.key === previewKey.value) {
			// The same settlements the cart's own total takes off below.
			let due = serverPreview.value.amount_due;
			if (!isReturnMode.value && redeemLoyaltyPoints.value && loyaltyAmount.value > 0) due -= loyaltyAmount.value;
			if (!isReturnMode.value && writeOffAmount.value > 0) due -= writeOffAmount.value;
			return due;
		}
		let total = subtotal.value - netTotalDiscount.value + taxAmount.value;

		// Apply offer item-level discounts
		if (offerItemDiscountTotal.value > 0) {
			total -= offerItemDiscountTotal.value;
		}

		// Apply offer grand total discounts
		if (offerGrandTotalDiscountPct.value > 0) {
			total -= (total * offerGrandTotalDiscountPct.value) / 100;
		}

		// On "Net Total" the discount already came off the net, before tax.
		if (applyDiscountOn.value !== "Net Total") {
			if (discountPercentage.value > 0) {
				total -= (total * discountPercentage.value) / 100;
			} else if (discountAmount.value > 0) {
				total -= discountAmount.value;
			}
		}
		if (!isReturnMode.value && redeemLoyaltyPoints.value && loyaltyAmount.value > 0) {
			total -= loyaltyAmount.value;
		}
		if (!isReturnMode.value && writeOffAmount.value > 0) {
			total -= writeOffAmount.value;
		}
		if (!isReturnMode.value && selectedDeliveryCharge.value) {
			total += selectedDeliveryCharge.value.rate || 0;
		}
		total = isReturnMode.value ? total : Math.max(0, total);
		if (!posStore.disableRoundedTotal && total !== 0) {
			total = Math.round(total);
		}
		return total;
	});

	const isEmpty = computed(() => items.value.length === 0);

	const customerName = computed(() => {
		if (!customer.value) return "Walk-in Customer";
		return customer.value.customer_name || customer.value.name;
	});

	const totalPayments = computed(() => payments.value.reduce((sum, p) => sum + (p.amount || 0), 0));

	const remainingPayment = computed(() => Math.max(0, grandTotal.value - totalPayments.value));

	const hasOffers = computed(() => appliedOffers.value.length > 0 || !!appliedCoupon.value);

	function stockQtyOf(row: { qty: number; conversion_factor?: number }): number {
		return row.qty * (row.conversion_factor || 1);
	}

	function getStockReservations(): { item_code: string; stock_qty: number }[] {
		const totals = new Map<string, number>();

		for (const row of items.value) {
			if (Number(row.is_stock_item) === 0) continue;
			totals.set(row.item_code, (totals.get(row.item_code) || 0) + stockQtyOf(row));
		}

		return [...totals.entries()]
			.filter(([, stock_qty]) => stock_qty !== 0)
			.map(([item_code, stock_qty]) => ({ item_code, stock_qty }));
	}

	function committedStockQty(itemCode: string, batchNo?: string): number {
		return items.value
			.filter((i: CartItem) => {
				if (i.item_code !== itemCode) return false;
				return batchNo ? i.batch_no === batchNo : true;
			})
			.reduce((sum: number, i: CartItem) => sum + stockQtyOf(i), 0);
	}

	function checkAvailability(
		item: POSItem,
		requestedQty: number,
		conversionFactor = 1,
		batchNo?: string,
		replacesRowQty = 0,
	): { allowed: boolean; message?: string } {
		const posStore = usePosStore();

		if (posStore.stockSettings?.allow_negative_stock) {
			return { allowed: true };
		}
		if (!posStore.blockSaleBeyondAvailableQty) {
			return { allowed: true };
		}
		if (Number(item.is_stock_item) === 0) {
			return { allowed: true };
		}
		// Made to order: the mill makes it for this sale, so it has no stock yet.
		if (Number(item.is_made_to_order) === 1) {
			return { allowed: true };
		}

		// actual_qty is in the stock unit.
		const uomLabel = item.stock_uom || item.uom;
		const actualQty = item.actual_qty ?? 0;
		if (actualQty <= 0) {
			return { allowed: false, message: __("{0} is out of stock", [item.item_name]) };
		}

		// Conversion factors carry 9 places (Pound = 0.028571429 Bag), so 35 lb of
		// a 35 lb bag is 1.000000015 bags; ERPNext rounds stock quantities, so
		// this check must not refuse the last bag over that dust.
		const requestedStockQty = requestedQty * (conversionFactor || 1) - STOCK_QTY_TOLERANCE;

		if (batchNo) {
			const batchQty = getBatchQty(item, batchNo);
			if (batchQty !== undefined) {
				const committedInBatch = committedStockQty(item.item_code, batchNo) - replacesRowQty;
				if (committedInBatch + requestedStockQty > batchQty) {
					return {
						allowed: false,
						message: __("Only {0} of batch {1} available", [String(batchQty), batchNo]),
					};
				}
			}
		}

		const committed = committedStockQty(item.item_code) - replacesRowQty;
		if (committed + requestedStockQty > actualQty) {
			return {
				allowed: false,
				message: __("Only {0} {1} of {2} available", [String(actualQty), uomLabel, item.item_name]),
			};
		}

		return { allowed: true };
	}

	function getBatchQty(item: POSItem, batchNo: string): number | undefined {
		const batches = item.batches as { batch_no: string; qty: number }[] | undefined;
		return batches?.find((b) => b.batch_no === batchNo)?.qty;
	}

	/**
	 * Lines the mill still has to make: a made-to-order mix whose quantity is more
	 * than the made bags on hand. Pay turns the rest into an order (the server
	 * decides the exact split, leaving out bags reserved for other orders).
	 */
	const orderLineUids = computed(
		() =>
			new Set(
				items.value
					.filter(
						(item: CartItem) =>
							Number(item.is_made_to_order) === 1 &&
							!(item as any).so_detail &&
							item.qty * (item.conversion_factor || 1) > Math.max(item.actual_qty ?? 0, 0) + STOCK_QTY_TOLERANCE,
					)
					.map((item: CartItem) => item.uid),
			),
	);
	const hasOrderLines = computed(() => !isReturnMode.value && orderLineUids.value.size > 0);
	function isOrderLine(uid: string | undefined): boolean {
		return !!uid && orderLineUids.value.has(uid);
	}

	function canAddItem(item: POSItem): { allowed: boolean; message?: string } {
		return checkAvailability(item, 1, (item as CartItem).conversion_factor || 1, item.batch_no);
	}

	async function revalidateStock(): Promise<{ valid: boolean; messages: string[] }> {
		const posStore = usePosStore();

		if (posStore.stockSettings?.allow_negative_stock || !posStore.blockSaleBeyondAvailableQty) {
			return { valid: true, messages: [] };
		}
		if (isReturnMode.value) {
			return { valid: true, messages: [] };
		}

		const stockItems = items.value.filter(
			(i: CartItem) => Number(i.is_stock_item) !== 0 && Number(i.is_made_to_order) !== 1,
		);
		if (stockItems.length === 0) {
			return { valid: true, messages: [] };
		}

		const warehouse = posStore.warehouse;
		if (!warehouse) {
			return { valid: true, messages: [] };
		}

		const itemCodes = [...new Set(stockItems.map((i: CartItem) => i.item_code))];
		const freshMap = await fetchAvailability(itemCodes, warehouse, posStore.profileName);

		if (freshMap.size === 0) {
			return { valid: true, messages: [] };
		}

		for (const row of items.value) {
			const qty = freshMap.get(row.item_code);
			if (qty !== undefined) row.actual_qty = qty;
		}

		const messages: string[] = [];
		for (const [itemCode, available] of freshMap) {
			const required = committedStockQty(itemCode);
			if (required > available) {
				const row = stockItems.find((i: CartItem) => i.item_code === itemCode);
				messages.push(
					__("Only {0} {1} of {2} available", [
						String(available),
						row?.stock_uom || "",
						row?.item_name || itemCode,
					]),
				);
			}
		}

		return { valid: messages.length === 0, messages };
	}

	async function fetchAvailability(
		itemCodes: string[],
		warehouse: string,
		posProfile: string,
	): Promise<Map<string, number>> {
		try {
			const fresh = await call<{ item_code: string; actual_qty: number }[]>(
				"xpos.api.items.get_stock_availability",
				{
					items: JSON.stringify(itemCodes),
					warehouse,
					pos_profile: posProfile || undefined,
				},
			);
			if (fresh?.length) {
				return new Map(fresh.map((s) => [s.item_code, s.actual_qty || 0]));
			}
		} catch {}

		const cached = new Map<string, number>();
		for (const itemCode of itemCodes) {
			try {
				const entry = await getCachedStockForItem(warehouse, itemCode);
				if (entry) cached.set(itemCode, entry.actual_qty);
			} catch {}
		}
		return cached;
	}

	function addItem(item: POSItem): { success: boolean; message?: string } {
		if (
			isReturnMode.value &&
			returnItemCodes.value.length > 0 &&
			!returnItemCodes.value.includes(item.item_code)
		) {
			return { success: false, message: __("This item is not in the original invoice") };
		}

		const stockCheck = canAddItem(item);
		if (!stockCheck.allowed && !isReturnMode.value) {
			return { success: false, message: stockCheck.message };
		}

		// Same item in the same unit only: a Bag tap must not add 1 lb to a Pound line.
		const existing = items.value.find(
			(i: CartItem) =>
				i.item_code === item.item_code &&
				i.uom === (item.uom || item.stock_uom) &&
				// Separate source rows keep their own agreed price and recipe.
				["sales_order", "so_detail", "bom_no", "mule_vfd", "mule_processing_instructions"].every(
					field => ((i as any)[field] || "") === ((item as any)[field] || ""),
				) &&
				!i.serial_no &&
				!i.batch_no,
		);

		if (existing) {
			existing.qty += isReturnMode.value ? -1 : 1;
		} else {
			items.value.push({
                ...muleOrderFields(item),
				uid: nextRowId(),
				item_code: item.item_code,
				item_name: item.item_name,
				local_item_name: item.local_item_name,
				rate: normalizeItemRate(item.rate || 0),
				qty: isReturnMode.value ? -1 : 1,
				uom: item.uom || item.stock_uom,
				stock_uom: item.stock_uom,
				image: item.image,
				discount_percentage: 0,
				discount_amount: 0,
				serial_no: item.serial_no || "",
				batch_no: item.batch_no || "",
				actual_qty: item.actual_qty || 0,
				is_stock_item: item.is_stock_item,
				is_made_to_order: item.is_made_to_order,
				has_serial_no: item.has_serial_no,
				has_batch_no: item.has_batch_no,
				conversion_factor: (item as CartItem).conversion_factor || 1,
				item_group: item.item_group,
				brand: item.brand,
				variant_of: item.variant_of,
			});
		}

		return { success: true };
	}

	function canAddItemWithDetails(
		item: POSItem,
		qty: number,
		batchNo?: string,
		conversionFactor = 1,
	): { allowed: boolean; message?: string } {
		return checkAvailability(item, qty, conversionFactor, batchNo);
	}

	function addItemWithDetails(
		item: POSItem,
		qty: number,
		rate: number,
		uom?: string,
		serialNo?: string,
		batchNo?: string,
		conversionFactor?: number,
	): { success: boolean; message?: string } {
		if (
			isReturnMode.value &&
			returnItemCodes.value.length > 0 &&
			!returnItemCodes.value.includes(item.item_code)
		) {
			return { success: false, message: __("This item is not in the original invoice") };
		}

		if (!isReturnMode.value) {
			const stockCheck = canAddItemWithDetails(item, qty, batchNo, conversionFactor || 1);
			if (!stockCheck.allowed) {
				return { success: false, message: stockCheck.message };
			}
		}

		if (!serialNo) {
			const existing = items.value.find(
				(i: CartItem) =>
					i.item_code === item.item_code &&
					!i.serial_no &&
					i.uom === (uom || item.uom || item.stock_uom) &&
					i.batch_no === (batchNo || ""),
			);
			if (existing) {
				const addQty = isReturnMode.value ? -Math.abs(qty) : qty;
				existing.qty += addQty;
				if (rate) existing.rate = normalizeItemRate(rate);
				return { success: true };
			}
		}

		items.value.push({
			uid: nextRowId(),
			item_code: item.item_code,
			item_name: item.item_name,
			local_item_name: item.local_item_name,
			rate: normalizeItemRate(rate),
			qty: isReturnMode.value ? -Math.abs(qty) : qty,
			uom: uom || item.uom || item.stock_uom,
			stock_uom: item.stock_uom,
			image: item.image,
			discount_percentage: 0,
			discount_amount: 0,
			serial_no: serialNo || "",
			batch_no: batchNo || "",
			actual_qty: item.actual_qty || 0,
			is_stock_item: item.is_stock_item,
			is_made_to_order: item.is_made_to_order,
			has_serial_no: item.has_serial_no,
			has_batch_no: item.has_batch_no,
			conversion_factor: conversionFactor || 1,
			item_group: item.item_group,
			brand: item.brand,
			variant_of: item.variant_of,
		});

		return { success: true };
	}

	function removeItem(index: number): void {
		if (index < 0 || index >= items.value.length) return;
		items.value.splice(index, 1);
		if (items.value.length === 0) {
			selectedCartIndex.value = -1;
		} else if (selectedCartIndex.value > index) {
			selectedCartIndex.value -= 1;
		} else if (selectedCartIndex.value === index) {
			selectedCartIndex.value = Math.min(index, items.value.length - 1);
		}
		syncFreeItems();
	}

	function setSelectedCartIndex(index: number): void {
		selectedCartIndex.value = index;
	}

	function updateItemQty(index: number, qty: number): { success: boolean; message?: string } {
		if (qty === 0) {
			removeItem(index);
			return { success: true };
		}

		const item = items.value[index];
		if (!item) return { success: false, message: __("Item not found") };

		if (!isReturnMode.value && qty > item.qty) {
			const stockCheck = checkAvailability(
				item,
				qty,
				item.conversion_factor || 1,
				item.batch_no || undefined,
				stockQtyOf(item),
			);
			if (!stockCheck.allowed) {
				return { success: false, message: stockCheck.message };
			}
		}

		items.value[index].qty = qty;
		syncFreeItems();
		return { success: true };
	}

	function updateItemRate(index: number, rate: number): void {
		items.value[index].rate = normalizeItemRate(rate);
		items.value[index].pos_rate_overridden = true;
	}

	/**
	 * Whether the counter's discount cap (POS Profile
	 * ``max_discount_percentage_allowed``) holds this cart: not for a return,
	 * and not for a POS Role that may change the price. The server applies the
	 * same exemptions (``check_discount_cap``).
	 */
	const discountCapActive = computed(
		() => !isReturnMode.value && posStore.maxDiscountAllowed > 0 && !hasPermission("allow_change_price"),
	);

	/** The capped lines (free items excluded), and each one's index in the cart. */
	function capLines(): { lines: CapLine[]; cartIndexes: number[] } {
		const lines: CapLine[] = [];
		const cartIndexes: number[] = [];
		items.value.forEach((item, index) => {
			if (item.pos_is_free_item) return;
			lines.push({
				qty: item.qty,
				rate: item.rate,
				ruleRate: item.pos_rule_rate ?? item.rate,
				discountPercentage: item.discount_percentage || 0,
				discountAmount: item.discount_amount || 0,
			});
			cartIndexes.push(index);
		});
		return { lines, cartIndexes };
	}

	/** The largest discount line ``index`` may take under the cap, or null when uncapped. */
	function maxLineDiscount(index: number, type: DiscountKind): number | null {
		if (!discountCapActive.value) return null;
		const { lines, cartIndexes } = capLines();
		const capIndex = cartIndexes.indexOf(index);
		if (capIndex < 0) return null;
		return capLineDiscount(
			lines,
			capIndex,
			type,
			{ percentage: discountPercentage.value, amount: discountAmount.value },
			posStore.maxDiscountAllowed,
		);
	}

	/** The largest additional (whole-ticket) discount under the cap, or null when uncapped. */
	function maxAdditionalDiscount(type: DiscountKind): number | null {
		if (!discountCapActive.value) return null;
		return capAdditionalDiscount(capLines().lines, type, posStore.maxDiscountAllowed);
	}

	/** Set a line discount, held to the cap; returns the value applied. */
	function updateItemDiscount(index: number, type: DiscountKind, value: number): number {
		const max = maxLineDiscount(index, type);
		const applied = max !== null && value > max ? max : value;
		if (type === "percentage") {
			items.value[index].discount_percentage = applied;
			items.value[index].discount_amount = 0;
		} else {
			items.value[index].discount_amount = applied;
			items.value[index].discount_percentage = 0;
		}
		items.value[index].pos_pricing_rules = [];
		return applied;
	}

	/**
	 * Switch a cart line to another unit of its Item, e.g. a Bag line to Pound
	 * (MuleCity-mxwy.8: any bag sells by the pound at bag price ÷ bag weight).
	 *
	 * The quantity stays as typed; its stock quantity follows the new factor and
	 * is checked against stock like any other change. The rate is the server's
	 * price for the new unit (``get_sale_unit``), the rate the invoice price lock
	 * will post. A manually changed rate, or no connection, keeps the same price
	 * per stock unit instead (rate ÷ old factor × new factor). A line discount in
	 * money was given for the old unit and quantity, so it is dropped rather than
	 * carried to a unit of another size; the pricing rules are re-applied for the new unit.
	 */
	async function changeItemUOM(
		index: number,
		unit: { uom: string; conversion_factor: number },
	): Promise<{ success: boolean; message?: string }> {
		const item = items.value[index];
		if (!item) return { success: false, message: __("Item not found") };
		if ((item.uom || item.stock_uom) === unit.uom) return { success: true };

		let factor = unit.conversion_factor || 1;
		let rate = (item.rate / (item.conversion_factor || 1)) * factor;
		if (!item.pos_rate_overridden) {
			try {
				const priced = await call<{ uom: string; conversion_factor: number; rate: number }>(
					"xpos.api.items.get_sale_unit",
					{
						item_code: item.item_code,
						pos_profile: posStore.profileName,
						uom: unit.uom,
						customer: customer.value?.name || "",
					},
				);
				if (priced?.conversion_factor) factor = priced.conversion_factor;
				if (priced && priced.rate) rate = priced.rate;
			} catch (error) {
				// Offline: keep the price per stock unit; a refusal (not a unit of
				// the Item) stops the switch.
				if (!isNetworkError(error)) return { success: false, message: extractErrorMessage(error) };
			}
		}
		// The line may have been removed while the price was fetched.
		if (!items.value.includes(item)) return { success: false, message: __("Item not found") };

		if (!isReturnMode.value) {
			const stockCheck = checkAvailability(
				item,
				item.qty,
				factor,
				item.batch_no || undefined,
				stockQtyOf(item),
			);
			if (!stockCheck.allowed) return { success: false, message: stockCheck.message };
		}

		item.uom = unit.uom;
		item.conversion_factor = factor;
		item.rate = normalizeItemRate(rate);
		if (!item.discount_percentage) item.discount_amount = 0;
		item.pos_pricing_rules = [];
		item.pos_rule_rate = undefined;
		syncFreeItems();
		return { success: true };
	}

	function updateItemNotes(index: number, notes: string): void {
		items.value[index].pos_notes = notes;
	}

	function updateItemDeliveryDate(index: number, date: string): void {
		items.value[index].pos_delivery_date = date;
	}

	function setCustomer(
		cust: {
			name: string;
			customer_name?: string;
			image?: string;
			mobile_no?: string;
			email_id?: string;
			customer_group?: string;
			territory?: string;
			xpos_has_address?: boolean;
			xpos_has_email?: boolean;
			xpos_has_phone?: boolean;
			xpos_address_count?: number;
			xpos_delivery?: CustomerDelivery;
			tax_category?: string | null;
		} | null,
	): void {
		// Another buyer's delivery address (and its day) never carries over.
		if (cust?.name !== customer.value?.name) {
			if (shippingAddress.value) deliveryDate.value = "";
			clearDelivery();
		}
		customer.value = cust;
	}

	function setItemTax(itemCode: string, taxTemplate: string, taxMap: Record<string, number>): void {
		const item = items.value.find((i: CartItem) => i.item_code === itemCode);
		if (item) {
			item.item_tax_template = taxTemplate;
			item.item_tax_map = taxMap;
		}
	}

	/** Set the additional (whole-ticket) discount, held to the cap; returns the value applied. */
	function setDiscount(type: DiscountKind, value: number): number {
		const max = maxAdditionalDiscount(type);
		const applied = max !== null && value > max ? max : value;
		if (type === "percentage") {
			discountPercentage.value = applied;
			discountAmount.value = 0;
		} else {
			discountAmount.value = applied;
			discountPercentage.value = 0;
		}
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
		return applied;
	}

	function enterReturnMode(invoiceName: string, allowedItemCodes?: string[]): void {
		isReturnMode.value = true;
		returnAgainst.value = invoiceName;
		returnItemCodes.value = allowedItemCodes || items.value.map((i) => i.item_code);
	}

	function exitReturnMode(): void {
		isReturnMode.value = false;
		returnAgainst.value = "";
		returnItemCodes.value = [];
		clearCart();
	}

	function setLoyalty(points: number, amount: number): void {
		redeemLoyaltyPoints.value = true;
		loyaltyPoints.value = points;
		loyaltyAmount.value = amount;
	}

	function clearLoyalty(): void {
		redeemLoyaltyPoints.value = false;
		loyaltyPoints.value = 0;
		loyaltyAmount.value = 0;
	}

	function applyOffer(offer: POSOffer): void {
		if (!appliedOffers.value.find((o) => o.name === offer.name)) {
			appliedOffers.value.push(offer);
		}
		syncFreeItems();
	}

	function removeOffer(offerName: string): void {
		appliedOffers.value = appliedOffers.value.filter((o) => o.name !== offerName);
		syncFreeItems();
	}

	function applyCoupon(coupon: POSCoupon): void {
		appliedCoupon.value = coupon;
		couponCode.value = coupon.coupon_code || "";
		const linkedOffer = (coupon as Record<string, unknown>)._offer as POSOffer | undefined;
		if (linkedOffer && !appliedOffers.value.find((o) => o.name === linkedOffer.name)) {
			appliedOffers.value.push(linkedOffer);
			syncFreeItems();
		}
	}

	function removeCoupon(): void {
		if (appliedCoupon.value) {
			const linkedOfferName = (appliedCoupon.value as Record<string, unknown>).pos_offer as string;
			if (linkedOfferName) {
				appliedOffers.value = appliedOffers.value.filter((o) => o.name !== linkedOfferName);
			}
		}
		appliedCoupon.value = null;
		couponCode.value = "";
		syncFreeItems();
	}

	function syncFreeItems(): void {
		const eval_ = offerEvaluation.value;

		items.value = items.value.filter((i) => !i.pos_is_offer);

		for (const free of eval_.freeItems) {
			if (!free.item_code) continue;
			items.value.push({
				uid: nextRowId(),
				item_code: free.item_code,
				item_name: free.item_name,
				rate: normalizeItemRate(free.rate),
				qty: free.qty,
				uom: "",
				stock_uom: "",
				image: "",
				discount_percentage: free.rate === 0 ? 100 : 0,
				discount_amount: 0,
				serial_no: "",
				batch_no: "",
				actual_qty: 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: 1,
				pos_is_offer: true,
				pos_is_replace: free.is_replace,
				pos_offers: free.offer_name,
				pos_offer_applied: true,
			} as CartItem);
		}
	}

	/**
	 * Replace the free lines a Product pricing rule generated.
	 *
	 * Kept separate from POS Offer free items (`pos_is_offer`), which are a
	 * different feature with its own lifecycle.
	 */
	function syncPricingRuleFreeItems(freeLines: FreeItemLine[]): void {
		const current = items.value
			.filter((i) => i.pos_is_free_item)
			.map((i) => `${i.item_code}:${i.qty}:${i.rate}:${i.pos_free_item_rule}`)
			.join("|");
		const incoming = freeLines
			.map((f) => `${f.item_code}:${f.qty}:${normalizeItemRate(f.rate)}:${f.pricing_rules}`)
			.join("|");
		if (current === incoming) return;

		items.value = items.value.filter((i) => !i.pos_is_free_item);

		for (const free of freeLines) {
			if (!free.item_code) continue;
			items.value.push({
				uid: nextRowId(),
				item_code: free.item_code,
				item_name: free.item_name || free.item_code,
				rate: normalizeItemRate(free.rate),
				qty: free.qty,
				uom: free.uom || free.stock_uom || "",
				stock_uom: free.stock_uom || free.uom || "",
				image: "",
				discount_percentage: 0,
				discount_amount: 0,
				serial_no: "",
				batch_no: "",
				actual_qty: 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: free.conversion_factor || 1,
				pos_is_free_item: true,
				pos_free_item_rule: free.pricing_rules,
			} as CartItem);
		}
	}

	function buildPricingLines(): CartPricingLine[] {
		for (const item of items.value) {
			if (!item.uid) item.uid = nextRowId();
		}

		return items.value
			.filter((item) => !item.pos_is_free_item && !item.pos_is_offer && item.qty !== 0)
			.map((item) => ({
				row_id: item.uid as string,
				item_code: item.item_code,
				item_group: item.item_group,
				brand: item.brand as string | undefined,
				variant_of: item.variant_of,
				qty: item.qty,
				uom: item.uom || item.stock_uom,
				conversion_factor: item.conversion_factor || 1,
				rate: item.rate,
				price_list_rate: item.rate,
				warehouse: posStore.warehouse,
				pricing_rules: item.pos_pricing_rules?.length
					? JSON.stringify(item.pos_pricing_rules)
					: undefined,
			}));
	}

	let lastSnapshotRefresh = 0;
	const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

	/**
	 * Cache the rule snapshot the offline engine needs. Called on POS boot and
	 * opportunistically after a server reconcile, so the cache is warm before the
	 * network drops. Throttled - rules change far slower than carts do.
	 */
	async function refreshPricingSnapshot(force = false): Promise<void> {
		if (!force && Date.now() - lastSnapshotRefresh < SNAPSHOT_TTL_MS) return;
		lastSnapshotRefresh = Date.now();
		await refreshPricingRuleSnapshot({
			pos_profile: posStore.profileName,
			company: posStore.companyName,
			price_list: posStore.sellingPriceList,
			currency: currency.value || posStore.currency,
		});
	}

	function applyPricingResult(result: ResolvedCartPricing): void {
		const byRow = new Map(result.updates.map((u) => [u.row_id, u]));

		for (const item of items.value) {
			if (item.pos_is_free_item || item.pos_is_offer) continue;
			const update = item.uid ? byRow.get(item.uid) : undefined;

			if (update && update.pricing_rules.length) {
				if (!item.pos_rate_overridden && update.price_list_rate) {
					item.rate = normalizeItemRate(update.price_list_rate);
				}
				// The rule's money discount is per unit; the cart keeps it for the whole line.
				const unitDiscount = update.discount_percentage ? 0 : update.discount_amount || 0;
				item.discount_percentage = update.discount_percentage;
				item.discount_amount = lineDiscountFromPerUnit(unitDiscount, item.qty);
				item.pos_pricing_rules = update.pricing_rules;
				// The rule's price, kept for the discount cap after a counter discount replaces it.
				item.pos_rule_rate = item.discount_percentage
					? item.rate * (1 - item.discount_percentage / 100)
					: item.rate - unitDiscount;
			} else {
				if (item.pos_pricing_rules?.length) {
					item.discount_percentage = 0;
					item.discount_amount = 0;
					item.pos_pricing_rules = [];
				}
				item.pos_rule_rate = undefined;
			}
		}

		syncPricingRuleFreeItems(result.free_lines);
		applyTransactionDiscount(result.invoice_updates);
		pricingSource.value = result.source;
	}

	function applyTransactionDiscount(update: ResolvedCartPricing["invoice_updates"]): void {
		ruleDiscountOn.value = (update.from_pricing_rule && update.apply_discount_on) || "";

		if (update.from_pricing_rule) {
			discountPercentage.value = update.additional_discount_percentage;
			discountAmount.value = update.discount_amount;
			ruleDiscountPercentage.value = update.additional_discount_percentage;
			ruleDiscountAmount.value = update.discount_amount;
			return;
		}

		const ownsPercentage =
			ruleDiscountPercentage.value > 0 && discountPercentage.value === ruleDiscountPercentage.value;
		const ownsAmount = ruleDiscountAmount.value > 0 && discountAmount.value === ruleDiscountAmount.value;
		if (ownsPercentage || ownsAmount) {
			discountPercentage.value = 0;
			discountAmount.value = 0;
		}
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
	}

	let pricingRequestId = 0;

	/**
	 * Re-price the cart against the Pricing Rules.
	 *
	 * Debounced by the watcher below; safe to call directly (e.g. after loading a
	 * draft). Responses are tagged with a request id so a slow reply cannot
	 * overwrite a newer one.
	 */
	async function applyPricingRules(): Promise<void> {
		if (isReturnMode.value) return;

		const lines = buildPricingLines();
		if (!lines.length) {
			syncPricingRuleFreeItems([]);
			applyTransactionDiscount({
				additional_discount_percentage: 0,
				discount_amount: 0,
				apply_discount_on: "",
				from_pricing_rule: false,
			});
			return;
		}

		const requestId = ++pricingRequestId;
		isPricingCart.value = true;
		try {
			const result = await resolveCartPricing({
				lines,
				context: {
					pos_profile: posStore.profileName,
					company: posStore.companyName,
					customer: customer.value?.name,
					customer_group: customer.value?.customer_group,
					territory: customer.value?.territory,
					price_list: posStore.sellingPriceList,
					currency: currency.value || posStore.currency,
					conversion_rate: conversionRate.value,
					warehouse: posStore.warehouse,
					coupon_code: couponCode.value,
					posting_date: postingDate.value,
				},
			});

			if (requestId !== pricingRequestId) return; // superseded
			if (result.source === "unavailable") return; // leave prices as they are

			applyPricingResult(result);

			if (result.source === "server") {
				refreshPricingSnapshot().catch(() => {});
			}
		} finally {
			if (requestId === pricingRequestId) isPricingCart.value = false;
		}
	}

	const schedulePricingRules = debounce(() => {
		applyPricingRules().catch((error) => {
			console.error("Pricing rule reconciliation failed:", error);
		});
	}, 250);

	watch(
		() =>
			[
				customer.value?.name || "",
				couponCode.value,
				postingDate.value,
				posStore.sellingPriceList,
				items.value
					.filter((i) => !i.pos_is_free_item && !i.pos_is_offer)
					.map(
						(i) =>
							`${i.uid}:${i.item_code}:${i.qty}:${i.uom}:${i.rate}:${i.batch_no}:${i.serial_no}`,
					)
					.join("|"),
			].join("~"),
		() => schedulePricingRules(),
	);

	function clearAllDiscounts(): void {
		discountPercentage.value = 0;
		discountAmount.value = 0;
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
		for (const item of items.value) {
			if (!item.pos_is_offer) {
				item.discount_percentage = 0;
				item.discount_amount = 0;
				item.pos_pricing_rules = [];
			}
		}
		appliedCoupon.value = null;
		couponCode.value = "";
		appliedOffers.value = [];
		items.value = items.value.filter((i) => !i.pos_is_offer && !i.pos_is_free_item);
	}

	function addPayment(modeOfPayment: string, amount: number): void {
		const existing = payments.value.find((p) => p.mode_of_payment === modeOfPayment);
		if (existing) {
			existing.amount += amount;
		} else {
			payments.value.push({ mode_of_payment: modeOfPayment, amount });
		}
	}

	function setPayments(paymentList: InvoicePayment[]): void {
		payments.value = paymentList;
	}

	function clearPayments(): void {
		payments.value = [];
		changeLegs.value = [];
		changeAmount.value = 0;
	}

	function setChangeLegs(legs: InvoiceChangeLeg[]): void {
		changeLegs.value = legs;
	}

	function setChangeAmount(amount: number): void {
		changeAmount.value = amount;
	}

	function setCurrency(curr: string, rate: number): void {
		currency.value = curr;
		conversionRate.value = rate;
	}

	function clearCart(): void {
		invoiceLocalId = "";
		serverPreview.value = null;
		counterQuote.value = null;
		pickupDate.value = "";
		mixPayMode.value = "now";
		items.value = [];
		selectedCartIndex.value = -1;
		discountPercentage.value = 0;
		discountAmount.value = 0;
		ruleDiscountPercentage.value = 0;
		ruleDiscountAmount.value = 0;
		ruleDiscountOn.value = "";
		pricingSource.value = "server";
		clearLoyalty();
		appliedOffers.value = [];
		appliedCoupon.value = null;
		couponCode.value = "";
		writeOffAmount.value = 0;
		orderNotes.value = "";
		deliveryDate.value = "";
		postingDate.value = nowDate();
		salesPerson.value = "";
		payments.value = [];
		changeLegs.value = [];
		changeAmount.value = 0;
		currentDraftName.value = "";
		currentDraftModified.value = "";
		currency.value = "";
		conversionRate.value = 1;
		selectedDeliveryCharge.value = null;
		clearDelivery();
	}

	function clearDelivery(): void {
		shippingAddress.value = null;
		deliveryQuote.value = null;
		deliveryItemCode.value = "";
		deliveryMilesSource.value = null;
	}

	function clearAll(): void {
		clearCart();
		customer.value = null;
		showPaymentDialog.value = false;
		isReturnMode.value = false;
		returnAgainst.value = "";
		returnItemCodes.value = [];
		const posStore = usePosStore();
		if (posStore.defaultCustomer) {
			const name = String(posStore.defaultCustomer);
			customer.value = {
				name,
				customer_name: name,
			};
		}
	}

	/**
	 * The cart as save would receive it, minus the tender (what the preview prices).
	 * Write-off and loyalty are settled against the total, not part of it, so they
	 * stay out: entering them in the payment dialog keeps the preview.
	 */
	function previewPayload(): Partial<InvoiceData> {
		const {
			local_id,
			payments,
			change_amount,
			pos_change_legs,
			write_off_amount,
			redeem_loyalty_points,
			loyalty_points,
			loyalty_amount,
			...cart
		} = getInvoiceData(posStore.profileName, posStore.posOpeningShift?.name || "");
		return cart;
	}


	/** The server's lines differ from the cart's (e.g. a $0 stored-grain line was added). */
	const serverLinesDiffer = computed(() => {
		const preview = serverPreview.value;
		if (!preview || preview.key !== previewKey.value) return false;
		const line = (code: string, qty: number, rate: number) => `${code}:${+qty.toFixed(3)}:${+rate.toFixed(6)}`;
		const cart = items.value.map((i) => line(i.item_code, i.qty, i.rate)).join("|");
		return cart !== preview.items.map((i) => line(i.item_code, i.qty, i.rate)).join("|");
	});

	/** The preview's total while it still prices this cart; sent so the server can hold us to it. */
	const previewExpectedTotal = computed(() =>
		serverPreview.value && serverPreview.value.key === previewKey.value && !isReturnMode.value
			? serverPreview.value.amount_due
			: null,
	);

	// A cart that changes after the check is never charged its own sum: drop the
	// preview, and if payment is open close it so Pay checks again.
	watch(previewKey, (key) => {
		if (counterQuote.value && counterQuote.value.key !== key) counterQuote.value = null;
		if (!serverPreview.value || serverPreview.value.key === key) return;
		serverPreview.value = null;
		if (showPaymentDialog.value) {
			showPaymentDialog.value = false;
			serverPreviewError.value = __("The cart changed after it was checked. Press Pay again.");
		}
	});

	/** The server refused the sale (its ticket changed): forget the preview, show why. */
	function ticketChanged(message: string): void {
		serverPreview.value = null;
		showPaymentDialog.value = false;
		serverPreviewError.value = message;
	}

	async function openPaymentDialog(): Promise<void> {
		if (muleTaxPending.value || muleTaxError.value || serverPreviewPending.value) return;
		if (hasOrderLines.value) {
			await openMixOrderPayment();
			return;
		}
		// Offline the server can't be asked; the offline queue posts what the server decides.
		if (!isReturnMode.value && isOnline()) {
			const key = previewKey.value;
			serverPreviewPending.value = true;
			serverPreviewError.value = "";
			try {
				const result = await call<Omit<ServerPreview, "key">>("xpos.api.invoices.preview_invoice", {
					data: JSON.stringify(previewPayload()),
				});
				await prepareVfdPickup(getInvoiceData(posStore.profileName, posStore.posOpeningShift?.name || ""));
				serverPreview.value = { ...result, key };
				// The cart or buyer changed while the server was pricing it: press Pay again.
				if (key !== previewKey.value || muleTaxPending.value || muleTaxError.value) return;
			} catch (error) {
				serverPreview.value = null;
				serverPreviewError.value = extractErrorMessage(error);
				return;
			} finally {
				serverPreviewPending.value = false;
			}
		}
		showPaymentDialog.value = true;
	}

	/**
	 * Pay for a cart with custom mixes to order (Mule City, MuleCity-3j1m): the site
	 * prices today's ticket and the orders separately, placing the orders only
	 * inside a rolled-back savepoint (short ingredients are refused here). Orders
	 * need the server, so an offline till refuses them.
	 */
	async function openMixOrderPayment(): Promise<void> {
		serverPreviewError.value = "";
		if (!isOnline()) {
			serverPreviewError.value = __("Custom mixes can't be ordered offline. Go online, or take the order at the desk.");
			return;
		}
		if (!pickupDate.value) {
			serverPreviewError.value = __("Choose a pickup date for the custom mix order.");
			return;
		}
		const key = previewKey.value;
		serverPreviewPending.value = true;
		try {
			const result = await call<Omit<CounterQuote, "key">>("mulecity_erpnext.counter_mix_orders.counter_quote", {
				data: JSON.stringify(previewPayload()),
			});
			counterQuote.value = { ...result, key };
			if (key !== previewKey.value) return;
		} catch (error) {
			counterQuote.value = null;
			serverPreviewError.value = extractErrorMessage(error);
			return;
		} finally {
			serverPreviewPending.value = false;
		}
		showPaymentDialog.value = true;
	}

	function closePaymentDialog(): void {
		showPaymentDialog.value = false;
	}

	async function fetchDraftInvoices(scope: "shift" | "profile" = "shift"): Promise<OpenTab[]> {
		try {
			isLoadingDrafts.value = true;
			const result = await call<OpenTab[]>("xpos.api.invoices.get_draft_invoices", {
				pos_opening_shift: posStore.posOpeningShift?.name || "",
				scope,
			});
			return result || [];
		} catch (error) {
			console.error("Error fetching draft invoices:", error);
			return [];
		} finally {
			isLoadingDrafts.value = false;
		}
	}

	async function loadDraftInvoice(draftName: string): Promise<boolean> {
		try {
			const result = await call<any>("xpos.api.invoices.get_invoice_details", {
				invoice_name: draftName,
			});

			if (!result) {
				return false;
			}

			clearCart();

			postingDate.value = posStore.allowChangePostingDate
				? toDateOrNow(result.posting_date)
				: nowDate();

			if (result.customer) {
				customer.value = {
					name: result.customer,
					customer_name: result.customer_name || result.customer,
				};
			}

			if (result.items && Array.isArray(result.items)) {
				const posStore = usePosStore();
				const warehouse = posStore.warehouse || "";

				const { useItemStore } = await import("@/stores/itemStore");
				const itemStore = useItemStore();
				const inMemoryMap = new Map<string, number>(
					itemStore.items.map((i: POSItem) => [i.item_code, i.actual_qty ?? 0]),
				);

				for (const item of result.items) {
					let actualQty: number = inMemoryMap.get(item.item_code) ?? -1;

					if (actualQty < 0) {
						if (warehouse) {
							const stockEntry = await getCachedStockForItem(warehouse, item.item_code);
							if (stockEntry) {
								actualQty = stockEntry.actual_qty;
							}
						}

						if (actualQty < 0) {
							const cachedItem = await getCachedItemByCode(item.item_code);
							actualQty = cachedItem?.actual_qty ?? 0;
						}
					}

					items.value.push({
                        ...muleOrderFields(item),
						uid: nextRowId(),
						item_code: item.item_code,
						item_name: item.item_name,
						local_item_name: item.local_item_name,
						rate: normalizeItemRate(item.price_list_rate || item.rate || 0),
						qty: item.qty || 1,
						uom: item.uom || item.stock_uom || "",
						stock_uom: item.stock_uom || item.uom || "",
						image: "",
						discount_percentage: item.discount_percentage || 0,
						// The server's discount is per unit; the cart keeps it for the whole line.
						discount_amount: lineDiscountFromPerUnit(item.discount_amount, item.qty || 1),
						serial_no: item.serial_no || "",
						batch_no: item.batch_no || "",
						actual_qty: actualQty,
						is_stock_item: item.is_stock_item,
						has_serial_no: item.has_serial_no || false,
						has_batch_no: item.has_batch_no || false,
						conversion_factor: item.conversion_factor || 1,
						pos_notes: item.additional_notes || "",
						pos_delivery_date: item.delivery_date || "",
						pos_is_free_item: !!item.is_free_item,
						pos_free_item_rule: item.is_free_item ? parseRuleName(item.pricing_rules) : undefined,
						pos_pricing_rules: parsePricingRules(item.pricing_rules),
						description: item.description,
					} as CartItem);
				}
			}
			if (result.shipping_address_name) {
				const miles = Number(result.pos_delivery_miles) || null;
				shippingAddress.value = { name: result.shipping_address_name, address_line1: "", city: "", miles, miles_source: null };
				deliveryMilesSource.value = miles ? ((result.pos_delivery_miles_source as DeliveryMilesSource) || "address") : null;
			}

			if (result.additional_discount_percentage) {
				discountPercentage.value = result.additional_discount_percentage;
			}
			if (result.discount_amount) {
				discountAmount.value = result.discount_amount;
			}
			if (result.pos_notes) {
				orderNotes.value = result.pos_notes;
			}
			if (result.pos_delivery_date) {
				deliveryDate.value = result.pos_delivery_date;
			}
			if (result.sales_person) {
				salesPerson.value = result.sales_person;
			}
			if (result.pos_delivery_charges) {
				selectedDeliveryCharge.value = {
					name: result.pos_delivery_charges,
					label: result.pos_delivery_charges_label || result.pos_delivery_charges,
					rate: Number(result.pos_delivery_charges_rate || 0),
					default_rate: Number(result.pos_delivery_charges_rate || 0),
				};
			}
			currentDraftName.value = draftName;
			currentDraftModified.value = result.modified || "";

			return true;
		} catch (error) {
			console.error("Error loading draft invoice:", error);
			return false;
		}
	}

	function openDraftDialog(): void {
		showDraftDialog.value = true;
	}

	function closeDraftDialog(): void {
		showDraftDialog.value = false;
	}

	function loadFromInvoice(invoiceData: {
		customer: string;
		customer_name: string;
		items: Array<{
			item_code: string;
			item_name: string;
			local_item_name?: string;
			qty: number;
			rate: number;
			price_list_rate?: number;
			uom: string;
			stock_uom?: string;
			discount_percentage?: number;
			discount_amount?: number;
			serial_no?: string;
			batch_no?: string;
		}>;
	}): void {
		clearCart();
		customer.value = {
			name: invoiceData.customer,
			customer_name: invoiceData.customer_name,
		};
		for (const item of invoiceData.items) {
			items.value.push({
                ...muleOrderFields(item),
				uid: nextRowId(),
				item_code: item.item_code,
				item_name: item.item_name,
				local_item_name: item.local_item_name,
				rate: normalizeItemRate(item.price_list_rate || item.rate || 0),
				qty: item.qty || 1,
				uom: item.uom || item.stock_uom || "",
				stock_uom: item.stock_uom || item.uom || "",
				image: "",
				discount_percentage: item.discount_percentage || 0,
				// Posted (and queued) lines carry the discount per unit; the cart keeps it for the whole line.
				discount_amount: lineDiscountFromPerUnit(item.discount_amount || 0, item.qty || 1),
				serial_no: item.serial_no || "",
				batch_no: item.batch_no || "",
				actual_qty: (item as any).actual_qty || 0,
				has_serial_no: false,
				has_batch_no: false,
				conversion_factor: (item as any).conversion_factor || 1,
			} as CartItem);
		}
	}

	function getInvoiceData(posProfile: string, posOpeningShift: string): InvoiceData {
		const data: InvoiceData = {
			local_id: invoiceLocalId || (invoiceLocalId = newInvoiceId()),
			pos_profile: posProfile,
			customer: customer.value?.name || "",
			items: items.value.map(
				(item: CartItem): InvoiceItem => ({
                    ...muleOrderFields(item),
					item_code: item.item_code,
					item_name: item.item_name,
					local_item_name: item.local_item_name,
					qty: item.qty,
					rate: normalizeItemRate(item.rate),
					price_list_rate: normalizeItemRate(item.rate),
					uom: item.uom || item.stock_uom,
					conversion_factor: item.conversion_factor || 1,
					discount_percentage: item.discount_percentage,
					// The server takes the money discount per unit (MuleCity-1msa).
					discount_amount: perUnitDiscount(
						item.discount_amount || 0,
						item.qty,
						normalizeItemRate(item.rate),
						itemRatePrecision.value,
					),
					serial_no: item.serial_no,
					batch_no: item.batch_no,
					item_tax_template: item.item_tax_template,
					additional_notes: item.pos_notes,
					delivery_date: item.pos_delivery_date,
					offers: item.pos_offers,
					is_offer: item.pos_is_offer,
					is_replace: item.pos_is_replace,
					is_free_item: item.pos_is_free_item ? 1 : undefined,
					pricing_rules: item.pos_free_item_rule,
					description: item.description,
				}),
			),
			pos_opening_shift: posOpeningShift,
			posting_date: posStore.allowChangePostingDate ? postingDate.value || nowDate() : nowDate(),
			additional_discount_percentage: discountPercentage.value,
			discount_amount: discountAmount.value,
			apply_discount_on: applyDiscountOn.value,
		};

		const _hasOfferDisc = offerItemDiscountTotal.value > 0 || offerGrandTotalDiscountPct.value > 0;
		if (_hasOfferDisc) {
			let totalDisc = offerItemDiscountTotal.value;
			let remaining = subtotal.value + taxAmount.value - totalDisc;

			if (offerGrandTotalDiscountPct.value > 0) {
				const gtAmt = (remaining * offerGrandTotalDiscountPct.value) / 100;
				totalDisc += gtAmt;
				remaining -= gtAmt;
			}

			if (discountPercentage.value > 0) {
				totalDisc += (remaining * discountPercentage.value) / 100;
			} else if (discountAmount.value > 0) {
				totalDisc += discountAmount.value;
			}

			data.discount_amount = Math.round(totalDisc * 100) / 100;
			data.additional_discount_percentage = 0;
		}

		if (currentDraftName.value) {
			data.name = currentDraftName.value;
			if (currentDraftModified.value) {
				data.modified = currentDraftModified.value;
			}
		}

		if (payments.value.length > 0) {
			data.payments = payments.value;
		}

		if (changeAmount.value > 0) {
			data.change_amount = changeAmount.value;
		}

		if (changeLegs.value.length > 0) {
			data.pos_change_legs = changeLegs.value;
		}

		if (hasOrderLines.value) (data as any).pickup_date = pickupDate.value;
		if (orderNotes.value) data.pos_notes = orderNotes.value;
		// The day belongs to a delivery: a pickup sale (or one whose delivery line was removed) has none.
		if (deliveryDate.value && (activeDelivery.value || selectedDeliveryCharge.value)) data.pos_delivery_date = deliveryDate.value;
		if (salesPerson.value) data.sales_person = salesPerson.value;

		if (redeemLoyaltyPoints.value) {
			data.redeem_loyalty_points = true;
			data.loyalty_points = loyaltyPoints.value;
			data.loyalty_amount = loyaltyAmount.value;
		}

		if (isReturnMode.value && returnAgainst.value) {
			data.is_return = true;
			data.return_against = returnAgainst.value;
		}

		if (writeOffAmount.value > 0) {
			data.write_off_amount = writeOffAmount.value;
		}

		if (currency.value && conversionRate.value !== 1) {
			data.currency = currency.value;
			data.conversion_rate = conversionRate.value;
		}

		if (appliedCoupon.value) {
			data.coupons = JSON.stringify([appliedCoupon.value.name]);
			data.coupons_detail = [
				{
					coupon: appliedCoupon.value.name,
					coupon_code: appliedCoupon.value.coupon_code || couponCode.value,
					type: (appliedCoupon.value as Record<string, unknown>).coupon_type || "Promotional",
					pos_offer: (appliedCoupon.value as Record<string, unknown>).pos_offer || "",
					applied: 1,
					customer: customer.value?.name || "",
				},
			];
		}

		if (appliedOffers.value.length > 0) {
			data.offers = JSON.stringify(appliedOffers.value.map((o) => o.name));
			data.offers_detail = appliedOffers.value.map((o) => ({
				offer_name: o.name,
				offer:
					(o as Record<string, unknown>).offer || (o as Record<string, unknown>).offer_type || "",
				apply_on: o.apply_on || "",
				offer_applied: 1,
				coupon_based: (o as Record<string, unknown>).coupon_based ? 1 : 0,
			}));
		}

		if (selectedDeliveryCharge.value) {
			data.pos_delivery_charges = selectedDeliveryCharge.value.name;
			data.pos_delivery_charges_rate = selectedDeliveryCharge.value.rate;
		}

		// A quoted delivery ships to its address; one typed offline is made on sync.
		// Its day and miles ride with the sale, so the invoice keeps them as rung up,
		// offline too (MuleCity-qajl).
		const delivery = activeDelivery.value;
		const address = delivery?.address;
		if (address?.name && !isLocalAddress(address.name)) data.shipping_address_name = address.name;
		else if (address && isLocalAddress(address.name))
			// Added at the till while offline (MuleCity-qajl): the queued add is replayed
			// first and the sync swaps in its Address; the whole address rides along so
			// the server can still make it if that replay did not happen.
			data.xpos_new_shipping_address = {
				address_line1: address.address_line1,
				address_line2: address.address_line2 || undefined,
				city: address.city,
				state: address.state || undefined,
				pincode: address.pincode || undefined,
				title: address.title || undefined,
				miles: address.miles || 0,
				local_id: address.name,
			};
		else if (address)
			data.xpos_new_shipping_address = { address_line1: address.address_line1, city: address.city, miles: address.miles || 0 };
		if (address && deliveryQuote.value) data.xpos_delivery = { ...deliveryQuote.value, address: address.name };
		if (delivery?.miles) {
			data.pos_delivery_miles = delivery.miles;
			data.pos_delivery_miles_source = delivery.milesSource || "address";
		}

		return data;
	}

	function getReceiptSnapshot(invoiceName: string, cashier = ""): ReceiptSnapshot {
		const snapshot = cartReceiptSnapshot(invoiceName, cashier);
		const preview = serverPreview.value;
		if (!serverLinesDiffer.value || !preview) return snapshot;
		// Print the ticket the server posts (e.g. the $0 stored-grain line), not the cart.
		return {
			...snapshot,
			items: preview.items.map((line) => ({
				item_code: line.item_code,
				item_name: line.stored_grain && line.description ? line.description : line.item_name,
				qty: line.qty,
				rate: line.rate,
				amount: line.amount,
				uom: line.uom,
				discount_amount: 0,
				price_list_rate: line.rate,
			})),
			taxes: preview.taxes.map((t) => ({
				description: t.description,
				rate: t.rate,
				amount: t.tax_amount,
				included_in_print_rate: false,
			})),
			subtotal: preview.net_total,
			total_discount: 0,
			net_total: preview.net_total,
			total_qty: preview.items.reduce((sum, line) => sum + line.qty, 0),
		};
	}

	function cartReceiptSnapshot(invoiceName: string, cashier: string): ReceiptSnapshot {
		const snapshotItems = items.value.map((item: CartItem) => {
			const gross = item.qty * item.rate;
			let discount = 0;
			if (item.discount_percentage) {
				discount = (gross * item.discount_percentage) / 100;
			} else if (item.discount_amount) {
				discount = item.qty < 0 ? -item.discount_amount : item.discount_amount;
			}
			return {
				item_code: item.item_code,
				item_name: item.local_item_name || item.item_name,
				qty: item.qty,
				rate: item.rate,
				amount: Math.round(gross * 100) / 100,
				uom: item.uom || item.stock_uom,
				discount_percentage: item.discount_percentage,
				discount_amount: Math.round(discount * 100) / 100,
				price_list_rate: item.rate,
				serial_no: item.serial_no,
				batch_no: item.batch_no,
				pos_notes: item.pos_notes,
			};
		});

		const itemDiscountTotal = snapshotItems.reduce((sum, it) => sum + (it.discount_amount || 0), 0);
		const totalDiscount = Math.round((itemDiscountTotal + (discountAmount.value || 0)) * 100) / 100;
		const totalQty = items.value.reduce((sum: number, item: CartItem) => sum + item.qty, 0);
		const paid = totalPayments.value;
		const change = paid - grandTotal.value;

		return {
			name: invoiceName,
			posting_date: postingDate.value || nowDate(),
			posting_time: new Date().toTimeString().slice(0, 8),
			is_return: isReturnMode.value,
			cashier,
			customer_name: customerName.value,
			items: snapshotItems,
			taxes: calculatedTaxes.value.map((t) => ({
				description: t.description,
				rate: t.rate,
				amount: t.amount,
				included_in_print_rate: !!t.included_in_print_rate,
			})),
			payments: payments.value
				.filter((p) => p.amount)
				.map((p) => ({
					mode_of_payment: p.mode_of_payment,
					amount: p.amount,
					...(p.pos_tender_currency
						? {
								currency: p.pos_tender_currency,
								native_amount: p.pos_tender_amount,
								exchange_rate: p.pos_exchange_rate,
								rate_date: posStore.tenderModeFor(p.mode_of_payment)?.rate_date || "",
							}
						: {}),
				})),
			subtotal: Math.round(subtotal.value * 100) / 100,
			total_discount: totalDiscount,
			net_total: Math.round((subtotal.value + includedTaxAmount.value) * 100) / 100,
			grand_total: grandTotal.value,
			total_qty: totalQty,
			change: change > 0.01 && !isReturnMode.value ? Math.round(change * 100) / 100 : 0,
			change_legs: changeLegs.value.length ? changeLegs.value : undefined,
			currency: currency.value || posStore.currency || undefined,
			notes: orderNotes.value || undefined,
			delivery: receiptDelivery(),
		};
	}

	/** The delivery's facts for the offline receipt (the prints lane formats them). */
	function receiptDelivery(): ReceiptSnapshot["delivery"] {
		const delivery = activeDelivery.value;
		if (!delivery) return undefined;
		return {
			address_name: delivery.address.name,
			address: fullAddress(delivery.address),
			miles: delivery.miles,
			miles_source: delivery.miles ? delivery.milesSource || "address" : null,
			date: deliveryDate.value || nowDate(),
		};
	}

	function setDeliveryCharge(charge: DeliveryCharge | null): void {
		selectedDeliveryCharge.value = charge;
	}

	/**
	 * Deliver the sale to `address` for `amount` (MuleCity-6nb1): one line of the
	 * site's delivery item, qty 1, described by the quote. A second "Add delivery"
	 * updates that line; it stays an ordinary line (editable within the discount cap).
	 */
	function setDelivery(
		policy: DeliveryPolicy,
		address: DeliveryAddress,
		quote: DeliveryQuote,
		amount: number,
		options: { milesSource?: DeliveryMilesSource; date?: string } = {},
	): void {
		const item = policy.item!;
		const typed = quote.source === "miles" && (address.miles_source === TYPED_OFFLINE || options.milesSource === "manual");
		const description = !typed
			? quote.description
			: `${quote.description}, ${address.miles_source === TYPED_OFFLINE ? "miles typed offline" : "miles typed at the till"}`;
		const line = items.value.find((i) => i.item_code === item.item_code);
		if (line) {
			Object.assign(line, { qty: 1, rate: normalizeItemRate(amount), description, discount_percentage: 0, discount_amount: 0 });
		} else {
			items.value.push({
				uid: nextRowId(),
				item_code: item.item_code,
				item_name: item.item_name,
				item_group: item.item_group,
				rate: normalizeItemRate(amount),
				qty: 1,
				uom: item.stock_uom,
				stock_uom: item.stock_uom,
				conversion_factor: 1,
				discount_percentage: 0,
				discount_amount: 0,
				is_stock_item: false,
				description,
			} as CartItem);
		}
		shippingAddress.value = address;
		deliveryQuote.value = { ...quote, amount };
		deliveryItemCode.value = item.item_code;
		deliveryMilesSource.value = options.milesSource || (address.miles_source === TYPED_OFFLINE ? "manual" : "address");
		setDeliveryDate(options.date || deliveryDate.value || nowDate());
	}

	/**
	 * The day the delivery goes (Bill 2026-10-01: the clerk picks it at the till).
	 * The sale keeps it as pos_delivery_date; a counter order's Sales Order takes it
	 * as its delivery_date (the mix order's pickup_date).
	 */
	function setDeliveryDate(day: string): void {
		deliveryDate.value = day;
		if (hasOrderLines.value && day) pickupDate.value = day;
	}

	return {
		items,
		customer,
		discountPercentage,
		discountAmount,
		muleTaxPending, muleTaxError, muleTaxCategory, muleTaxExemptReason,
		serverPreview, serverPreviewPending, serverPreviewError, serverLinesDiffer,
		previewExpectedTotal, ticketChanged,
		showPaymentDialog,
		isReturnMode,
		returnAgainst,
		returnItemCodes,
		orderNotes,
		deliveryDate,
		postingDate,
		writeOffAmount,
		salesPerson,
		redeemLoyaltyPoints,
		loyaltyPoints,
		loyaltyAmount,
		appliedOffers,
		appliedCoupon,
		couponCode,
		payments,
		changeLegs,
		changeAmount,
		selectedCartIndex,
		currentDraftName,
		currentDraftModified,
		isSavingDraft,
		showDraftDialog,
		isLoadingDrafts,
		currency,
		conversionRate,
		selectedDeliveryCharge,
		applyDiscountOn,
		isPricingCart,
		pricingSource,
		offerEvaluation,
		offerItemDiscountTotal,
		offerGrandTotalDiscountPct,
		itemCount,
		subtotal,
		calculatedTaxes,
		taxAmount,
		includedTaxAmount,
		totalTaxAmount,
		grandTotal,
		isEmpty,
		customerName,
		totalPayments,
		remainingPayment,
		hasOffers,
		canAddItem,
		revalidateStock,
		getStockReservations,
		canAddItemWithDetails,
		addItem,
		addItemWithDetails,
		removeItem,
		setSelectedCartIndex,
		updateItemQty,
		updateItemRate,
		updateItemDiscount,
		discountCapActive,
		maxLineDiscount,
		maxAdditionalDiscount,
		changeItemUOM,
		updateItemNotes,
		updateItemDeliveryDate,
		setCustomer,
		setDiscount,
		setItemTax,
		enterReturnMode,
		exitReturnMode,
		setLoyalty,
		clearLoyalty,
		applyOffer,
		removeOffer,
		applyCoupon,
		removeCoupon,
		syncFreeItems,
		applyPricingRules,
		refreshPricingSnapshot,
		clearAllDiscounts,
		addPayment,
		setPayments,
		clearPayments,
		setChangeLegs,
		setChangeAmount,
		setCurrency,
		clearCart,
		clearAll,
		openPaymentDialog,
		closePaymentDialog,
		getInvoiceData,
		getReceiptSnapshot,
		loadFromInvoice,
		fetchDraftInvoices,
		loadDraftInvoice,
		openDraftDialog,
		closeDraftDialog,
		setDeliveryCharge,
		shippingAddress,
		deliveryQuote,
		activeDelivery,
		setDelivery,
		setDeliveryDate,
		itemRatePrecision,
		pickupDate,
		mixPayMode,
		counterQuote,
		hasOrderLines,
		isOrderLine,
	};
});
