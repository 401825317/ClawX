import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  patchOpenClawImageModelPolicyOpenAiContent,
  patchOpenClawImageModelPolicyRuntime,
  patchOpenClawImageModelPolicyToolContent,
  readOpenClawImageModelPolicyConfig,
  resolveManagedImageModelOverride,
} from './openclaw-image-model-policy-patch.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OPENCLAW_ROOT = join(ROOT, 'node_modules', 'openclaw');
const OPENCLAW_DIST = join(OPENCLAW_ROOT, 'dist');
const MANAGED_MODEL_REF = 'openai/gpt-image-2';
const CONFIGURED_PRIMARY = 'clawx-openai-image/gpt-image-2';

function prepareRuntimeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'uclaw-image-model-policy-'));
  const distDir = join(fixtureRoot, 'dist');
  mkdirSync(distDir);
  cpSync(join(OPENCLAW_ROOT, 'package.json'), join(fixtureRoot, 'package.json'));

  const categoryFiles = new Map();
  const config = readOpenClawImageModelPolicyConfig();
  for (const entry of readdirSync(OPENCLAW_DIST, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const sourcePath = join(OPENCLAW_DIST, entry.name);
    const content = readFileSync(sourcePath, 'utf8');
    const result = patchOpenClawImageModelPolicyToolContent(content, config, sourcePath)
      ?? patchOpenClawImageModelPolicyOpenAiContent(content, config, sourcePath);
    if (!result) continue;
    assert.equal(categoryFiles.has(result.category), false, `duplicate ${result.category} runtime fixture`);
    categoryFiles.set(result.category, entry.name);
    cpSync(sourcePath, join(distDir, entry.name));
  }
  return { fixtureRoot, distDir, categoryFiles };
}

function runOpenAiResolver(providerContent, managedDistribution, req, options) {
  const start = providerContent.indexOf('const UCLAW_IMAGE_MODEL_POLICY_OPENAI_VERSION = 1;');
  const end = providerContent.indexOf('function resolveNativeOpenAIImageSizesForModel', start);
  assert.ok(start >= 0 && end > start, 'patched OpenAI image resolver must be extractable');
  const context = {
    OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL: 'gpt-image-1.5',
    process: { env: { CLAWX_MANAGED_PROVIDER: managedDistribution ? '1' : '0' } },
    req,
    options,
  };
  vm.runInNewContext(
    `${providerContent.slice(start, end)}\n`
      + 'globalThis.__result = resolveOpenAIImageRequestModel(req, options);',
    context,
  );
  return context.__result;
}

test('reads the canonical image model from junfeiai-endpoints.json', () => {
  assert.deepEqual(readOpenClawImageModelPolicyConfig(), {
    modelRef: MANAGED_MODEL_REF,
    provider: 'openai',
    model: 'gpt-image-2',
  });
});

test('keeps model-supplied overrides inside the configured managed image profile', () => {
  const base = {
    configuredPrimary: CONFIGURED_PRIMARY,
    managedModelRef: MANAGED_MODEL_REF,
    managedDistribution: true,
  };
  assert.equal(
    resolveManagedImageModelOverride({ ...base, requestedModel: 'openai/gpt-image-1.5' }),
    CONFIGURED_PRIMARY,
  );
  assert.equal(
    resolveManagedImageModelOverride({ ...base, requestedModel: 'gpt-image-1' }),
    CONFIGURED_PRIMARY,
  );
  assert.equal(
    resolveManagedImageModelOverride({ ...base, requestedModel: MANAGED_MODEL_REF }),
    MANAGED_MODEL_REF,
  );
  assert.equal(
    resolveManagedImageModelOverride({ ...base, requestedModel: 'gpt-image-2' }),
    'gpt-image-2',
  );
  assert.equal(
    resolveManagedImageModelOverride({
      ...base,
      requestedModel: 'openai/gpt-image-1.5',
      managedDistribution: false,
    }),
    'openai/gpt-image-1.5',
  );
  assert.equal(
    resolveManagedImageModelOverride({
      ...base,
      configuredPrimary: 'third-party/gpt-image-2',
      requestedModel: 'openai/gpt-image-1.5',
    }),
    'openai/gpt-image-1.5',
  );
});

test('patches the real OpenClaw image tool and provider exactly once', () => {
  const { fixtureRoot, distDir, categoryFiles } = prepareRuntimeFixture();
  try {
    assert.deepEqual(new Set(categoryFiles.keys()), new Set(['tool', 'openai-provider']));

    const first = patchOpenClawImageModelPolicyRuntime(distDir, { logger: { log() {} } });
    assert.equal(first.matchedFiles, 2);
    assert.equal(first.patchedFiles + first.alreadyPatchedFiles, 2);

    const second = patchOpenClawImageModelPolicyRuntime(distDir, { logger: { log() {} } });
    assert.deepEqual(second, {
      matchedFiles: 2,
      patchedFiles: 0,
      alreadyPatchedFiles: 2,
    });

    const toolPath = join(distDir, categoryFiles.get('tool'));
    const providerPath = join(distDir, categoryFiles.get('openai-provider'));
    const toolContent = readFileSync(toolPath, 'utf8');
    const providerContent = readFileSync(providerPath, 'utf8');

    assert.match(toolContent, /resolveUclawManagedImageModelOverride/);
    assert.match(toolContent, /Managed default: openai\/gpt-image-2/);
    assert.match(toolContent, /managed OpenAI default is openai\/gpt-image-2/);
    assert.doesNotMatch(toolContent, /gpt-image-1\.5/);
    assert.match(providerContent, /UCLAW_IMAGE_MODEL_POLICY_OPENAI_VERSION = 1/);
    assert.equal(
      runOpenAiResolver(providerContent, true, { model: 'gpt-image-1.5' }),
      'gpt-image-2',
    );
    assert.equal(
      runOpenAiResolver(
        providerContent,
        true,
        { model: 'gpt-image-2', background: 'transparent' },
        { allowTransparentDefaultReroute: true },
      ),
      'gpt-image-2',
    );
    assert.equal(
      runOpenAiResolver(
        providerContent,
        false,
        { model: 'gpt-image-2', background: 'transparent' },
        { allowTransparentDefaultReroute: true },
      ),
      'gpt-image-1.5',
    );

    const nextConfig = { modelRef: 'openai/gpt-image-3', provider: 'openai', model: 'gpt-image-3' };
    const updatedTool = patchOpenClawImageModelPolicyToolContent(toolContent, nextConfig, toolPath);
    const updatedProvider = patchOpenClawImageModelPolicyOpenAiContent(providerContent, nextConfig, providerPath);
    assert.equal(updatedTool.changed, true);
    assert.equal(updatedProvider.changed, true);
    assert.match(updatedTool.content, /Managed default: openai\/gpt-image-3/);
    assert.match(updatedProvider.content, /DEFAULT_MODEL = "gpt-image-3"/);

    execFileSync(process.execPath, ['--check', toolPath], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', providerPath], { stdio: 'pipe' });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
