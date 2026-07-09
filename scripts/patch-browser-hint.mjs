#!/usr/bin/env node
/**
 * Patch OpenClaw browser runtime behavior for dev mode.
 *
 * This runs as postinstall to patch node_modules. Production builds call the
 * same shared patch from bundle-openclaw.mjs after copying OpenClaw.
 */

import { patchInstalledOpenClawBrowserRuntime } from './openclaw-browser-runtime-patch.mjs';
import { patchInstalledOpenClawFinalizeLocalActionRuntime } from './openclaw-finalize-local-action-patch.mjs';
import { patchInstalledOpenClawModelRequestContractRuntime } from './openclaw-model-request-contract-patch.mjs';
import { patchInstalledOpenClawPromptCacheKeyRuntime } from './openclaw-prompt-cache-key-patch.mjs';
import { patchInstalledOpenClawRawToolSignalRuntime } from './openclaw-raw-tool-signal-patch.mjs';
import { patchInstalledOpenClawReplySessionInitConflictRuntime } from './openclaw-reply-session-init-conflict-patch.mjs';

const ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH = process.env.CLAWX_ENABLE_OPENCLAW_BROWSER_PATCH === '1';
const ENABLE_OPENCLAW_LOCAL_ACTION_FINALIZE_PATCH = process.env.CLAWX_ENABLE_OPENCLAW_LOCAL_ACTION_FINALIZE_PATCH === '1';

try {
  if (ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH) {
    patchInstalledOpenClawBrowserRuntime();
  }
  if (ENABLE_OPENCLAW_LOCAL_ACTION_FINALIZE_PATCH) {
    patchInstalledOpenClawFinalizeLocalActionRuntime();
  }
  patchInstalledOpenClawReplySessionInitConflictRuntime();
  patchInstalledOpenClawPromptCacheKeyRuntime();
  patchInstalledOpenClawModelRequestContractRuntime();
  patchInstalledOpenClawRawToolSignalRuntime();
} catch (error) {
  console.error(
    `[patch-browser-hint] Failed to patch OpenClaw runtime: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
