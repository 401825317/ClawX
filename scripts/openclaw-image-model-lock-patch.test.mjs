import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  patchOpenClawImageModelLockRuntime,
} from './openclaw-image-model-lock-patch.mjs';

const OPENAI_IMAGE_1_5_SUFFIX = '.5';

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-image-model-lock-'));
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  try {
    return fn(dist);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const providerFixture = `const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
const OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL = "gpt-image-${'1'}${OPENAI_IMAGE_1_5_SUFFIX}";
const OPENAI_SUPPORTED_SIZES = ["1024x1024"];
const OPENAI_LEGACY_IMAGE_SIZES = ["1024x1024"];
const OPENAI_IMAGE_MODELS = [
\tOPENAI_DEFAULT_IMAGE_MODEL,
\tOPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL,
\t"gpt-image-${'1'}",
\t"gpt-image-${'1'}-mini"
];
function resolveOpenAIImageRequestModel(req, options) {
\tconst model = req.model || "gpt-image-2";
\tif (options?.allowTransparentDefaultReroute === true && model === "gpt-image-2" && (req.providerOptions?.openai?.background ?? req.background) === "transparent") return OPENAI_TRANSPARENT_BACKGROUND_IMAGE_MODEL;
\treturn model;
}
function resolveNativeOpenAIImageSizesForModel(model) {
\tswitch (model) {
\t\tcase "gpt-image-${'1'}":
\t\tcase "gpt-image-${'1'}-mini": return OPENAI_LEGACY_IMAGE_SIZES;
\t\tdefault: return OPENAI_SUPPORTED_SIZES;
\t}
}`;

const toolFixture = `const ImageGenerateToolSchema = Type.Object({
\tmodel: Type.Optional(Type.String({ description: "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-${'1'}${OPENAI_IMAGE_1_5_SUFFIX}." })),
\topenai: Type.Optional(Type.Object({
\t\tbackground: optionalStringEnum(SUPPORTED_BACKGROUNDS, { description: "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-${'1'}${OPENAI_IMAGE_1_5_SUFFIX}." }),
\t})),
});
const tool = {
\tdescription: "Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. Transparent: outputFormat=\\"png\\" or \\"webp\\" + background=\\"transparent\\"; OpenAI also supports openai.background and routes default model to gpt-image-${'1'}${OPENAI_IMAGE_1_5_SUFFIX}. Use action=\\"list\\" for providers/models/readiness/auth, \\"status\\" for active task.",
};`;

test('patches OpenClaw image provider and tool to lock gpt-image-2', () => withFixture((dist) => {
  writeFileSync(join(dist, 'image-generation-provider-test.js'), providerFixture, 'utf8');
  writeFileSync(join(dist, 'openclaw-tools-test.js'), toolFixture, 'utf8');

  const first = patchOpenClawImageModelLockRuntime(dist, { logger: { log() {} } });
  assert.deepEqual(first, { matchedFiles: 2, patchedFiles: 2, alreadyPatchedFiles: 0 });

  const patched = [
    readFileSync(join(dist, 'image-generation-provider-test.js'), 'utf8'),
    readFileSync(join(dist, 'openclaw-tools-test.js'), 'utf8'),
  ].join('\n');
  assert.match(patched, /UCLAW_IMAGE_MODEL_LOCK_PROVIDER_V1/);
  assert.match(patched, /UCLAW_IMAGE_MODEL_LOCK_TOOL_V1/);
  assert.match(patched, /return OPENAI_DEFAULT_IMAGE_MODEL;/);
  assert.match(patched, /OPENAI_IMAGE_MODELS = \[\n\tOPENAI_DEFAULT_IMAGE_MODEL\n\]/);
  assert.match(patched, /UClaw locks OpenAI image generation to gpt-image-2/);
  assert.doesNotMatch(
    patched,
    new RegExp(`gpt-image-${'1'}(?:\\.${'5'}|-mini)?`),
  );

  const second = patchOpenClawImageModelLockRuntime(dist, { logger: { log() {} } });
  assert.deepEqual(second, { matchedFiles: 2, patchedFiles: 0, alreadyPatchedFiles: 2 });
}));
