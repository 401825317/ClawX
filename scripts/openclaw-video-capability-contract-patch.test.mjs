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
  patchOpenClawOpenAiVideoCapabilityContent,
  patchOpenClawVideoCapabilityContractRuntime,
  resolveMappedVideoSizeForCapabilityContract,
  resolveOpenAiVideoCapabilityContractProfile,
} from './openclaw-video-capability-contract-patch.mjs';

const managedVideoContract = {
  contractVersion: 1,
  defaultModel: 'grok-image-video',
  defaultSize: '1280x720',
  defaultDurationSeconds: 6,
  models: [
    {
      id: 'grok-image-video',
      label: 'Grok Image Video',
      modes: ['text-to-video', 'image-to-video', 'video-to-video'],
      sizes: ['854x480', '1280x720', '720x1280', '1024x1024'],
      durations: [6, 10, 15],
      defaultSize: '1280x720',
      defaultDurationSeconds: 6,
      requiresImage: false,
      enabled: true,
    },
    {
      id: 'grok-video-1.5',
      label: 'Grok Video 1.5',
      modes: ['image-to-video'],
      sizes: ['854x480', '1280x720', '720x1280', '1024x1024'],
      durations: [6, 10, 15],
      defaultSize: '1280x720',
      defaultDurationSeconds: 6,
      requiresImage: true,
      enabled: true,
    },
  ],
};

assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: '9:16',
  supportedSizes: ['1280x720', '720x1280'],
}), '720x1280');
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: '16:9',
  supportedSizes: ['1280x720', '720x1280'],
}), '1280x720');
assert.equal(resolveMappedVideoSizeForCapabilityContract({
  resolution: '720P',
  aspectRatio: 'adaptive',
  supportedSizes: ['1280x720', '720x1280'],
}), undefined);

assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile(
  managedVideoContract,
  'grok-image-video',
  'generate',
), {
  maxVideos: 1,
  maxDurationSeconds: 15,
  supportedDurationSeconds: [6, 10, 15],
  supportsSize: true,
  sizes: ['854x480', '1280x720', '720x1280', '1024x1024'],
});
assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile(
  managedVideoContract,
  'grok-video-1.5',
  'generate',
), {
  enabled: false,
});
assert.deepEqual(resolveOpenAiVideoCapabilityContractProfile(
  managedVideoContract,
  'grok-video-1.5',
  'imageToVideo',
), {
  enabled: true,
  maxInputImages: 1,
  maxVideos: 1,
  maxDurationSeconds: 15,
  supportedDurationSeconds: [6, 10, 15],
  supportsSize: true,
  sizes: ['854x480', '1280x720', '720x1280', '1024x1024'],
});
assert.equal(
  resolveOpenAiVideoCapabilityContractProfile(managedVideoContract, 'sora-2', 'generate'),
  undefined,
);

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
  const resolutionOrder = runtimeContent.match(/const VIDEO_RESOLUTION_ORDER = \[([\s\S]*?)\];/u)?.[1] ?? '';
  assert.doesNotMatch(resolutionOrder, /"480P"/u);
  assert.match(resolutionOrder, /"720P"/u);
  assert.match(runtimeContent, /caps\.modelCapabilities\?\.\[model\]/u);
  assert.match(runtimeContent, /derivedFrom: "resolution\+aspectRatio"/u);
  assert.match(runtimeContent, /resolution = void 0/u);
  assert.match(runtimeContent, /audio = void 0/u);
  assert.match(runtimeContent, /watermark = void 0/u);
  assert.match(providerContent, /UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V3/u);
  assert.match(providerContent, /uclawManagedVideoCapabilityContract/u);
  assert.match(providerContent, /resolveUClawManagedVideoModelCapability/u);
  assert.match(providerContent, /resolveModelCapabilities: resolveUClawManagedOpenAIVideoCapabilities/u);
  assert.match(providerContent, /resolveDurationSeconds\(req\.durationSeconds, model, req\.cfg\)/u);
  assert.match(providerContent, /managedModel\?\.requiresImage/u);
  assert.doesNotMatch(providerContent, /UCLAW_OPENAI_GROK_VIDEO_SECONDS/u);
  assert.doesNotMatch(providerContent, /UCLAW_OPENAI_GROK_VIDEO_SIZES/u);
  assert.doesNotMatch(providerContent, /UCLAW_OPENAI_GROK_VIDEO_MODEL/u);
  assert.match(providerContent, /const OPENAI_VIDEO_SECONDS = \[\s*4,\s*8,\s*12\s*\]/u);

  const upgradedProvider = patchOpenClawOpenAiVideoCapabilityContent(targets[2].content);
  assert.ok(upgradedProvider, 'expected the OpenAI provider fixture to be recognized');
  assert.match(upgradedProvider.content, /UCLAW_VIDEO_CAPABILITY_CONTRACT_OPENAI_V3/u);
  assert.doesNotMatch(upgradedProvider.content, /UCLAW_OPENAI_GROK_VIDEO_SECONDS/u);
  assert.doesNotMatch(upgradedProvider.content, /UCLAW_OPENAI_GROK_VIDEO_SIZES/u);
  assert.equal(patchOpenClawOpenAiVideoCapabilityContent(upgradedProvider.content).changed, false);

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
