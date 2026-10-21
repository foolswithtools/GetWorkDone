import { defineConfig } from 'vitest/config';

// Partition `unit` (.pattern-config.json): every tests/**/*.test.ts; no network, no credentials.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
