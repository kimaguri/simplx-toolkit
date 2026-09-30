import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

describe('fakeBrowser smoke', () => {
  it('round-trips a value through storage.local', async () => {
    await fakeBrowser.storage.local.set({ hello: 'world' });
    const result = await fakeBrowser.storage.local.get('hello');
    expect(result.hello).toBe('world');
  });
});
