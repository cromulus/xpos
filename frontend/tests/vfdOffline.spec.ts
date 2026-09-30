/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ userName: 'Clerk' }) }));
vi.mock('@/services/api', () => ({ call: vi.fn() }));
vi.mock('@/services/dbBridge', () => ({ getOfflineMeta: vi.fn(), setOfflineMeta: vi.fn() }));
import { cartIdentity, validateOfflineCoverage, queuedInvoiceMethod, type VfdSnapshot, type VfdContext } from '@/services/vfdOffline';
import type { InvoiceData } from '@/types/pos.types';
const data = () => ({ local_id: 'ticket-1', pos_profile: 'Till', customer: 'Buyer', items: [
  { item_code: 'FEED', qty: 50, uom: 'Pound', conversion_factor: 1, sales_order: 'SO', so_detail: 'ROW', bom_no: 'BOM', mule_vfd: 'VFD' },
] } as unknown as InvoiceData);
const context: VfdContext = { profile: 'Till', company: 'Mill', cached_at: '2026-09-29 08:00:00', timezone: 'America/New_York', items: { FEED: true, CORN: false }, directives: { VFD: 1 }, user: 'Clerk' };
function snapshot(): VfdSnapshot { return { signature: 'server-only', payload: {
  version: 1, user: 'Clerk', company: 'Mill', prepared_at: '2026-09-29 08:00:00', timezone: 'America/New_York', cart: cartIdentity(data()),
  coverage: [{ row: 0, vfd: 'VFD', status: 1, drugs: ['CTC'], issue_date: '2026-09-01', expiry_date: '2026-09-30', approved_lbs: null, remaining_lbs: null }],
} }; }
const now = new Date('2026-09-30T15:00:00Z');
describe('a clerk picks up already-made medicated feed offline', () => {
  it('accepts exact prepared customer, ration, original directive and site-day', () => {
    expect(validateOfflineCoverage(data(), context, snapshot(), now)).toBe(true);
    expect(validateOfflineCoverage(data(), context, snapshot(), new Date('2026-10-01T02:00:00Z'))).toBe(true);
  });
  it.each(['customer', 'local_id', 'pos_profile'])('refuses changing %s after online preparation', key => {
    const changed = data(); (changed as any)[key] = 'Other';
    expect(() => validateOfflineCoverage(changed, context, snapshot(), now)).toThrow();
  });
  it.each(['item_code', 'qty', 'uom', 'conversion_factor', 'sales_order', 'so_detail', 'bom_no', 'mule_vfd'])('refuses changing row %s', key => {
    const changed = data(); (changed.items[0] as any)[key] = key === 'qty' ? 100 : 'Other';
    expect(() => validateOfflineCoverage(changed, context, snapshot(), now)).toThrow();
  });
  it('refuses expired, future, cancelled, capped and missing coverage before queueing', () => {
    for (const change of [{ expiry_date: '2026-09-29' }, { issue_date: '2026-10-01' }, { status: 2 }, { approved_lbs: 100 }, { remaining_lbs: 0 }, { drugs: [] }]) {
      const saved = snapshot(); Object.assign(saved.payload.coverage[0], change);
      expect(() => validateOfflineCoverage(data(), context, saved, now)).toThrow();
    }
    expect(() => validateOfflineCoverage(data(), context, null, now)).toThrow();
    expect(() => validateOfflineCoverage(data(), null, snapshot(), now)).toThrow();
  });
  it('refuses missing classification and clocks before preparation', () => {
    const sale = data(); sale.items[0].item_code = 'NEW';
    expect(() => validateOfflineCoverage(sale, context, null, now)).toThrow();
    expect(() => validateOfflineCoverage(data(), context, snapshot(), new Date('2026-09-28T15:00:00Z'))).toThrow();
  });
  it('keeps ordinary offline sale and queued replay routes separate', () => {
    const sale = data(); sale.items = [{ item_code: 'CORN', qty: 1 } as any];
    expect(validateOfflineCoverage(sale, context, null, now)).toBe(false);
    expect(queuedInvoiceMethod(sale)).toBe('xpos.api.invoices.create_invoice');
    expect(queuedInvoiceMethod({ mule_vfd_offline: { snapshot: snapshot() } })).toBe('mulecity_erpnext.vfd_offline.replay');
  });
});


it('compares the cart structurally after Frappe reorders JSON keys', () => {
  const saved = snapshot();
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  expect(validateOfflineCoverage(data(), context, sorted(saved), now)).toBe(true);
});

it('refuses a refreshed cancellation or another signed-in cashier before printing', () => {
  expect(() => validateOfflineCoverage(data(), { ...context, directives: { VFD: 2 } }, snapshot(), now)).toThrow();
  expect(() => validateOfflineCoverage(data(), context, snapshot(), now, 'Other')).toThrow();
});
