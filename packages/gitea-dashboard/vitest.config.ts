import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // L6/T073: spy leakage between tests (found in T070) — auto-restore
    // vi.spyOn mocks (and reset vi.fn state) after every test.
    restoreMocks: true,
  },
});
