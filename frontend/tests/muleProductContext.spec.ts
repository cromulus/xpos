/** Madison recognizes a feed and sees her customer's work without opening a menu. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import MuleWorkspace from '@/components/MuleWorkspace.vue';
import MuleNutrition from '@/components/MuleNutrition.vue';
let wrapper: ReturnType<typeof mount>;
afterEach(() => wrapper?.unmount());
function button(text: string) { return [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!; }
async function setup(request: any) {
  HTMLDialogElement.prototype.showModal ??= function () {};
  Element.prototype.scrollIntoView = vi.fn();
  wrapper = mount(MuleWorkspace, {props: {customer: 'C1', customerName: 'Madison', profile: 'Till', request}, attachTo: document.body});
  await flushPromises();
}
describe('Counter product context', () => {
  it('defaults to this customer, then explicitly searches other owners without changing the buyer', async () => {
    const request = vi.fn(async (method: string) => method.endsWith('find_mixes') ? {rows: [], has_more: false} : []);
    await setup(request); button('Customer Mixes').click(); await flushPromises();
    expect(request).toHaveBeenCalledWith(expect.stringContaining('find_mixes'), expect.objectContaining({customer: 'C1'}));
    const check = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    check.checked = false; check.dispatchEvent(new Event('change')); await flushPromises();
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining('find_mixes'), expect.objectContaining({customer: null}));
    expect(document.body.textContent).toContain('Buyer: Madison');
  });
  it('announces open orders before any click and clears the old customer immediately', async () => {
    const request = vi.fn(async (_: string, args: any) => args.customer === 'C1' ? [{name: 'SO-1', progress: 'With the mill'}] : []);
    await setup(request);
    expect(wrapper.text()).toContain('1 open order(s) · With the mill');
    await wrapper.setProps({customer: 'C2'}); await flushPromises();
    expect(wrapper.text()).not.toContain('With the mill');
  });
  it('shows failure to check orders rather than implying no orders', async () => {
    await setup(vi.fn().mockRejectedValue(new Error('offline')));
    expect(wrapper.text()).toContain('Could not check orders — retry');
  });
  it('shows ingredients and recorded purchase quantities and price, not hash-only identification', async () => {
    const row = {name: 'MIX1', item_name: 'Formula ABCD1234', display_name: 'Corn, Barley', ingredients: ['Corn', 'Barley'], mule_animal_search: 'Cattle', last_purchase: {date: '2026-09-20', bags: 20, pounds: 1000, amount: 245, currency: 'USD'}};
    await setup(vi.fn(async (method: string) => method.endsWith('find_mixes') ? {rows: [row], has_more: false} : []));
    button('Customer Mixes').click(); await flushPromises();
    expect(document.body.textContent).toContain('Corn, Barley');
    expect(document.body.textContent).toContain('20 bags / 1000 lb');
    expect(document.body.textContent).toContain('$245.00 before tax');
    expect(document.body.textContent).not.toContain('Formula ABCD1234');
  });
  it('ignores a late recipe response after changing customers', async () => {
    let finish: (value: unknown) => void = () => {};
    const request = vi.fn((method: string) => {
      if (method.endsWith('mix_details')) return new Promise(resolve => { finish = resolve; });
      return Promise.resolve(method.endsWith('find_mixes') ? {rows: [{name: 'M1', item_name: 'Feed'}], has_more: false} : []);
    });
    await setup(request); button('Customer Mixes').click(); await flushPromises();
    button('View recipe').click(); await flushPromises();
    await wrapper.setProps({customer: 'C2'}); await flushPromises();
    finish({bom: 'BOM-OLD', ingredients: [{item_name: 'Wrong customer recipe'}]});
    await flushPromises();
    expect(document.body.textContent).not.toContain('Wrong customer recipe');
  });
  it('keeps a known zero distinct from missing nutrient analysis', () => {
    wrapper = mount(MuleNutrition, {props: {values: {protein_pct: 0, fat_pct: null}}});
    expect(wrapper.text()).toContain('0.00%'); expect(wrapper.text()).toContain('Unknown');
  });
});
