import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { patchOpenClawPromptCacheKeyRuntime } from '../../scripts/openclaw-prompt-cache-key-patch.mjs';

describe('OpenClaw prompt cache key runtime patch', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('makes webchat prompt cache keys stable across sessions for the same agent and model', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-prompt-cache-key-patch-'));
    const distDir = join(tempRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    const runtimeFile = join(distDir, 'chat-test.js');

    writeFileSync(
      runtimeFile,
      `function resolveWebchatPromptCacheKey(params) {
\treturn \`openclaw-webchat-\${createHash("sha256").update([
\t\t"v1",
\t\tparams.provider.trim().toLowerCase(),
\t\tparams.model.trim(),
\t\tnormalizeAgentId(params.agentId),
\t\tparams.sessionKey
\t].join("\\0"), "utf8").digest("hex").slice(0, 32)}\`;
}
`,
      'utf8',
    );

    const result = patchOpenClawPromptCacheKeyRuntime(distDir, { logger: { log: () => undefined } });
    const patched = readFileSync(runtimeFile, 'utf8');

    expect(result.patchedFiles).toBe(1);
    expect(patched).toContain('"uclaw-v2"');
    expect(patched).toContain('normalizeAgentId(params.agentId)');
    expect(patched).not.toContain('params.sessionKey');
  });
});

