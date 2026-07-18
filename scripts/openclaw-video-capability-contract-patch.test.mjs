import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  patchOpenClawVideoCapabilityContractRuntime,
  resolveMappedVideoSizeForCapabilityContract,
  resolveOpenAiVideoCapabilityContractProfile,
} from './openclaw-video-capability-contract-patch.mjs';

const endpoints = JSON.parse(readFileSync(join(process.cwd(), 'shared', 'junfeiai-endpoints.json'), 'utf8'));
const configuredVideoSizes = [
  endpoints.videoGenerationDefaults.sizes.landscape,
  endpoints.videoGenerationDefaults.sizes.portrait,
  endpoints.videoGenerationDefaults.sizes.square,
];
const grokVideoSizes = [
  ...configuredVideoSizes,
  '1280x720',
  '720x1280',
  '1024x1024',
];

assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '480P',
  aspectRatio: '9:16',
  supportedSizes: grokVideoSizes,
}), endpoints.videoGenerationDefaults.sizes.portrait);
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '480P',
  aspectRatio: '16:9',
  supportedSizes: grokVideoSizes,
}), endpoints.videoGenerationDefaults.sizes.landscape);
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '480P',
  aspectRatio: '1:1',
  supportedSizes: grokVideoSizes,
}), endpoints.videoGenerationDefaults.sizes.square);
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: '9:16',
  supportedSizes: grokVideoSizes,
}), '720x1280');
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: '16:9',
  supportedSizes: grokVideoSizes,
}), '1280x720');
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: '1:1',
  supportedSizes: grokVideoSizes,
}), '1024x1024');
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: 'adaptive',
  supportedSizes: ['1280x720', '720x1280'],
}), undefined);

assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile('grok-image-video', 'generate'), {
  maxVideos: 1,
  maxDurationSeconds: 15,
  supportedDurationSeconds: [4, 6, 8, 10, 12, 15],
  supportsSize: true,
  sizes: grokVideoSizes,
});
assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile('grok-video-1.5', 'generate'), {
  enabled: false,
});
assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile('grok-video-1.5', 'imageToVideo'), {
  enabled: true,
  maxInputImages: 1,
  maxVideos: 1,
  maxDurationSeconds: 15,
  supportedDurationSeconds: [4, 6, 8, 10, 12, 15],
  supportsSize: true,
  sizes: grokVideoSizes,
});
assert.equal(resolveOpenAiVideoCapabilityContractProfile('sora-2', 'generate'), undefined);

const sourceDist = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const files = readdirSync(sourceDist)
  .filter((entry) => entry.endsWith('.js'))
  .map((entry) => ({
    file: join(sourceDist, entry),
    content: readFileSync(join(sourceDist, entry), 'utf8'),
  }));
const targets = [
  files.find((entry) => entry.content.includes('function createVideoGenerateTool(options)')),
  files.find((entry) => entry.content.includes('function resolveVideoGenerationOverrides(params)')),
  files.find((entry) => entry.content.includes('function buildOpenAIVideoGenerationProvider()')),
];
assert.ok(targets.every(Boolean), 'expected tool, runtime, and OpenAI provider fixtures');

const fixtureDist = mkdtempSync(join(tmpdir(), 'uclaw-video-capability-contract-'));
try {
  for (const target of targets) cpSync(target.file, join(fixtureDist, basename(target.file)));
  const first = patchOpenClawVideoCapabilityContractRuntime(fixtureDist, {
    logger: { log() {} },
  });
  assert.equal(first.matchedFiles, 3);
  assert.equal(first.patchedFiles + first.alreadyPatchedFiles, 3);

  const patchedContents = readdirSync(fixtureDist)
    .map((entry) => readFileSync(join(fixtureDist, entry), 'utf8'));
  const toolContent = patchedContents.find((content) => content.includes('function createVideoGenerateTool(options)'));
  const runtimeContent = patchedContents.find((content) => content.includes('function resolveVideoGenerationOverrides(params)'));
  const providerContent = patchedContents.find((content) => content.includes('function buildOpenAIVideoGenerationProvider()'));

  assert.match(toolContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_TOOL_V1/u);
  assert.match(toolContent, /Active primary profile:/u);
  assert.match(toolContent, /activeProfile: activeCapabilityProfile/u);
  assert.match(toolContent, /details: \{\s*\.\.\.result\.details,\s*activeProfile/u);
  assert.match(toolContent, /else delete properties\.audio/u);
  assert.match(toolContent, /else delete properties\.watermark/u);
  assert.match(toolContent, /does not support text-to-video/u);
  assert.match(runtimeContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_RUNTIME_V2/u);
  assert.doesNotMatch(runtimeContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_RUNTIME_V1/u);
  assert.match(runtimeContent, /caps\.modelCapabilities\?\.\[model\]/u);
  assert.match(runtimeContent, /derivedFrom: "resolution\+aspectRatio"/u);
  assert.match(runtimeContent, new RegExp(`UCLAW_VIDEO_DEFAULT_RESOLUTION = ${JSON.stringify(endpoints.videoGenerationDefaults.resolution.toUpperCase())}`, 'u'));
  assert.match(runtimeContent, /configuredDefaultSize && params\.supportedSizes\?\.includes\(configuredDefaultSize\)/u);
  assert.match(runtimeContent, /resolution = void 0/u);
  assert.match(runtimeContent, /audio = void 0/u);
  assert.match(runtimeContent, /watermark = void 0/u);
  assert.match(providerContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V2/u);
  assert.doesNotMatch(providerContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V1/u);
  assert.match(providerContent, /UCLAW_OPENAI_GROK_VIDEO_SECONDS/u);
  assert.match(providerContent, /UCLAW_OPENAI_GROK_VIDEO_SIZES/u);
  assert.match(providerContent, new RegExp(`UCLAW_OPENAI_GROK_VIDEO_DEFAULT_SIZE = ${JSON.stringify(endpoints.videoGenerationDefaults.sizes.landscape)}`, 'u'));
  assert.match(providerContent, new RegExp(`"16:9": ${JSON.stringify(endpoints.videoGenerationDefaults.sizes.landscape)}`, 'u'));
  assert.match(providerContent, new RegExp(`"9:16": ${JSON.stringify(endpoints.videoGenerationDefaults.sizes.portrait)}`, 'u'));
  assert.match(providerContent, new RegExp(`"1:1": ${JSON.stringify(endpoints.videoGenerationDefaults.sizes.square)}`, 'u'));
  assert.match(providerContent, /if \(grokVideoModel\) return UCLAW_OPENAI_GROK_VIDEO_DEFAULT_SIZE/u);
  assert.match(providerContent, /resolveDurationSeconds\(req\.durationSeconds, model\)/u);
  assert.match(providerContent, /grok-video-1\.5 requires exactly one reference image/u);
  assert.match(providerContent, /const OPENAI_VIDEO_SECONDS = \[\s*4,\s*8,\s*12\s*\]/u);

  for (const entry of readdirSync(fixtureDist)) {
    const checked = spawnSync(process.execPath, ['--check', join(fixtureDist, entry)], {
      encoding: 'utf8',
    });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  }

  const second = patchOpenClawVideoCapabilityContractRuntime(fixtureDist, {
    logger: { log() {} },
  });
  assert.deepEqual(second, {
    matchedFiles: 3,
    patchedFiles: 0,
    alreadyPatchedFiles: 3,
  });
} finally {
  rmSync(fixtureDist, { recursive: true, force: true });
}

console.log('openclaw video capability contract patch tests passed');
