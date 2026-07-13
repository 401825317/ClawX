import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  patchOpenClawManagedMediaTimeoutContent,
  patchOpenClawManagedMediaTimeoutRuntime,
} from './openclaw-managed-media-timeout-patch.mjs';

const timeouts = {
  imageTimeoutMs: 1_800_000,
  videoTimeoutMs: 1_800_000,
  videoPollIntervalMs: 5_000,
  videoPollMaxAttempts: 361,
};
const toolFixture = 'const timeoutMs = readGenerationTimeoutMs(args) ?? videoGenerationModelConfig.timeoutMs;';
const providerFixture = `// extensions/openai/video-generation-provider.ts
const DEFAULT_TIMEOUT_MS = 12e4;
const POLL_INTERVAL_MS = 2500;
const MAX_POLL_ATTEMPTS = 120;
const options = {
  isComplete: (payload) => payload.status === "completed",
};
function resolveOpenAIVideoDownloadTimeoutMs(timeoutMs) {}
async function downloadOpenAIVideo(params) {
\tconst url = new URL(\`${'${params.baseUrl}'}/videos/${'${params.videoId}'}/content\`);
\turl.searchParams.set("variant", "video");
}
const result = await downloadOpenAIVideo({
\t\t\t\t\t\tbaseUrl,
\t\t\t\t\t\tsignal: req.signal,
\t\t\t\t\t\tfetchFn,
\t\t\t\t\t\tallowPrivateNetwork,
\t\t\t\t\t\tdispatcherPolicy,
\t\t\t\t\t\tmaxBytes:
});`;

const patchedTool = patchOpenClawManagedMediaTimeoutContent(toolFixture, 'tools.js', timeouts);
assert.equal(patchedTool.category, 'media-tool');
assert.match(patchedTool.content, /videoGenerationModelConfig\.timeoutMs \?\? 1800000/);
assert.doesNotMatch(patchedTool.content, /readGenerationTimeoutMs/);

const patchedProvider = patchOpenClawManagedMediaTimeoutContent(providerFixture, 'provider.js', timeouts);
assert.equal(patchedProvider.category, 'openai-video-provider');
assert.match(patchedProvider.content, /const DEFAULT_TIMEOUT_MS = 1800000/);
assert.match(patchedProvider.content, /const POLL_INTERVAL_MS = 5000/);
assert.match(patchedProvider.content, /const MAX_POLL_ATTEMPTS = 361/);
assert.match(patchedProvider.content, /\["completed", "done", "succeeded"\]\.includes\(payload\.status\)/);
assert.match(patchedProvider.content, /Boolean\(resolveOpenAIVideoOutputUrl\(payload\)\)/);
assert.match(patchedProvider.content, /UCLAW_MANAGED_VIDEO_OUTPUT_URL_V1/);
assert.match(patchedProvider.content, /outputUrl: resolveOpenAIVideoOutputUrl\(completed\)/);

const distDir = mkdtempSync(join(tmpdir(), 'uclaw-managed-media-timeout-'));
writeFileSync(join(distDir, 'tools.js'), toolFixture, 'utf8');
writeFileSync(join(distDir, 'provider.js'), providerFixture, 'utf8');

const first = patchOpenClawManagedMediaTimeoutRuntime(distDir, { logger: { log() {} } });
assert.equal(first.patchedFiles, 2);
assert.equal(first.categoryCounts['media-tool'], 1);
assert.equal(first.categoryCounts['openai-video-provider'], 1);
assert.match(readFileSync(join(distDir, 'provider.js'), 'utf8'), /UCLAW_MANAGED_MEDIA_TIMEOUT_V1/);

const second = patchOpenClawManagedMediaTimeoutRuntime(distDir, { logger: { log() {} } });
assert.equal(second.patchedFiles, 0);
assert.equal(second.alreadyPatchedFiles, 2);

console.log('openclaw managed media timeout patch tests passed');
