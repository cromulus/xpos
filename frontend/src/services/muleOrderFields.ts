/** Native order/recipe links survive cart transport; the server validates the source sale. */
export function muleOrderFields(row: Record<string, any>): Record<string, any> {
  const fields = [
    'sales_order', 'so_detail', 'warehouse', 'bom_no', 'mule_vfd', 'mule_processing_instructions',
    // A custom mix's own choices at the till (Mule City MuleCity-erqg.17): the customer's
    // stored grain, bulk to truck, and the pull-list fix picked when no plan passed.
    'mule_stored_grain_use', 'mule_stored_grain_use_lbs', 'mule_bulk_no_bags', 'mule_pull_remedy_json',
  ];
  return Object.fromEntries(fields.filter(key => row[key] != null && row[key] !== '').map(key => [key, row[key]]));
}
