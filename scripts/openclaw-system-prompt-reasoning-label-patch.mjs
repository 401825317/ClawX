import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_MARKER = 'UCLAW_REASONING_VISIBILITY_LABEL_V2';
const LEGACY_PATCH_MARKER = 'UCLAW_REASONING_VISIBILITY_LABEL_V1';
const PROMPT_ANCHOR = '`Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`';
const LEGACY_PROMPT_ANCHOR = [
  '`Thinking effort: ${defaultThinkLevel ?? "off"} (controls whether and how deeply the model thinks; change it with /think).`,',
  `\t\t\t\`Reasoning visibility: \${reasoningLevel} (only controls whether internal thinking is shown; "off" does not disable model thinking). Toggle /reasoning; /status shows reasoning visibility when enabled.\`, // ${LEGACY_PATCH_MARKER}`,
  '\t\t\t`When asked whether model thinking is enabled, answer from Thinking effort only, never from Reasoning visibility.`',
].join('\n');
const PROMPT_PATCH = [
  '`Thinking effort: ${params.defaultThinkLevel ?? "off"} (controls whether and how deeply the model thinks; change it with /think).`,',
  `\t\t\t\`Reasoning visibility: \${reasoningLevel} (only controls whether internal thinking is shown; "off" does not disable model thinking). Toggle /reasoning; /status shows reasoning visibility when enabled.\`, // ${PATCH_MARKER}`,
  '\t\t\t`When asked whether model thinking is enabled, answer from Thinking effort only, never from Reasoning visibility.`',
].join('\n');

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

export function patchOpenClawSystemPromptReasoningLabelContent(content, filePath = '<fixture>') {
  if (!content.includes('function buildRuntimeLine(') || !content.includes('const reasoningLevel = params.reasoningLevel')) {
    return { content, changed: false, matched: false };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true };
  }
  if (content.includes(LEGACY_PATCH_MARKER)) {
    const legacyCount = countOccurrences(content, LEGACY_PROMPT_ANCHOR);
    if (legacyCount !== 1) {
      throw new Error(
        `[openclaw-system-prompt-reasoning-label-patch] Expected one legacy reasoning prompt anchor in ${filePath}; found ${legacyCount}.`,
      );
    }
    return {
      content: content.replace(LEGACY_PROMPT_ANCHOR, PROMPT_PATCH),
      changed: true,
      matched: true,
    };
  }
  const count = countOccurrences(content, PROMPT_ANCHOR);
  if (count !== 1) {
    throw new Error(
      `[openclaw-system-prompt-reasoning-label-patch] Expected one reasoning prompt anchor in ${filePath}; found ${count}.`,
    );
  }
  return {
    content: content.replace(PROMPT_ANCHOR, PROMPT_PATCH),
    changed: true,
    matched: true,
  };
}

export function patchOpenClawSystemPromptReasoningLabelRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[openclaw-system-prompt-reasoning-label-patch] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ file, filePath: join(distDir, file) }))
    .map((target) => ({
      ...target,
      result: patchOpenClawSystemPromptReasoningLabelContent(readFileSync(target.filePath, 'utf8'), target.filePath),
    }))
    .filter(({ result }) => result.matched);

  if (targets.length !== 1) {
    throw new Error(
      `[openclaw-system-prompt-reasoning-label-patch] Expected one system prompt runtime; found ${targets.length}.`,
    );
  }

  const target = targets[0];
  if (target.result.changed && !dryRun) {
    writeFileSync(target.filePath, target.result.content, 'utf8');
  }
  logger.log?.(
    `[openclaw-system-prompt-reasoning-label-patch] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`,
  );
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    targetFile: target.filePath,
  };
}

export function patchInstalledOpenClawSystemPromptReasoningLabelRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawSystemPromptReasoningLabelRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
