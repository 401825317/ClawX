import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { ensureDefaultHostCapabilities } from '../electron/services/agent-runtime/host-capability-defaults.ts';
import type { HostCapabilityTaskContext } from '../electron/services/agent-runtime/host-capability-registry.ts';
import { hostCapabilityRegistry } from '../electron/services/agent-runtime/host-capability-registry.ts';
import {
  assessLocalVideoTimelineAvailability,
  normalizeLocalVideoTimelineInput,
  runLocalVideoTimelineRender,
} from '../electron/services/agent-runtime/local-video-timeline.ts';
import type { HostTaskSnapshot, HostTaskUpdateRequest } from '../electron/services/agent-runtime/host-task-service.ts';

test('normalizes timeline scenes and rejects a target longer than the planned scenes', () => {
  const normalized = normalizeLocalVideoTimelineInput({
    scenes: [
      { sourcePath: '/managed/one.png', durationSeconds: 3, caption: 'First scene' },
      {
        sourcePath: '/managed/two.mp4',
        durationSeconds: 4,
        motion: 'pan_left',
        transition: 'crossfade',
        transitionDurationSeconds: 0.8,
      },
    ],
    filename: 'Launch film',
  });

  assert.equal(normalized.filename, 'Launch_film.mp4');
  assert.equal(normalized.width, 1920);
  assert.equal(normalized.height, 1080);
  assert.equal(normalized.fps, 30);
  assert.equal(normalized.scenes[0]?.kind, 'image');
  assert.equal(normalized.scenes[0]?.motion, 'ken_burns');
  assert.equal(normalized.scenes[1]?.kind, 'video');
  assert.equal(normalized.scenes[1]?.transition, 'crossfade');

  assert.throws(() => normalizeLocalVideoTimelineInput({
    scenes: [{ sourcePath: '/managed/one.png', durationSeconds: 3 }],
    targetDurationSeconds: 4,
  }), /below target/);
  assert.throws(() => normalizeLocalVideoTimelineInput({
    scenes: [{ sourcePath: '/managed/unknown.asset', durationSeconds: 3 }],
  }), /kind is required/);
  assert.throws(() => normalizeLocalVideoTimelineInput({
    scenes: [{ sourcePath: '/managed/one.png', durationSeconds: 3 }],
    width: 641,
  }), /even integer/);
});

test('registers timeline rendering as a discoverable Host task with its input schema', async () => {
  ensureDefaultHostCapabilities();
  const registration = await hostCapabilityRegistry.get('local.video.timeline.render');
  assert.ok(registration);
  assert.equal(registration.capability.sideEffect, 'local_artifact');
  assert.deepEqual(registration.capability.operations, { start: true, cancel: true, resume: true });
  assert.deepEqual(registration.capability.inputSchema?.required, ['scenes']);
  assert.match(registration.capability.description, /image or video scenes/);
});

test('reports timeline capability from the packaged media runtime', async () => {
  const availability = await assessLocalVideoTimelineAvailability();
  if (availability.availability === 'unavailable') {
    assert.equal(availability.availability, 'unavailable');
    assert.match(availability.reason ?? '', /FFmpeg|media runtime/iu);
  } else {
    assert.equal(availability.availability, 'available');
  }
});

