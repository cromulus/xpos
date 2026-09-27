import { describe, it, expect } from 'vitest';
import { muleOrderFields } from '../src/services/muleOrderFields';
describe('Mule order transport', () => {
  it('retains source row and quote evidence through checkout without copying totals', () => {
    const source = {sales_order:'SO-1',so_detail:'ROW-1',mule_mix_quote:'QUOTE-1',mule_quote_snapshot_hash:'hash',warehouse:'Main',grand_total:999};
    expect(muleOrderFields(source)).toEqual({sales_order:'SO-1',so_detail:'ROW-1',mule_mix_quote:'QUOTE-1',mule_quote_snapshot_hash:'hash',warehouse:'Main'});
    expect(source.grand_total).toBe(999);
  });
  it('leaves ordinary items unbound and never invents quote provenance', () => {
    expect(muleOrderFields({item_code:'A',qty:20,so_detail:null})).toEqual({});
  });
});
