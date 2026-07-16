import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'uclaw-video-project-'));
const previousOpenClawHome = process.env.OPENCLAW_HOME;
process.env.OPENCLAW_HOME = stateRoot;

try {
  const { __test } = await import('./index.mjs');
  const hostRequests = [];
  const renderTask = {
    taskId: 'host-compose-1',
    status: 'queued',
    artifacts: [],
    verifications: [],
    delivery: { status: 'not_applicable' },
  };
  const finalQaTask = {
    taskId: 'host-final-qa-1',
    status: 'queued',
    artifacts: [],
    verifications: [],
    delivery: { status: 'pending' },
  };
  const hostApiFetch = async (route, options = {}) => {
    if (route === '/api/task-bridge/tasks') {
      const request = JSON.parse(options.body);
      hostRequests.push(request);
      if (request.kind === 'local.video.timeline.render') return renderTask;
      if (request.kind === 'local.video.shot.qa') return finalQaTask;
      throw new Error(`Unexpected Host capability ${request.kind}`);
    }
    if (route.startsWith('/api/task-bridge/tasks/host-compose-1')) return renderTask;
    if (route.startsWith('/api/task-bridge/tasks/host-final-qa-1')) return finalQaTask;
    throw new Error(`Unexpected Host route ${route}`);
  };
  const tools = __test.createTools({
    sessionKey: 'agent:main:video-project-harness',
    runId: 'run-video-project-harness',
  }, { hostApiFetch });
  const projectTool = tools.find((tool) => tool.name === 'uclaw_video_project');
  const shotTool = tools.find((tool) => tool.name === 'uclaw_video_shot');
  assert.ok(projectTool);
  assert.ok(shotTool);

  const created = await projectTool.execute('tool-create', {
    action: 'create',
    title: 'Reference project',
    goal: 'A short product video',
    constraints: { model: 'openai/grok-video-1.5', size: '1280x720', targetDurationSeconds: 6 },
    reference: { filePath: '/managed/reference.png', artifactId: 'artifact:reference' },
    shots: [{ shotId: 'shot-1', prompt: 'A bright product reveal', durationSeconds: 6 }],
  });
  const project = created.details.project;
  const shot = project.shots[0];
  assert.equal(shot.generationInput.parentTaskId, project.projectId);
  assert.equal(shot.generationInput.segmentId, 'shot-1');
  assert.equal(shot.generationInput.image, '/managed/reference.png');
  assert.deepEqual(shot.generationInput.imageRoles, ['reference_image']);
  assert.equal(shot.generationInput.size, '1280x720');

  const attempt = await shotTool.execute('tool-attempt', {
    action: 'record_attempt',
    projectId: project.projectId,
    shotId: 'shot-1',
    attemptStatus: 'succeeded',
    providerTaskId: 'provider-task-1',
    artifact: { filePath: '/managed/shot-1.mp4', durationSeconds: 6, width: 1280, height: 720 },
    qa: { status: 'pass', deterministic: true, semantic: true, summary: 'Metadata and semantic review passed.' },
  });
  const attemptId = attempt.details.project.shots[0].currentAttemptId;
  const accepted = await shotTool.execute('tool-accept', {
    action: 'accept', projectId: project.projectId, shotId: 'shot-1', attemptId,
    qa: { status: 'pass', deterministic: true, semantic: true },
  });
  assert.equal(accepted.details.project.status, 'ready_to_compose');

  const finalized = await projectTool.execute('tool-finalize', {
    action: 'finalize', projectId: project.projectId, finalizationStatus: 'delivered',
    artifact: { filePath: '/managed/final.mp4', durationSeconds: 6, width: 1280, height: 720 },
  });
  assert.equal(finalized.details.project.status, 'completed');

  const multiShot = await projectTool.execute('tool-multi-create', {
    action: 'create',
    title: 'Two-shot project',
    goal: 'Compose two approved generated clips into one final video.',
    constraints: { size: '1280x720', targetDurationSeconds: 8 },
    shots: [
      { shotId: 'shot-a', prompt: 'First product shot', durationSeconds: 4 },
      { shotId: 'shot-b', prompt: 'Second product shot', durationSeconds: 4 },
    ],
  });
  for (const shotId of ['shot-a', 'shot-b']) {
    const recorded = await shotTool.execute(`tool-${shotId}-attempt`, {
      action: 'record_attempt',
      projectId: multiShot.details.project.projectId,
      shotId,
      attemptStatus: 'succeeded',
      providerTaskId: `provider-${shotId}`,
      artifact: {
        filePath: `/managed/${shotId}.mp4`,
        durationSeconds: 4,
        width: 1280,
        height: 720,
      },
      qa: { status: 'pass', deterministic: true, semantic: true },
    });
    await shotTool.execute(`tool-${shotId}-accept`, {
      action: 'accept',
      projectId: multiShot.details.project.projectId,
      shotId,
      attemptId: recorded.details.project.shots.find((shot) => shot.shotId === shotId).currentAttemptId,
      qa: { status: 'pass', deterministic: true, semantic: true },
    });
  }

  const composeStarted = await projectTool.execute('tool-compose', {
    action: 'compose',
    projectId: multiShot.details.project.projectId,
    composition: { filename: 'two-shot-final.mp4', transition: 'crossfade', transitionDurationSeconds: 0.4 },
  });
  assert.equal(composeStarted.details.project.status, 'composing');
  assert.equal(hostRequests.length, 1);
  assert.equal(hostRequests[0].kind, 'local.video.timeline.render');
  assert.equal(hostRequests[0].completion.mode, 'internal');
  assert.equal(hostRequests[0].input.scenes.length, 2);
  assert.equal(hostRequests[0].input.scenes[1].transition, 'crossfade');

  Object.assign(renderTask, {
    status: 'succeeded',
    artifacts: [{ id: 'artifact:host-compose-1:video', kind: 'video', filePath: '/managed/two-shot-composed.mp4', mimeType: 'video/mp4' }],
    verifications: [{ id: 'verification:host-compose-1:metadata', kind: 'media.metadata', status: 'passed' }],
  });
  const renderReconciled = await projectTool.execute('tool-compose-get', {
    action: 'get', projectId: multiShot.details.project.projectId,
  });
  assert.equal(renderReconciled.details.project.composition.status, 'verifying');
  assert.equal(hostRequests.length, 2);
  assert.equal(hostRequests[1].kind, 'local.video.shot.qa');
  assert.equal(hostRequests[1].completion.mode, 'direct');
  assert.equal(hostRequests[1].input.includeSourceArtifact, true);

  Object.assign(finalQaTask, {
    status: 'succeeded',
    artifacts: [{ id: 'artifact:host-final-qa-1:source-video', kind: 'video', filePath: '/managed/two-shot-final.mp4', mimeType: 'video/mp4' }],
    verifications: [
      { id: 'verification:host-final-qa-1:metadata', kind: 'media.metadata', status: 'passed' },
      { id: 'verification:host-final-qa-1:shot-qa', kind: 'media.shot.qa', status: 'passed', detail: '{"qualitySignals":{"possibleFreeze":false}}' },
    ],
    delivery: { status: 'delivered' },
  });
  const delivered = await projectTool.execute('tool-compose-delivered', {
    action: 'get', projectId: multiShot.details.project.projectId,
  });
  assert.equal(delivered.details.project.status, 'completed');
  assert.equal(delivered.details.project.finalization.status, 'delivered');
  assert.equal(delivered.details.project.finalization.artifact.filePath, '/managed/two-shot-final.mp4');

  const missingReference = await projectTool.execute('tool-no-reference', {
    action: 'create', title: 'Missing image', goal: 'Should fail before generation',
    constraints: { model: 'openai/grok-video-1.5' },
    shots: [{ shotId: 'shot-1', prompt: 'No reference image' }],
  });
  assert.equal(missingReference.details.code, 'reference_image_required');
  console.log('uclaw-video-project harness passed');
} finally {
  if (previousOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previousOpenClawHome;
  await rm(stateRoot, { recursive: true, force: true });
}
