import { siteValue } from "@/services/siteExtensions";

/**
 * Native order/recipe links survive cart transport; the server validates the source sale.
 * A site adds its own line fields (xpos_site `order_line_fields`, e.g. a made-to-order
 * line's choices or a compliance link); they travel with the line the same way.
 */
export function orderLineFields(row: Record<string, any>): Record<string, any> {
  const site = siteValue("order_line_fields");
  const fields = [
    'sales_order', 'so_detail', 'warehouse', 'bom_no',
    // A return line names the sold row it refunds, so it refunds that row's price (MuleCity-rj2o).
    'sales_invoice_item',
    ...(Array.isArray(site) ? site.filter((key): key is string => typeof key === "string") : []),
  ];
  return Object.fromEntries(fields.filter(key => row[key] != null).map(key => [key, row[key]]));
}
