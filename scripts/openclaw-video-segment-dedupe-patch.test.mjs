import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  patchOpenClawVideoSegmentDedupeContent,
} from './openclaw-video-segment-dedupe-patch.mjs';

const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const runtimeFile = readdirSync(distDir).find((name) => name.startsWith('openclaw-tools-') && name.endsWith('.js'));
assert.ok(runtimeFile, 'OpenClaw tool runtime was not found');

const source = readFileSync(join(distDir, runtimeFile), 'utf8');
const first = patchOpenClawVideoSegmentDedupeContent(source, runtimeFile);
assert.equal(first.matched, true);
assert.match(first.content, /UCLAW_VIDEO_SEGMENT_DEDUPE_V2/u);
assert.match(first.content, /parentTaskId: Type\.Optional/u);
assert.match(first.content, /segmentId: Type\.Optional/u);
assert.match(first.content, /Long-form work may call video_generate multiple times/u);
assert.doesNotMatch(first.content, /do not call video_generate again for same request/iu);

// Legacy calls retain the existing session-wide single-flight guard.
assert.match(
  first.content,
  /const activeDuplicateGuardResult = segmentScope \? void 0 : createVideoGenerateDuplicateGuardResult\(options\?\.agentSessionKey\)/u,
);

// Scoped calls dedupe by a stable logical segment, while provider prompts stay unchanged.
assert.match(first.content, /prompt: taskLabel,\n\t\t\t\trequestKey/u);
assert.match(first.content, /parentTaskId: segmentScope\?\.parentTaskId/u);
assert.match(first.content, /segmentId: segmentScope\?\.segmentId/u);
assert.match(first.content, /const taskHandle = createVideoGenerationTaskRun\([\s\S]*?prompt: taskLabel/u);
assert.match(first.content, /run: \(\) => executeVideoGenerationJob\([\s\S]*?\n\t\t\t\t\t\tprompt,/u);
assert.match(first.content, /taskLabel,\n\t\t\t\t\trequestKey/u);
assert.match(first.content, /other planned segmentId values remain allowed/u);
assert.match(first.content, /distinct segmentId values under the same parentTaskId/u);

// Recent successful scoped tasks remain detectable after the in-memory request-key cache is lost.
assert.match(first.content, /listFreshTasksForOwnerKey\(normalizedSessionKey\)\.find/u);
assert.match(first.content, /task\.status === "succeeded"/u);

const helperMatch = first.content.match(/function resolveVideoGenerationSegmentScope\(parentTaskId, segmentId\) \{[\s\S]*?\n\}/u);
assert.ok(helperMatch, 'segment scope helper was not injected');
class ToolInputError extends Error {}
const resolveVideoGenerationSegmentScope = new Function(
  'normalizeOptionalString',
  'ToolInputError',
  'stableStringify',
  `${helperMatch[0]}; return resolveVideoGenerationSegmentScope;`,
)(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined,
  ToolInputError,
  (value) => JSON.stringify(value, Object.keys(value).sort()),
);

assert.equal(resolveVideoGenerationSegmentScope(undefined, undefined), undefined);
assert.throws(() => resolveVideoGenerationSegmentScope('long-video-1', undefined), /provided together/u);
const sceneOne = resolveVideoGenerationSegmentScope('long-video-1', 'scene-001');
const sceneOneReplay = resolveVideoGenerationSegmentScope('long-video-1', 'scene-001');
const sceneTwo = resolveVideoGenerationSegmentScope('long-video-1', 'scene-002');
assert.equal(sceneOne.taskLabel, sceneOneReplay.taskLabel);
assert.notEqual(sceneOne.taskLabel, sceneTwo.taskLabel);

const second = patchOpenClawVideoSegmentDedupeContent(first.content, runtimeFile);
assert.equal(second.matched, true);
assert.equal(second.changed, false);
assert.equal(second.content, first.content);

console.log('openclaw video segment dedupe patch tests passed');
