/** Retain order/quote provenance; the Mule server validates it against the source row. */
export function muleOrderFields(row: Record<string, any>): Record<string, any> {
  return Object.fromEntries(['sales_order', 'so_detail', 'warehouse', 'mule_formula_scratchpad', 'mule_source_bom', 'mule_nutrition_snapshot_json', 'mule_formula_fingerprint', 'mule_mix_quote', 'mule_quote_snapshot_hash', 'mule_quote_input_fingerprint', 'mule_quote_state', 'mule_price_mode', 'mule_pricing_rule_version'].filter(key => row[key] != null).map(key => [key, row[key]]));
}
