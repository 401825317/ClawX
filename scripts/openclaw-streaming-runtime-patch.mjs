import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const TRANSPORT_MARKER = 'UCLAW_COMPLETIONS_BURST_SMOOTHING_V1';
const SCHEDULER_ANCHOR = `	const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
	for await (const rawChunk of responseStream) {`;
const SCHEDULER_PATCH = `	const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
	const UCLAW_COMPLETIONS_BURST_SMOOTHING_V1 = true;
	const appendSmoothedVisibleText = async (text, hasMirroredReasoning) => {
		const characters = Array.from(text);
		const chunkSize = characters.length > 48 ? Math.max(12, Math.ceil(characters.length / 24)) : characters.length;
		for (let offset = 0; offset < characters.length; offset += Math.max(1, chunkSize)) {
			const piece = characters.slice(offset, offset + Math.max(1, chunkSize)).join("");
			const routedDeltas = hasMirroredReasoning ? reasoningTagTextPartitioner.push(piece) : reasoningTagTextPartitioner.pushVisible(piece);
			for (const routedDelta of routedDeltas) appendPartitionedVisibleDelta(routedDelta);
			if (characters.length > 48 && offset + chunkSize < characters.length) {
				await new Promise((resolve) => setTimeout(resolve, 12));
			}
		}
	};
	for await (const rawChunk of responseStream) {`;

const CONTENT_ANCHOR = `		if (choiceDelta.content) {
			const contentDeltas = getCompletionsContentDeltas(choiceDelta.content);
			for (const contentDelta of contentDeltas) if (contentDelta.kind === "text") {
				const routedDeltas = hasMirroredReasoning ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
				for (const routedDelta of routedDeltas) appendPartitionedVisibleDelta(routedDelta);
			} else {`;
const CONTENT_PATCH = `		if (choiceDelta.content) {
			const contentDeltas = getCompletionsContentDeltas(choiceDelta.content);
			for (const contentDelta of contentDeltas) if (contentDelta.kind === "text") {
				await appendSmoothedVisibleText(contentDelta.text, hasMirroredReasoning);
			} else {`;

const CHAT_MARKER = 'UCLAW_CHAT_DELTA_THROTTLE_MS_V1';
const CHAT_STATE_ANCHOR = `	const emitChatDelta = (sessionKey, agentId, clientRunId, sourceRunId, seq, text, delta, opts) => {`;
const CHAT_STATE_PATCH = `	const UCLAW_CHAT_DELTA_THROTTLE_MS_V1 = 24;
	const emitChatDelta = (sessionKey, agentId, clientRunId, sourceRunId, seq, text, delta, opts) => {`;

function patchTransport(content, filePath) {
  if (content.includes(TRANSPORT_MARKER)) return { content, changed: false };
  if (!content.includes(SCHEDULER_ANCHOR) || !content.includes(CONTENT_ANCHOR)) {
    throw new Error(`[openclaw-streaming-runtime-patch] Missing completions stream anchor in ${filePath}`);
  }
  return {
    content: content.replace(SCHEDULER_ANCHOR, SCHEDULER_PATCH).replace(CONTENT_ANCHOR, CONTENT_PATCH),
    changed: true,
  };
}

function patchChatServer(content, filePath) {
  if (content.includes(CHAT_MARKER)) return { content, changed: false };
  if (!content.includes(CHAT_STATE_ANCHOR)) {
    throw new Error(`[openclaw-streaming-runtime-patch] Missing chat server anchor in ${filePath}`);
  }
  const chatThrottleAnchor = `if (now - (chatRunState.deltaSentAt.get(clientRunId) ?? 0) < 150) return;`;
  const agentThrottleAnchor = `if (last !== void 0 && now - last < 150) {`;
  if (!content.includes(chatThrottleAnchor) || !content.includes(agentThrottleAnchor)) {
    throw new Error(`[openclaw-streaming-runtime-patch] Missing throttle anchor in ${filePath}`);
  }
  return {
    content: content
      .replace(CHAT_STATE_ANCHOR, CHAT_STATE_PATCH)
      .replace(chatThrottleAnchor, `if (now - (chatRunState.deltaSentAt.get(clientRunId) ?? 0) < UCLAW_CHAT_DELTA_THROTTLE_MS_V1) return;`)
      .replace(agentThrottleAnchor, `if (last !== void 0 && now - last < UCLAW_CHAT_DELTA_THROTTLE_MS_V1) {`),
    changed: true,
  };
}

export function patchOpenClawStreamingRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };
  const files = readdirSync(distDir).filter((file) => file.endsWith('.js'));
  const transportTargets = files.filter((file) => readFileSync(join(distDir, file), 'utf8').includes('async function processOpenAICompletionsStream(responseStream'));
  const chatTargets = files.filter((file) => readFileSync(join(distDir, file), 'utf8').includes(CHAT_STATE_ANCHOR));
  if (transportTargets.length !== 1 || chatTargets.length !== 1) {
    throw new Error(`[openclaw-streaming-runtime-patch] Expected one transport and one chat runtime; found ${transportTargets.length}/${chatTargets.length}`);
  }
  let patchedFiles = 0;
  for (const [file, patcher] of [[transportTargets[0], patchTransport], [chatTargets[0], patchChatServer]]) {
    const filePath = join(distDir, file);
    const original = readFileSync(filePath, 'utf8');
    const patched = patcher(original, filePath);
    if (patched.changed) {
      writeFileSync(filePath, patched.content, 'utf8');
      patchedFiles += 1;
    }
    logger.log?.(`[openclaw-streaming-runtime-patch] ${patched.changed ? 'Patched' : 'Already patched'}: ${file}`);
  }
  return { patchedFiles, distDir };
}

export function patchInstalledOpenClawStreamingRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawStreamingRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