test('renders and verifies a narrated image timeline on macOS', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-video-timeline-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    const sourceDir = path.join(root, 'media', 'outbound', 'timeline-fixtures');
    const firstImage = path.join(sourceDir, 'first.png');
    const secondImage = path.join(sourceDir, 'second.png');
    await mkdir(sourceDir, { recursive: true });
    await sharp({
      create: { width: 640, height: 360, channels: 4, background: { r: 18, g: 24, b: 36, alpha: 1 } },
    }).png().toFile(firstImage);
    await sharp({
      create: { width: 640, height: 360, channels: 4, background: { r: 220, g: 72, b: 48, alpha: 1 } },
    }).png().toFile(secondImage);

    const input = {
      scenes: [
        {
          sourcePath: firstImage,
          durationSeconds: 0.75,
          motion: 'zoom_in',
          transition: 'crossfade',
          transitionDurationSeconds: 0.2,
          caption: '性能释放',
        },
        {
          sourcePath: secondImage,
          durationSeconds: 0.75,
          motion: 'pan_right',
          caption: '科技进化',
        },
      ],
      filename: 'timeline-smoke.mp4',
      targetDurationSeconds: 1.25,
      width: 640,
      height: 360,
      fps: 12,
      narrationText: '性能与科技，驱动下一程。',
      voice: 'Tingting',
    };
    const task: HostTaskSnapshot = {
      version: 3,
      taskId: 'timeline-smoke-task',
      sessionKey: 'agent:main:timeline-smoke',
      runId: 'run-timeline-smoke',
      toolCallId: 'tool-timeline-smoke',
      idempotencyKey: 'timeline-smoke-key',
      capability: 'local.video.timeline.render',
      title: 'Timeline smoke',
      input,
      acceptance: {
        source: 'host_capability',
        requiresArtifact: true,
        requiresVerification: true,
        requiredVerificationKinds: ['media.metadata'],
      },
      completion: { mode: 'direct' },
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      artifacts: [],
      verifications: [],
      completionAcks: [],
      lifecycle: { operations: [] },
    };
    const updates: HostTaskUpdateRequest[] = [];
    const context: HostCapabilityTaskContext = {
      task,
      input,
      async update(update) {
        updates.push(update);
        return undefined;
      },
    };

    await runLocalVideoTimelineRender(context);

    const completed = updates.findLast((update) => update.status === 'succeeded');
    assert.ok(completed);
    assert.equal(completed.artifacts?.length, 1);
    assert.equal(completed.verifications?.[0]?.status, 'passed');
    const filePath = completed.artifacts?.[0]?.filePath;
    assert.ok(filePath);
    assert.ok((await stat(filePath)).size > 0);
    const metadata = JSON.parse(completed.verifications?.[0]?.detail ?? '{}') as {
      durationSeconds?: number;
      width?: number;
      height?: number;
      hasAudio?: boolean;
      sceneCount?: number;
      captionCount?: number;
    };
    assert.ok(Math.abs((metadata.durationSeconds ?? 0) - 1.25) <= 0.2);
    assert.equal(metadata.width, 640);
    assert.equal(metadata.height, 360);
    assert.equal(metadata.hasAudio, true);
    assert.equal(metadata.sceneCount, 2);
    assert.equal(metadata.captionCount, 2);

    const videoInput = {
      scenes: [{
        sourcePath: filePath,
        kind: 'video',
        durationSeconds: 0.6,
        motion: 'none',
        caption: '视频场景',
      }],
      filename: 'timeline-video-scene.mp4',
      targetDurationSeconds: 0.6,
      width: 320,
      height: 240,
      fps: 12,
      backgroundMusicPath: filePath,
      backgroundMusicVolume: 0.2,
    };
    const videoTask: HostTaskSnapshot = {
      ...task,
      taskId: 'timeline-video-scene-task',
      toolCallId: 'tool-timeline-video-scene',
      idempotencyKey: 'timeline-video-scene-key',
      input: videoInput,
    };
    const videoUpdates: HostTaskUpdateRequest[] = [];
    await runLocalVideoTimelineRender({
      task: videoTask,
      input: videoInput,
      async update(update) {
        videoUpdates.push(update);
        return undefined;
      },
    });
    const videoCompleted = videoUpdates.findLast((update) => update.status === 'succeeded');
    assert.ok(videoCompleted);
    const videoMetadata = JSON.parse(videoCompleted.verifications?.[0]?.detail ?? '{}') as {
      durationSeconds?: number;
      width?: number;
      height?: number;
      hasAudio?: boolean;
      videoSceneCount?: number;
    };
    assert.ok(Math.abs((videoMetadata.durationSeconds ?? 0) - 0.6) <= 0.2);
    assert.equal(videoMetadata.width, 320);
    assert.equal(videoMetadata.height, 240);
    assert.equal(videoMetadata.hasAudio, true);
    assert.equal(videoMetadata.videoSceneCount, 1);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});
