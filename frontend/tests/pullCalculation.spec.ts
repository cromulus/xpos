import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPullCalculation } from '@/services/pullCalculation';
import { call } from '@/services/api';
vi.mock('@/services/api', () => ({call: vi.fn()}));
const api = vi.mocked(call);
const status = 'mulecity_erpnext.mule_feed_formula.pull_jobs.status';
describe('background pull calculation', () => {
  beforeEach(() => {vi.useFakeTimers(); api.mockReset();});
  afterEach(() => vi.useRealTimers());
  it('holds the loader through pending and updates only with the fresh completed quote', async () => {
    const busy = vi.fn();
    api.mockResolvedValueOnce({pending_jobs: ['one', 'two']})
      .mockResolvedValueOnce({one: 'ready', two: 'pending'})
      .mockResolvedValueOnce({one: 'ready', two: 'ready'})
      .mockResolvedValueOnce({orders_total: 42});
    const result = withPullCalculation('quote', '{}', () => true, busy);
    await vi.advanceTimersByTimeAsync(0);
    expect(busy.mock.calls).toEqual([[true]]);
    expect(api).toHaveBeenCalledWith(status, {keys: ['one', 'two']});
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({orders_total: 42});
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(api).toHaveBeenCalledTimes(4);
  });
  it.each(['failed', 'expired'])('unlocks on %s without using a provisional price', async state => {
    const busy = vi.fn();
    api.mockResolvedValueOnce({pending_jobs: ['one']}).mockResolvedValueOnce({one: state});
    await expect(withPullCalculation('quote', '{}', () => true, busy)).rejects.toThrow(/could not finish/);
    expect(busy).toHaveBeenLastCalledWith(false); expect(api).toHaveBeenCalledTimes(2);
  });
  it('unlocks when the network fails', async () => {
    const busy = vi.fn(); api.mockRejectedValueOnce(Error('offline'));
    await expect(withPullCalculation('quote', '{}', () => true, busy)).rejects.toThrow('offline');
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it('rejects a stale answer after an order change', async () => {
    let current = true;
    api.mockImplementationOnce(async () => {current = false; return {orders_total: 42};});
    await expect(withPullCalculation('quote', '{}', () => current, vi.fn())).rejects.toThrow(/order changed/);
  });
  it('unlocks after a bounded wait, including a request that never answers', async () => {
    const busy = vi.fn(); api.mockImplementationOnce(() => new Promise(() => {}));
    const result = withPullCalculation('quote', '{}', () => true, busy);
    const assertion = expect(result).rejects.toThrow(/longer than expected/);
    await vi.advanceTimersByTimeAsync(60000); await assertion;
    expect(busy).toHaveBeenLastCalledWith(false);
  });
});
