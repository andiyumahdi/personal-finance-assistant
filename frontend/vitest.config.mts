import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// V2 Phase 9 (contract §15 `fe` leg): the smallest frontend test stack.
// No @vitejs/plugin-react - Vite 8 (rolldown/oxc) transforms TSX itself.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  // tsconfig keeps Next's required `jsx: "preserve"`; without this oxc
  // honors it and JSX reaches import analysis untransformed.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
