#!/usr/bin/env node
/**
 * Patch OpenClaw browser runtime behavior for dev mode.
 *
 * This runs as postinstall to patch node_modules. Production builds call the
 * same shared patch from bundle-openclaw.mjs after copying OpenClaw.
 */

import { patchInstalledOpenClawBrowserRuntime } from './openclaw-browser-runtime-patch.mjs';
import { patchInstalledOpenClawBrowserLifecycleRuntime } from './openclaw-browser-lifecycle-patch.mjs';
import { patchInstalledOpenClawCronRuntimePolicy } from './openclaw-cron-runtime-policy-patch.mjs';
import { cleanupInstalledOpenClawRequiredContractToolRuntime } from './openclaw-contract-tool-cleanup.mjs';
import { patchInstalledOpenClawFinalizeLocalActionRuntime } from './openclaw-finalize-local-action-patch.mjs';
import { patchInstalledOpenClawModelRequestContractRuntime } from './openclaw-model-request-contract-patch.mjs';
import { patchInstalledOpenClawNativeImageDeliveryRuntime } from './openclaw-native-image-delivery-patch.mjs';
import { patchInstalledOpenClawNativeMediaCancellationRuntime } from './openclaw-native-media-cancellation-patch.mjs';
import { patchInstalledOpenClawManagedMediaTimeoutRuntime } from './openclaw-managed-media-timeout-patch.mjs';
import { cleanupInstalledOpenClawNativeMediaAcceptanceRuntime } from './openclaw-native-media-acceptance-cleanup.mjs';
import { patchInstalledOpenClawVideoActualSpecRuntime } from './openclaw-video-actual-spec-patch.mjs';
import { patchInstalledOpenClawVideoCapabilityContractRuntime } from './openclaw-video-capability-contract-patch.mjs';
import { patchInstalledOpenClawVideoProviderCatalogRuntime } from './openclaw-video-provider-catalog-patch.mjs';
import { patchInstalledOpenClawVideoSegmentDedupeRuntime } from './openclaw-video-segment-dedupe-patch.mjs';
import { patchInstalledOpenClawPluginToolRunContextRuntime } from './openclaw-plugin-tool-run-context-patch.mjs';
import { patchInstalledOpenClawPromptCacheKeyRuntime } from './openclaw-prompt-cache-key-patch.mjs';
import { patchInstalledOpenClawRawToolSignalRuntime } from './openclaw-raw-tool-signal-patch.mjs';
import { patchInstalledOpenClawReplySessionInitConflictRuntime } from './openclaw-reply-session-init-conflict-patch.mjs';
import { patchInstalledOpenClawResponsesCompatibleFallbackRuntime } from './openclaw-responses-compatible-fallback-patch.mjs';
import { patchInstalledOpenClawCompactionSessionStateRuntime } from './openclaw-compaction-session-state-patch.mjs';
import { patchInstalledOpenClawSessionCwdRuntime } from './openclaw-session-cwd-runtime-patch.mjs';
import { patchInstalledOpenClawStreamingRuntime } from './openclaw-streaming-runtime-patch.mjs';
import { patchInstalledOpenClawSystemPromptReasoningLabelRuntime } from './openclaw-system-prompt-reasoning-label-patch.mjs';
import { patchInstalledOpenClawTaskSummaryDeliveryRuntime } from './openclaw-task-summary-delivery-patch.mjs';
import { patchInstalledOpenClawToolDirectoryI18nRuntime } from './openclaw-tool-directory-i18n-patch.mjs';

const ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH = process.env.CLAWX_ENABLE_OPENCLAW_BROWSER_PATCH === '1';

try {
  if (ENABLE_OPENCLAW_BROWSER_RUNTIME_PATCH) {
    patchInstalledOpenClawBrowserRuntime();
  }
  patchInstalledOpenClawBrowserLifecycleRuntime();
  patchInstalledOpenClawCronRuntimePolicy();
  patchInstalledOpenClawFinalizeLocalActionRuntime();
  patchInstalledOpenClawReplySessionInitConflictRuntime();
  patchInstalledOpenClawCompactionSessionStateRuntime();
  patchInstalledOpenClawSessionCwdRuntime();
  patchInstalledOpenClawPromptCacheKeyRuntime();
  patchInstalledOpenClawResponsesCompatibleFallbackRuntime();
  patchInstalledOpenClawSystemPromptReasoningLabelRuntime();
  patchInstalledOpenClawToolDirectoryI18nRuntime();
  cleanupInstalledOpenClawRequiredContractToolRuntime();
  patchInstalledOpenClawStreamingRuntime();
  patchInstalledOpenClawModelRequestContractRuntime();
  patchInstalledOpenClawRawToolSignalRuntime();
  patchInstalledOpenClawPluginToolRunContextRuntime();
  patchInstalledOpenClawNativeMediaCancellationRuntime();
  patchInstalledOpenClawManagedMediaTimeoutRuntime();
  patchInstalledOpenClawNativeImageDeliveryRuntime();
  cleanupInstalledOpenClawNativeMediaAcceptanceRuntime();
  patchInstalledOpenClawVideoSegmentDedupeRuntime();
  patchInstalledOpenClawVideoProviderCatalogRuntime();
  patchInstalledOpenClawVideoCapabilityContractRuntime();
  patchInstalledOpenClawVideoActualSpecRuntime();
  patchInstalledOpenClawTaskSummaryDeliveryRuntime();
} catch (error) {
  console.error(
    `[patch-browser-hint] Failed to patch OpenClaw runtime: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
