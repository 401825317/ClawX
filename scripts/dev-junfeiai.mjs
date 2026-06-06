#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEVELOPMENT_ORIGIN = 'https://junfeiai.com';

function parseArgs(argv) {
  const options = {
    backend: process.env.CLAWX_JUNFEIAI_BACKEND_ORIGIN || process.env.CLAWX_JUNFEIAI_ORIGIN || DEVELOPMENT_ORIGIN,
    provider: process.env.CLAWX_JUNFEIAI_PROVIDER_BASE_URL || process.env.CLAWX_JUNFEIAI_BASE_URL || '',
    port: process.env.VITE_DEV_SERVER_PORT || '5173',
  };

  for (const arg of argv) {
    if (arg.startsWith('--backend=')) {
      options.backend = arg.slice('--backend='.length);
    } else if (arg.startsWith('--provider=')) {
      options.provider = arg.slice('--provider='.length);
    } else if (arg.startsWith('--port=')) {
      options.port = arg.slice('--port='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  options.backend = normalizeOrigin(options.backend);
  options.provider = normalizeProviderBaseUrl(options.provider || `${options.backend}/v1`);
  return options;
}

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeProviderBaseUrl(value) {
  const normalized = normalizeOrigin(value);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function printHelp() {
  console.log(`Usage:
  pnpm run dev:junfeiai -- --backend=http://127.0.0.1:8080 --provider=http://127.0.0.1:8080/v1

Options:
  --backend=<url>   JunFeiAI/Sub2API auth backend for /api/clawx/*.
  --provider=<url>  Model provider base URL written into OpenClaw runtime.
  --port=<port>     Vite dev server port. Defaults to 5173.
`);
}

const options = parseArgs(process.argv.slice(2));
const env = {
  ...process.env,
  CLAWX_MANAGED_PROVIDER: process.env.CLAWX_MANAGED_PROVIDER || '1',
  CLAWX_JUNFEIAI_BACKEND_ORIGIN: options.backend,
  CLAWX_JUNFEIAI_PROVIDER_BASE_URL: options.provider,
  VITE_DEV_SERVER_PORT: options.port,
};

console.log('[dev:junfeiai] backend:', env.CLAWX_JUNFEIAI_BACKEND_ORIGIN);
console.log('[dev:junfeiai] provider:', env.CLAWX_JUNFEIAI_PROVIDER_BASE_URL);
console.log('[dev:junfeiai] vite port:', env.VITE_DEV_SERVER_PORT);

const command = process.platform === 'win32'
  ? process.env.ComSpec || 'cmd.exe'
  : 'pnpm';
const commandArgs = process.platform === 'win32'
  ? ['/d', '/c', 'npx.cmd --yes pnpm@10.33.4 run dev']
  : ['run', 'dev'];
const child = spawn(command, commandArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
