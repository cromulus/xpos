/** Prepared native pickups reuse the existing queue; a cached clock is not proof of sale time. */
import { useAuthStore } from '@/stores/authStore';
import { getApiBaseUrlSync } from '@/services/electronBridge';
import { call } from '@/services/api';
import { getOfflineMeta, setOfflineMeta } from '@/services/dbBridge';
import type { InvoiceData } from '@/types/pos.types';

const endpoint = 'mulecity_erpnext.vfd_offline';
const fields = ['item_code', 'qty', 'uom', 'conversion_factor', 'sales_order', 'so_detail', 'bom_no', 'mule_vfd'];
export interface VfdContext {
  profile: string; company: string; cached_at: string; timezone: string;
  items: Record<string, boolean>; directives: Record<string, number>; user: string;
}
export interface VfdSnapshot {
  signature: string;
  payload: {
    version: number; user: string; company: string; prepared_at: string; timezone: string;
    cart: ReturnType<typeof cartIdentity>;
    coverage: Array<{ row: number; vfd: string; status: number; drugs: string[];
      issue_date: string; expiry_date: string; approved_lbs: number | null; remaining_lbs: number | null }>;
  };
}
export function cartIdentity(data: InvoiceData) {
  return {
    local_id: String(data.local_id || ''), pos_profile: String(data.pos_profile || ''),
    customer: String(data.customer || ''),
    items: data.items.map(row => Object.fromEntries(fields.map(key => [key,
      key === 'qty' || key === 'conversion_factor'
        ? Number((row as any)[key] || (key === 'conversion_factor' ? 1 : 0))
        : String((row as any)[key] || '')]))),
  };
}
function dayAt(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function cacheKey(key: string): string {
  return `${getApiBaseUrlSync() || window.location.origin}::${useAuthStore().userName}::${key}`;
}
export async function refreshVfdContext(profile: string): Promise<void> {
  const context = await call<VfdContext>(`${endpoint}.context`, { pos_profile: profile });
  if (!context?.items || context.profile !== profile) throw new Error('VFD offline context is unavailable.');
  // A failed refresh leaves prior pending tickets and their evidence intact.
  await setOfflineMeta(cacheKey(`vfd_context::${profile}`), context);
}
export async function prepareVfdPickup(data: InvoiceData): Promise<void> {
  if (!data.items.some(row => (row as any).mule_vfd || (row as any).so_detail)) return;
  const key = cacheKey(`vfd_pickup::${data.local_id}`);
  try {
    await setOfflineMeta(key, null);
    const snapshot = await call<VfdSnapshot | null>(`${endpoint}.prepare`, { data: JSON.stringify(data) });
    if (snapshot) await setOfflineMeta(key, snapshot);
  } catch (error) {
    // Optional offline preparation never blocks an otherwise valid online sale.
    // Pending sold tickets already retain their own immutable embedded evidence.
    console.warn('[XPOS] Offline VFD preparation unavailable:', error);
  }
}
export function validateOfflineCoverage(data: InvoiceData, context: VfdContext | null,
  snapshot: VfdSnapshot | null, now = new Date(), user = useAuthStore().userName): boolean {
  if (!context || context.profile !== data.pos_profile || context.user !== user) throw new Error('Go online to refresh feed coverage before selling offline.');
  for (const row of data.items) {
    if (!Object.hasOwn(context.items, row.item_code)) throw new Error('This item has no cached feed coverage. Go online before selling.');
  }
  const regulated = data.items.map((row, index) => context.items[row.item_code] || (row as any).mule_vfd ? index : -1).filter(index => index >= 0);
  if (!regulated.length) return false;
  if (data.is_return) throw new Error('Return medicated feed online against its original invoice.');
  if (!snapshot || JSON.stringify(cartIdentity(snapshot.payload.cart as unknown as InvoiceData)) !== JSON.stringify(cartIdentity(data))
      || snapshot.payload.company !== context.company || snapshot.payload.user !== user) throw new Error('Prepare this exact medicated pickup online before selling offline.');
  const today = dayAt(now, snapshot.payload.timezone);
  if (today < snapshot.payload.prepared_at.slice(0, 10)) throw new Error('The till clock precedes the coverage check. Go online.');
  for (const index of regulated) {
    const row = data.items[index] as any;
    const coverage = snapshot.payload.coverage.find(entry => entry.row === index);
    if (!coverage || !row.so_detail || !row.sales_order || !row.bom_no || coverage.vfd !== row.mule_vfd
        || !coverage.drugs.length || coverage.status !== 1 || context.directives[coverage.vfd] !== 1 || today < coverage.issue_date || today > coverage.expiry_date)
      throw new Error('The original VFD does not cover this offline pickup today.');
    if (coverage.approved_lbs != null || coverage.remaining_lbs != null)
      throw new Error('Quantity-limited VFD pickups require an online checkout.');
  }
  return true;
}
export async function attachOfflineCoverage(data: InvoiceData): Promise<void> {
  const context = await getOfflineMeta(cacheKey(`vfd_context::${data.pos_profile}`)) as VfdContext | null;
  const snapshot = await getOfflineMeta(cacheKey(`vfd_pickup::${data.local_id}`)) as VfdSnapshot | null;
  if (validateOfflineCoverage(data, context, snapshot)) {
    (data as any).mule_vfd_offline = { snapshot, sold_at: new Date().toISOString() };
  }
}
export function queuedInvoiceMethod(data: unknown): string {
  return (data as any)?.mule_vfd_offline ? `${endpoint}.replay` : 'xpos.api.invoices.create_invoice';
}
