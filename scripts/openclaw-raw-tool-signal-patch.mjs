import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCH_MARKER = 'UCLAW_RAW_TOOL_SIGNAL_DIAGNOSTIC';

const PROCESS_STREAM_OPTIONS_ANCHOR = `await processOpenAICompletionsStream(responseStream, output, model, stream, {
\t\t\t\t\tsignal: options?.signal,
\t\t\t\t\temitReasoning
\t\t\t\t});`;

const PROCESS_STREAM_OPTIONS_PATCH = `await processOpenAICompletionsStream(responseStream, output, model, stream, {
\t\t\t\t\tsignal: options?.signal,
\t\t\t\t\temitReasoning,
\t\t\t\t\tsessionId: options?.sessionId
\t\t\t\t});`;

const STATE_ANCHOR = `\tlet sawStopFinishReason = false;
\tconst blockIndex = () => output.content.length - 1;`;

const STATE_PATCH = `\tlet sawStopFinishReason = false;
\tconst UCLAW_RAW_TOOL_SIGNAL_DIAGNOSTIC = true;
\tlet rawToolCallDeltaSeen = false;
\tlet rawToolCallDeltaCount = 0;
\tconst rawToolCallNames = /* @__PURE__ */ new Set();
\tconst rawFinishReasons = /* @__PURE__ */ new Set();
\tconst blockIndex = () => output.content.length - 1;`;

const FINISH_REASON_ANCHOR = `\t\tif (choice.finish_reason) {
\t\t\tconst finishReasonResult = mapOpenAIStopReason(choice.finish_reason, { allowSingularToolCall: true });`;

const FINISH_REASON_PATCH = `\t\tif (choice.finish_reason) {
\t\t\trawFinishReasons.add(String(choice.finish_reason));
\t\t\tconst finishReasonResult = mapOpenAIStopReason(choice.finish_reason, { allowSingularToolCall: true });`;

const TOOL_CALL_IF_ANCHOR = `\t\tif (choiceDelta.tool_calls && choiceDelta.tool_calls.length > 0) {
\t\t\tflushReasoningTagTextPartitionerAtEnd();
\t\t\tfor (const toolCall of choiceDelta.tool_calls) {`;

const TOOL_CALL_IF_PATCH = `\t\tconst rawChoiceToolCalls = Array.isArray(choiceDelta.tool_calls) ? choiceDelta.tool_calls : [];
\t\tif (rawChoiceToolCalls.length > 0) {
\t\t\trawToolCallDeltaSeen = true;
\t\t\trawToolCallDeltaCount += rawChoiceToolCalls.length;
\t\t\tfor (const rawToolCall of rawChoiceToolCalls) {
\t\t\t\tconst rawToolName = rawToolCall?.function?.name;
\t\t\t\tif (typeof rawToolName === "string" && rawToolName) rawToolCallNames.add(rawToolName);
\t\t\t}
\t\t\tflushReasoningTagTextPartitionerAtEnd();
\t\t\tfor (const toolCall of rawChoiceToolCalls) {`;

const FINAL_FILTER_ANCHOR = `\tif (hasToolCalls && output.stopReason !== "toolUse") output.content = output.content.filter((block) => block.type !== "toolCall");
}`;

const FINAL_FILTER_PATCH = `\tif (hasToolCalls && output.stopReason !== "toolUse") output.content = output.content.filter((block) => block.type !== "toolCall");
\tconst parsedToolCallBlocks = output.content.filter((block) => block.type === "toolCall");
\tconst parsedToolCallNames = parsedToolCallBlocks.map((block) => block.name).filter((name) => typeof name === "string" && name.length > 0);
\tlog.info(\`[completions] raw_tool_signal provider=\${model.provider} api=\${model.api} model=\${model.id} sessionId=\${safeDebugValue(options?.sessionId)} responseId=\${safeDebugValue(output.responseId)} rawToolCallDeltaSeen=\${rawToolCallDeltaSeen} rawToolCallDeltaCount=\${rawToolCallDeltaCount} rawToolCallNames=\${rawToolCallNames.size > 0 ? [...rawToolCallNames].join(",") : "none"} parsedToolCallCount=\${parsedToolCallBlocks.length} parsedToolCallNames=\${parsedToolCallNames.length > 0 ? parsedToolCallNames.join(",") : "none"} stopReason=\${safeDebugValue(output.stopReason)} finishReasons=\${rawFinishReasons.size > 0 ? [...rawFinishReasons].join(",") : "none"}\`);
}`;

function patchRawToolSignalContent(content) {
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false };
  }

  const anchors = [
    PROCESS_STREAM_OPTIONS_ANCHOR,
    STATE_ANCHOR,
    FINISH_REASON_ANCHOR,
    TOOL_CALL_IF_ANCHOR,
    FINAL_FILTER_ANCHOR,
  ];
  if (!anchors.every((anchor) => content.includes(anchor))) {
    return { content, changed: false };
  }

  return {
    content: content
      .replace(PROCESS_STREAM_OPTIONS_ANCHOR, PROCESS_STREAM_OPTIONS_PATCH)
      .replace(STATE_ANCHOR, STATE_PATCH)
      .replace(FINISH_REASON_ANCHOR, FINISH_REASON_PATCH)
      .replace(TOOL_CALL_IF_ANCHOR, TOOL_CALL_IF_PATCH)
      .replace(FINAL_FILTER_ANCHOR, FINAL_FILTER_PATCH),
    changed: true,
  };
}

export function patchOpenClawRawToolSignalRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };

  let patchedFiles = 0;
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patchRawToolSignalContent(original);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content, 'utf8');
    patchedFiles++;
    logger.log?.(`[openclaw-raw-tool-signal-patch] Patched: ${file}`);
  }

  if (patchedFiles > 0) {
    logger.log?.(`[openclaw-raw-tool-signal-patch] Done. Patched ${patchedFiles} file(s).`);
  }

  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawRawToolSignalRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawRawToolSignalRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
