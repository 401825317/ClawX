import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const nodeHttpsBuiltinPlugin = {
  name: 'uclaw-test-node-https-builtin',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'https' || id === 'node:https') {
      return { id: 'node:https', external: true };
    }
    return null;
  },
};

export default defineConfig({
  // pptxgenjs depends on an npm package named `https`. Keep both Node
  // specifier forms bound to the builtin so Vite never resolves that package
  // while transforming Main-process unit tests.
  plugins: [nodeHttpsBuiltinPlugin, react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
});
