import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/sales.ts', '../../packages/contracts/src/index.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
