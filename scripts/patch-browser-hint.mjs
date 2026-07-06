#!/usr/bin/env node
/**
 * Patch OpenClaw browser runtime behavior for dev mode.
 *
 * This runs as postinstall to patch node_modules. Production builds call the
 * same shared patch from bundle-openclaw.mjs after copying OpenClaw.
 */

import { patchInstalledOpenClawBrowserRuntime } from './openclaw-browser-runtime-patch.mjs';
import { patchInstalledOpenClawFinalizeLocalActionRuntime } from './openclaw-finalize-local-action-patch.mjs';
import { patchInstalledOpenClawPromptCacheKeyRuntime } from './openclaw-prompt-cache-key-patch.mjs';

try {
  patchInstalledOpenClawBrowserRuntime();
  patchInstalledOpenClawFinalizeLocalActionRuntime();
  patchInstalledOpenClawPromptCacheKeyRuntime();
} catch {
  // openclaw not installed yet or dist not found - skip silently
}
