import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'uclaw-video-agent-contract-'));
const previousOpenClawHome = process.env.OPENCLAW_HOME;
process.env.OPENCLAW_HOME = stateRoot;

try {
  const artifactGuard = await import('../resources/openclaw-plugins/uclaw-artifact-guard/index.mjs');
  const videoProject = await import('../resources/openclaw-plugins/uclaw-video-project/index.mjs');
  const artifactGuardPackage = JSON.parse(await readFile(
    new URL('../resources/openclaw-plugins/uclaw-artifact-guard/package.json', import.meta.url),
    'utf8',
  ));

  assert.equal(artifactGuard.default.version, artifactGuardPackage.version);

  const lifecycleHooks = new Map();
  artifactGuard.__test.registerArtifactGuard({
    registerHook(name, handler) {
      lifecycleHooks.set(name, handler);
    },
    emitAgentEvent() {
      return { emitted: true };
    },
  });

  const beforePromptBuild = lifecycleHooks.get('before_prompt_build');
  assert.equal(typeof beforePromptBuild, 'function');
  const promptResult = await beforePromptBuild({
    runId: 'contract:prompt',
    userMessage: '生成一个有参考图的短视频',
    messages: [{ role: 'user', content: '生成一个有参考图的短视频' }],
  }, { runId: 'contract:prompt' });
  assert.match(promptResult?.appendSystemContext ?? '', /select the provider model explicitly/iu);
  assert.match(promptResult?.appendSystemContext ?? '', /create a uclaw_video_project before generation/iu);
  assert.match(promptResult?.appendSystemContext ?? '', /uclaw_video_project action:compose exactly once/iu);

  artifactGuard.__test.cacheTurnPreferences({
    runId: 'contract:media-defaults',
    toolName: 'video_generate',
    params: { prompt: 'test' },
  }, { runId: 'contract:media-defaults' }, {
    mode: 'video',
    video: { model: 'grok-video-1.5', size: '1280x720', durationSeconds: 6 },
  });
  const defaults = artifactGuard.__test.applyTurnMediaDefaults({
    runId: 'contract:media-defaults',
    toolName: 'video_generate',
    params: { prompt: 'test' },
  }, { runId: 'contract:media-defaults' });
  assert.deepEqual(defaults, {
    params: { prompt: 'test', size: '1280x720', durationSeconds: 6 },
    appliedKeys: ['size', 'durationSeconds'],
  });

  const tools = videoProject.__test.createTools({ sessionKey: 'agent:main:video-contract' }, {
    videoProviders: [{
      id: 'openai',
      defaultModel: 'grok-image-video',
      models: ['grok-image-video', 'grok-video-1.5'],
    }],
  });
  const projectTool = tools.find((tool) => tool.name === 'uclaw_video_project');
  const shotTool = tools.find((tool) => tool.name === 'uclaw_video_shot');
  assert.ok(projectTool);
  assert.ok(shotTool);

  const implicitModelProject = await projectTool.execute('contract-create', {
    action: 'create',
    title: 'Implicit model project',
    goal: 'Let the active OpenClaw video capability choose the provider model.',
    constraints: { size: '1280x720', targetDurationSeconds: 6 },
    shots: [{ shotId: 'shot-1', prompt: 'A clean product reveal', durationSeconds: 6 }],
  });
  assert.equal(implicitModelProject.details.ok, true);
  const implicitShot = implicitModelProject.details.project.shots[0];
  assert.equal(implicitShot.generationInput.model, undefined);
  assert.equal(implicitShot.generationInput.parentTaskId, implicitModelProject.details.project.projectId);
  assert.equal(implicitShot.generationInput.segmentId, 'shot-1');
  assert.equal(implicitShot.generationInput.size, '1280x720');
  assert.equal(implicitShot.generationInput.durationSeconds, 6);

  const referenceProject = await projectTool.execute('contract-reference-create', {
    action: 'create',
    title: 'Reference model project',
    goal: 'Use one managed reference image for image-to-video.',
    constraints: { model: 'openai/grok-video-1.5', targetDurationSeconds: 6 },
    reference: { filePath: '/managed/reference.png', artifactId: 'artifact:reference' },
    shots: [{ shotId: 'shot-1', prompt: 'Animate the reference product', durationSeconds: 6 }],
  });
  const referenceShot = referenceProject.details.project.shots[0];
  assert.equal(referenceShot.generationInput.model, 'openai/grok-video-1.5');
  assert.equal(referenceShot.generationInput.image, '/managed/reference.png');
  assert.deepEqual(referenceShot.generationInput.imageRoles, ['reference_image']);

  const missingReference = await projectTool.execute('contract-missing-reference', {
    action: 'create',
    title: 'Invalid reference project',
    goal: 'Reject an image-to-video model without a reference before provider submission.',
    constraints: { model: 'openai/grok-video-1.5' },
    shots: [{ shotId: 'shot-1', prompt: 'This must not submit' }],
  });
  assert.equal(missingReference.details.ok, false);
  assert.equal(missingReference.details.code, 'reference_image_required');

  const attempt = await shotTool.execute('contract-attempt', {
    action: 'record_attempt',
    projectId: referenceProject.details.project.projectId,
    shotId: 'shot-1',
    attemptStatus: 'succeeded',
    providerTaskId: 'provider-contract-1',
    artifact: { filePath: '/managed/reference-output.mp4', durationSeconds: 6, width: 1280, height: 720 },
    qa: { status: 'pass', deterministic: true, semantic: true },
  });
  const attemptId = attempt.details.project.shots[0].currentAttemptId;
  const accepted = await shotTool.execute('contract-accept', {
    action: 'accept',
    projectId: referenceProject.details.project.projectId,
    shotId: 'shot-1',
    attemptId,
    qa: { status: 'pass', deterministic: true, semantic: true },
  });
  assert.equal(accepted.details.project.status, 'ready_to_compose');

  console.log('uclaw video agent contract passed');
} finally {
  if (previousOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previousOpenClawHome;
  await rm(stateRoot, { recursive: true, force: true });
}
