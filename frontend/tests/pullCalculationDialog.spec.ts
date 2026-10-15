import { expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PullCalculationDialog from '@/components/dialogs/PullCalculationDialog.vue';
it('uses the modal spinner and blocks keyboard shortcuts until completion', async () => {
  const wrapper = mount(PullCalculationDialog, {props: {open: true}, attachTo: document.body});
  await wrapper.vm.$nextTick();
  expect(document.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('.animate-spin')).not.toBeNull();
  const key = new KeyboardEvent('keydown', {key: 'F2', bubbles: true, cancelable: true});
  document.dispatchEvent(key); expect(key.defaultPrevented).toBe(true);
  const escape = new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true});
  document.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(true);
  await wrapper.setProps({open: false});
  const released = new KeyboardEvent('keydown', {key: 'F2', bubbles: true, cancelable: true});
  document.dispatchEvent(released); expect(released.defaultPrevented).toBe(false);
  wrapper.unmount();
});
