#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const options = {
    port: process.env.VITE_DEV_SERVER_PORT || '5173',
    failOpenAiOnce: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--port=')) {
      options.port = arg.slice('--port='.length);
    } else if (arg === '--fail-openai-once') {
      options.failOpenAiOnce = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  pnpm run dev:junfeiai -- --port=5173
  pnpm run dev:junfeiai -- --fail-openai-once

Options:
  --port=<port>     Vite dev server port. Defaults to 5173.
  --fail-openai-once
                    Simulate one OpenAI Provider failure in a real chat turn,
                    then continue through the configured fallback Provider.

JunFeiAI endpoints and protocol are read from shared/junfeiai-endpoints.json
in both development and packaged builds.
`);
}

const options = parseArgs(process.argv.slice(2));
const {
  CLAWX_JUNFEIAI_BACKEND_ORIGIN: _backendOrigin,
  CLAWX_JUNFEIAI_ORIGIN: _origin,
  CLAWX_JUNFEIAI_PROVIDER_BASE_URL: _providerBaseUrl,
  CLAWX_JUNFEIAI_BASE_URL: _baseUrl,
  CLAWX_TEXT_FAILOVER_TEST_ALLOWED: _testAllowed,
  CLAWX_TEXT_FAILOVER_TEST_MODE: _testMode,
  ...baseEnv
} = process.env;
const env = {
  ...baseEnv,
  CLAWX_MANAGED_PROVIDER: process.env.CLAWX_MANAGED_PROVIDER || '1',
  VITE_DEV_SERVER_PORT: options.port,
  ...(options.failOpenAiOnce
    ? {
      CLAWX_TEXT_FAILOVER_TEST_ALLOWED: '1',
      CLAWX_TEXT_FAILOVER_TEST_MODE: 'fail-primary-once',
    }
    : {}),
};

console.log('[dev:junfeiai] endpoints: shared/junfeiai-endpoints.json');
console.log('[dev:junfeiai] vite port:', env.VITE_DEV_SERVER_PORT);
if (options.failOpenAiOnce) {
  console.log('[dev:junfeiai] OpenAI one-time Provider failure is armed');
}

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
