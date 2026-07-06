import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOCAL_ACTION_REVISION_REASON_MARKER = 'UClaw 本地动作最终回复仍像未执行的计划。';
const LEGACY_LOCAL_ACTION_REVISION_REASON_MARKER = 'UClaw local action final reply looked like an unexecuted plan.';

const SIDEEFFECT_FINALIZE_ANCHOR = `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tif (event.hadDeterministicSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;

const SIDEEFFECT_FINALIZE_PATCH = `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tconst allowUclawLocalActionRevisionAfterSideEffect = event.hadDeterministicSideEffect && typeof outcome.reason === "string" && outcome.reason.includes("${LOCAL_ACTION_REVISION_REASON_MARKER}");
\t\t\t\tif (event.hadDeterministicSideEffect && !allowUclawLocalActionRevisionAfterSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;

function patchFinalizeLocalActionContent(content) {
  const normalizedContent = content.replaceAll(
    LEGACY_LOCAL_ACTION_REVISION_REASON_MARKER,
    LOCAL_ACTION_REVISION_REASON_MARKER,
  );

  if (content.includes('allowUclawLocalActionRevisionAfterSideEffect')) {
    return { content: normalizedContent, changed: normalizedContent !== content };
  }

  if (!normalizedContent.includes(SIDEEFFECT_FINALIZE_ANCHOR)) {
    return { content: normalizedContent, changed: normalizedContent !== content };
  }

  return {
    content: normalizedContent.replace(SIDEEFFECT_FINALIZE_ANCHOR, SIDEEFFECT_FINALIZE_PATCH),
    changed: true,
  };
}

export function patchOpenClawFinalizeLocalActionRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchFinalizeLocalActionContent(original);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-finalize-local-action-patch] Patched: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-finalize-local-action-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawFinalizeLocalActionRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawFinalizeLocalActionRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
