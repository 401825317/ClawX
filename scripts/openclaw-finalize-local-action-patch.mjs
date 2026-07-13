import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOCAL_ACTION_REVISION_REASON_MARKER = 'UClaw 本地动作最终回复仍像未执行的计划。';
const LEGACY_LOCAL_ACTION_REVISION_REASON_MARKER = 'UClaw local action final reply looked like an unexecuted plan.';
const ARTIFACT_REVISION_REASON_MARKER = 'UClaw artifact delivery final reply had no completed artifact evidence.';
const PRESENTATION_FORCE_TOOL_CHOICE_MARKER = 'UClaw force artifact tool choice: create_designed_pptx_file.';
const DESIGNED_PRESENTATION_EXECUTION_CONTRACT_MARKER = 'UClaw designed presentation execution contract v1.';

const SIDEEFFECT_FINALIZE_ANCHOR = `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tif (event.hadDeterministicSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;

const LEGACY_SIDEEFFECT_FINALIZE_PATCH = `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tconst allowUclawLocalActionRevisionAfterSideEffect = event.hadDeterministicSideEffect && typeof outcome.reason === "string" && outcome.reason.includes("${LOCAL_ACTION_REVISION_REASON_MARKER}");
\t\t\t\tif (event.hadDeterministicSideEffect && !allowUclawLocalActionRevisionAfterSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;

function sideEffectFinalizePatch(localActionCondition = '') {
  return `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tconst allowUclawArtifactRevisionAfterSideEffect = event.hadDeterministicSideEffect && typeof outcome.reason === "string" && (outcome.reason.includes("${ARTIFACT_REVISION_REASON_MARKER}")${localActionCondition});
\t\t\t\tif (event.hadDeterministicSideEffect && !allowUclawArtifactRevisionAfterSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;
}

export function patchFinalizeLocalActionContent(content) {
  const normalizedContent = content.replaceAll(
    LEGACY_LOCAL_ACTION_REVISION_REASON_MARKER,
    LOCAL_ACTION_REVISION_REASON_MARKER,
  );
  if (normalizedContent.includes(SIDEEFFECT_FINALIZE_ANCHOR)) {
    return { content: normalizedContent, changed: normalizedContent !== content };
  }

  const candidates = [
    LEGACY_SIDEEFFECT_FINALIZE_PATCH,
    sideEffectFinalizePatch(),
    sideEffectFinalizePatch(` || outcome.reason.includes("${LOCAL_ACTION_REVISION_REASON_MARKER}")`),
  ];
  for (const candidate of candidates) {
    if (!normalizedContent.includes(candidate)) continue;
    return {
      content: normalizedContent.replace(candidate, SIDEEFFECT_FINALIZE_ANCHOR),
      changed: true,
    };
  }

  return { content: normalizedContent, changed: normalizedContent !== content };
}

export function patchArtifactRevisionToolChoiceContent(content) {
  let patched = content;

  const declarationAnchor = `\t\t\tlet nextAttemptPromptOverride = null;
\t\t\tlet rateLimitProfileRotations = 0;`;
  const declarationPatch = `\t\t\tlet nextAttemptPromptOverride = null;
\t\t\tlet nextAttemptToolChoiceOverride = null;
\t\t\tlet rateLimitProfileRotations = 0;`;
  if (patched.includes(declarationPatch)) {
    patched = patched.replace(declarationPatch, declarationAnchor);
  }

  const attemptParamsAnchor = `\t\t\t\t\tconst prompt = promptAdditions.length > 0 ? \`\${basePrompt}\\n\\n\${promptAdditions.join("\\n\\n")}\` : basePrompt;
\t\t\t\t\tconst resolvedStreamApiKey = resolveAttemptDispatchApiKey({`;
  const attemptParamsPatch = `\t\t\t\t\tconst prompt = promptAdditions.length > 0 ? \`\${basePrompt}\\n\\n\${promptAdditions.join("\\n\\n")}\` : basePrompt;
\t\t\t\t\tconst presentationExecutionContractActive = typeof params.prompt === "string" && params.prompt.includes("${DESIGNED_PRESENTATION_EXECUTION_CONTRACT_MARKER}");
\t\t\t\t\tconst presentationToolChoice = {
\t\t\t\t\t\ttype: "function",
\t\t\t\t\t\tfunction: { name: "tool_call" }
\t\t\t\t\t};
\t\t\t\t\tconst attemptStreamParams = nextAttemptToolChoiceOverride ? {
\t\t\t\t\t\t...params.streamParams,
\t\t\t\t\t\ttoolChoice: nextAttemptToolChoiceOverride
\t\t\t\t\t} : presentationExecutionContractActive ? {
\t\t\t\t\t\t...params.streamParams,
\t\t\t\t\t\ttoolChoice: presentationToolChoice
\t\t\t\t\t} : params.streamParams;
\t\t\t\t\tnextAttemptToolChoiceOverride = null;
\t\t\t\t\tconst resolvedStreamApiKey = resolveAttemptDispatchApiKey({`;
  const oneShotAttemptParamsPatch = `\t\t\t\t\tconst prompt = promptAdditions.length > 0 ? \`\${basePrompt}\\n\\n\${promptAdditions.join("\\n\\n")}\` : basePrompt;
\t\t\t\t\tconst attemptStreamParams = nextAttemptToolChoiceOverride ? {
\t\t\t\t\t\t...params.streamParams,
\t\t\t\t\t\ttoolChoice: nextAttemptToolChoiceOverride
\t\t\t\t\t} : params.streamParams;
\t\t\t\t\tnextAttemptToolChoiceOverride = null;
\t\t\t\t\tconst resolvedStreamApiKey = resolveAttemptDispatchApiKey({`;
  if (patched.includes(attemptParamsPatch)) {
    patched = patched.replace(attemptParamsPatch, attemptParamsAnchor);
  } else if (patched.includes(oneShotAttemptParamsPatch)) {
    patched = patched.replace(oneShotAttemptParamsPatch, attemptParamsAnchor);
  }

  const runtimePlanAnchor = `\t\t\t\t\t\textraParamsOverride: {
\t\t\t\t\t\t\t...params.streamParams,
\t\t\t\t\t\t\tfastMode: attemptFastMode
\t\t\t\t\t\t}`;
  const runtimePlanPatch = `\t\t\t\t\t\textraParamsOverride: {
\t\t\t\t\t\t\t...attemptStreamParams,
\t\t\t\t\t\t\tfastMode: attemptFastMode
\t\t\t\t\t\t}`;
  if (patched.includes(runtimePlanPatch)) {
    patched = patched.replace(runtimePlanPatch, runtimePlanAnchor);
  }

  const streamParamsAnchor = `\t\t\t\t\t\tstreamParams: params.streamParams,`;
  const streamParamsPatch = `\t\t\t\t\t\tstreamParams: attemptStreamParams,`;
  if (patched.includes(streamParamsPatch)) {
    patched = patched.replace(streamParamsPatch, streamParamsAnchor);
  }

  const retryAnchor = `\t\t\t\t\t\tnextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason);
\t\t\t\t\t\tsuppressNextUserMessagePersistence = true;`;
  const retryPatch = `\t\t\t\t\t\tnextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason);
\t\t\t\t\t\tnextAttemptToolChoiceOverride = beforeAgentFinalizeRevisionReason.includes("${PRESENTATION_FORCE_TOOL_CHOICE_MARKER}") ? {
\t\t\t\t\t\t\ttype: "function",
\t\t\t\t\t\t\tfunction: { name: "tool_call" }
\t\t\t\t\t\t} : null;
\t\t\t\t\t\tsuppressNextUserMessagePersistence = true;`;
  const legacyRetryPatch = retryPatch.replace(
    'function: { name: "tool_call" }',
    'function: { name: "create_designed_pptx_file" }',
  );
  if (patched.includes(legacyRetryPatch)) {
    patched = patched.replace(legacyRetryPatch, retryAnchor);
  } else if (patched.includes(retryPatch)) {
    patched = patched.replace(retryPatch, retryAnchor);
  }

  const providerStreamAnchor = `\t\t\t\tnativeWebSearchPolicyContext
\t\t\t});
\t\t\tif (codeModeControlsEnabledForRun)`;
  const legacyProviderStreamPatch = `\t\t\t\tnativeWebSearchPolicyContext
\t\t\t});
\t\t\tif (params.streamParams?.toolChoice) {
\t\t\t\tconst forcedToolChoice = params.streamParams.toolChoice;
\t\t\t\tconst streamFnBeforeToolChoiceOverride = activeSession.agent.streamFn;
\t\t\t\tactiveSession.agent.streamFn = (model, context, options) => streamFnBeforeToolChoiceOverride(model, context, {
\t\t\t\t\t...options,
\t\t\t\t\ttoolChoice: forcedToolChoice
\t\t\t\t});
\t\t\t}
\t\t\tif (codeModeControlsEnabledForRun)`;
  const providerStreamPatch = `\t\t\t\tnativeWebSearchPolicyContext
\t\t\t});
\t\t\tif (params.streamParams?.toolChoice) {
\t\t\t\tconst forcedToolChoice = params.streamParams.toolChoice;
\t\t\t\tconst streamFnBeforeToolChoiceOverride = activeSession.agent.streamFn;
\t\t\t\tconst persistentPresentationToolChoice = typeof params.prompt === "string" && (params.prompt.includes("${DESIGNED_PRESENTATION_EXECUTION_CONTRACT_MARKER}") || params.prompt.includes("${PRESENTATION_FORCE_TOOL_CHOICE_MARKER}"));
\t\t\t\tconst hasSuccessfulPresentationArtifact = (context) => {
\t\t\t\t\tconst messages = Array.isArray(context?.messages) ? context.messages : Array.isArray(context) ? context : [];
\t\t\t\t\tlet latestUserIndex = -1;
\t\t\t\t\tfor (let index = messages.length - 1; index >= 0; index -= 1) {
\t\t\t\t\t\tconst role = String(messages[index]?.role ?? "").toLowerCase();
\t\t\t\t\t\tif (role === "user") {
\t\t\t\t\t\t\tlatestUserIndex = index;
\t\t\t\t\t\t\tbreak;
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\treturn messages.slice(latestUserIndex + 1).some((message) => {
\t\t\t\t\t\tconst serialized = JSON.stringify(message).replaceAll("\\\\", "");
\t\t\t\t\t\tconst hasDesignedTool = serialized.includes("openclaw:uclaw-local-artifacts:create_designed_pptx_file") || serialized.includes("openclaw:uclaw-local-artifacts:repair_designed_pptx_file");
\t\t\t\t\t\treturn hasDesignedTool && serialized.includes('"ok":true') && serialized.includes('"status":"passed"') && serialized.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation");
\t\t\t\t\t});
\t\t\t\t};
\t\t\t\tlet forceToolChoiceOnNextCall = true;
\t\t\t\tactiveSession.agent.streamFn = (model, context, options) => {
\t\t\t\t\tconst useForcedToolChoice = persistentPresentationToolChoice
\t\t\t\t\t\t? !hasSuccessfulPresentationArtifact(context)
\t\t\t\t\t\t: forceToolChoiceOnNextCall;
\t\t\t\t\tforceToolChoiceOnNextCall = false;
\t\t\t\t\treturn streamFnBeforeToolChoiceOverride(model, context, useForcedToolChoice ? {
\t\t\t\t\t\t...options,
\t\t\t\t\t\ttoolChoice: forcedToolChoice
\t\t\t\t\t} : options);
\t\t\t\t};
\t\t\t}
\t\t\tif (codeModeControlsEnabledForRun)`;
  const oneShotProviderStreamPatch = `\t\t\t\tnativeWebSearchPolicyContext
\t\t\t});
\t\t\tif (params.streamParams?.toolChoice) {
\t\t\t\tconst forcedToolChoice = params.streamParams.toolChoice;
\t\t\t\tconst streamFnBeforeToolChoiceOverride = activeSession.agent.streamFn;
\t\t\t\tlet forceToolChoiceOnNextCall = true;
\t\t\t\tactiveSession.agent.streamFn = (model, context, options) => {
\t\t\t\t\tconst useForcedToolChoice = forceToolChoiceOnNextCall;
\t\t\t\t\tforceToolChoiceOnNextCall = false;
\t\t\t\t\treturn streamFnBeforeToolChoiceOverride(model, context, useForcedToolChoice ? {
\t\t\t\t\t\t...options,
\t\t\t\t\t\ttoolChoice: forcedToolChoice
\t\t\t\t\t} : options);
\t\t\t\t};
\t\t\t}
\t\t\tif (codeModeControlsEnabledForRun)`;
  const crossMessageSuccessBlock = `\t\t\t\t\tconst recent = JSON.stringify(messages.slice(latestUserIndex + 1)).replaceAll("\\\\", "");
\t\t\t\t\tconst hasDesignedTool = recent.includes("openclaw:uclaw-local-artifacts:create_designed_pptx_file") || recent.includes("openclaw:uclaw-local-artifacts:repair_designed_pptx_file");
\t\t\t\t\treturn hasDesignedTool && recent.includes('"ok":true') && recent.includes('"status":"passed"') && recent.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation");`;
  const perMessageSuccessBlock = `\t\t\t\t\treturn messages.slice(latestUserIndex + 1).some((message) => {
\t\t\t\t\t\tconst serialized = JSON.stringify(message).replaceAll("\\\\", "");
\t\t\t\t\t\tconst hasDesignedTool = serialized.includes("openclaw:uclaw-local-artifacts:create_designed_pptx_file") || serialized.includes("openclaw:uclaw-local-artifacts:repair_designed_pptx_file");
\t\t\t\t\t\treturn hasDesignedTool && serialized.includes('"ok":true') && serialized.includes('"status":"passed"') && serialized.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation");
\t\t\t\t\t});`;
  const crossMessageProviderStreamPatch = providerStreamPatch.replace(perMessageSuccessBlock, crossMessageSuccessBlock);
  if (patched.includes(crossMessageProviderStreamPatch)) {
    patched = patched.replace(crossMessageProviderStreamPatch, providerStreamAnchor);
  } else if (patched.includes(providerStreamPatch)) {
    patched = patched.replace(providerStreamPatch, providerStreamAnchor);
  } else if (patched.includes(legacyProviderStreamPatch)) {
    patched = patched.replace(legacyProviderStreamPatch, providerStreamAnchor);
  } else if (patched.includes(oneShotProviderStreamPatch)) {
    patched = patched.replace(oneShotProviderStreamPatch, providerStreamAnchor);
  }

  return { content: patched, changed: patched !== content };
}

export function patchOpenClawFinalizeLocalActionRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const finalizePatched = patchFinalizeLocalActionContent(original, options);
    const artifactToolChoicePatched = patchArtifactRevisionToolChoiceContent(finalizePatched.content);
    const patched = {
      content: artifactToolChoicePatched.content,
      changed: finalizePatched.changed || artifactToolChoicePatched.changed,
    };
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-finalize-local-action-patch] Cleaned: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-finalize-local-action-patch] Done. Cleaned ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawFinalizeLocalActionRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawFinalizeLocalActionRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
