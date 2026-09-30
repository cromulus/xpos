/** Native order/recipe links survive cart transport; the server validates the source sale. */
export function muleOrderFields(row: Record<string, any>): Record<string, any> {
  const fields = ['sales_order', 'so_detail', 'warehouse', 'bom_no', 'mule_processing_instructions'];
  return Object.fromEntries(fields.filter(key => row[key] != null).map(key => [key, row[key]]));
}
