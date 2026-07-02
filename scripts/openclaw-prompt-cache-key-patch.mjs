import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const WEBCHAT_CACHE_KEY_ANCHOR = `function resolveWebchatPromptCacheKey(params) {
\treturn \`openclaw-webchat-\${createHash("sha256").update([
\t\t"v1",
\t\tparams.provider.trim().toLowerCase(),
\t\tparams.model.trim(),
\t\tnormalizeAgentId(params.agentId),
\t\tparams.sessionKey
\t].join("\\0"), "utf8").digest("hex").slice(0, 32)}\`;
}
`;

const WEBCHAT_CACHE_KEY_PATCH = `function resolveWebchatPromptCacheKey(params) {
\treturn \`openclaw-webchat-\${createHash("sha256").update([
\t\t"uclaw-v2",
\t\tparams.provider.trim().toLowerCase(),
\t\tparams.model.trim(),
\t\tnormalizeAgentId(params.agentId)
\t].join("\\0"), "utf8").digest("hex").slice(0, 32)}\`;
}
`;

function patchPromptCacheKeyContent(content) {
  if (content.includes('"uclaw-v2"')) {
    return { content, changed: false };
  }

  if (!content.includes(WEBCHAT_CACHE_KEY_ANCHOR)) {
    return { content, changed: false };
  }

  return {
    content: content.replace(WEBCHAT_CACHE_KEY_ANCHOR, WEBCHAT_CACHE_KEY_PATCH),
    changed: true,
  };
}

export function patchOpenClawPromptCacheKeyRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchPromptCacheKeyContent(original);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-prompt-cache-key-patch] Patched: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-prompt-cache-key-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawPromptCacheKeyRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawPromptCacheKeyRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}

