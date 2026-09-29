import { describe, it, expect } from 'vitest';
import { muleOrderFields } from '../src/services/muleOrderFields';

describe('Native mix order transport', () => {
  it('retains the exact order row and BOM without copying totals or retired quote fields', () => {
    const source = { sales_order: 'SO-1', so_detail: 'ROW-1', bom_no: 'BOM-1', warehouse: 'Main',
      mule_formula_scratchpad: 'OLD', mule_source_bom: 'OLD-BOM', mule_mix_quote: 'QUOTE-1',
      mule_quote_snapshot_hash: 'hash', mule_formula_batch_id: 'HISTORY', grand_total: 999 };
    expect(muleOrderFields(source)).toEqual({ sales_order: 'SO-1', so_detail: 'ROW-1', bom_no: 'BOM-1', warehouse: 'Main' });
    expect(source.grand_total).toBe(999);
  });
  it('leaves ordinary items unbound and never invents provenance', () => {
    expect(muleOrderFields({ item_code: 'A', qty: 20, so_detail: null })).toEqual({});
  });
  it('keeps a selected BOM even when there is no prior order', () => {
    expect(muleOrderFields({ bom_no: 'BOM-NEW' })).toEqual({ bom_no: 'BOM-NEW' });
  });
  it('preserves literal per-sale mill instructions without copying price fields', () => {
    const note = 'CRACK <<2X>>\n2 PALLETS';
    expect(muleOrderFields({ bom_no: 'BOM-1', mule_processing_instructions: note, rate: 999 }))
      .toEqual({ bom_no: 'BOM-1', mule_processing_instructions: note });
    expect(muleOrderFields({ mule_processing_instructions: '' })).toEqual({ mule_processing_instructions: '' });
  });

});
