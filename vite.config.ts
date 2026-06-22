import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import type { Plugin } from 'vite';

function getExtensionPackages(): Set<string> {
  try {
    const manifestPath = resolve(__dirname, 'clawx-extensions.json');
    if (!existsSync(manifestPath)) return new Set();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const allIds: string[] = [
      ...(manifest.extensions?.main ?? []),
      ...(manifest.extensions?.renderer ?? []),
    ];
    const pkgs = new Set<string>();
    for (const id of allIds) {
      if (id.startsWith('builtin/')) continue;
      const parts = id.split('/');
      pkgs.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
    return pkgs;
  } catch {
    return new Set();
  }
}

const extensionPackages = getExtensionPackages();
const mainProcessBundledPackages = new Set([
  'core-util-is',
  'immediate',
  'inherits',
  'isarray',
  'jszip',
  'lie',
  'pako',
  'process-nextick-args',
  'readable-stream',
  'safe-buffer',
  'setimmediate',
  'string_decoder',
  'util-deprecate',
]);

function copyGatewayStaticScripts(): Plugin {
  const sourceDir = resolve(__dirname, 'electron/gateway');
  const outputDir = resolve(__dirname, 'dist-electron/main');
  const files = [
    'gateway-child-process-patch.cjs',
    'gateway-entry-wrapper.cjs',
    'gateway-fetch-preload.cjs',
  ];

  return {
    name: 'copy-gateway-static-scripts',
    closeBundle() {
      mkdirSync(outputDir, { recursive: true });
      for (const file of files) {
        copyFileSync(resolve(sourceDir, file), resolve(outputDir, file));
      }
    },
  };
}

function isMainProcessExternal(id: string): boolean {
  if (!id || id.startsWith('\0')) return false;
  if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)) return false;
  if (id.startsWith('@/') || id.startsWith('@electron/')) return false;
  for (const pkg of mainProcessBundledPackages) {
    if (id === pkg || id.startsWith(pkg + '/')) return false;
  }
  for (const pkg of extensionPackages) {
    if (id === pkg || id.startsWith(pkg + '/')) return false;
  }
  return true;
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['VITE_', 'CLAWX_']);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }

  return {
    // Required for Electron: all asset URLs must be relative because the renderer
    // loads via file:// in production. vite-plugin-electron-renderer sets this
    // automatically, but we declare it explicitly so the intent is clear and the
    // build remains correct even if plugin order ever changes.
    base: './',
    plugins: [
      react(),
      electron([
        {
          // Main process entry file
          entry: 'electron/main/index.ts',
          onstart(options) {
            options.startup();
          },
          vite: {
            plugins: [copyGatewayStaticScripts()],
            build: {
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: isMainProcessExternal,
              },
            },
          },
        },
        {
          // Preload scripts entry file
          entry: 'electron/preload/index.ts',
          onstart(options) {
            options.reload();
          },
          vite: {
            build: {
              outDir: 'dist-electron/preload',
              rollupOptions: {
                external: ['electron'],
              },
            },
          },
        },
      ]),
      renderer(),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@electron': resolve(__dirname, 'electron'),
      },
      dedupe: ['react', 'react-dom', 'react-i18next', 'zustand', 'sonner', 'lucide-react'],
    },
    server: {
      port: Number(process.env.VITE_DEV_SERVER_PORT || 5173),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
