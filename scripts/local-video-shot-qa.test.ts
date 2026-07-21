import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { HostCapabilityTaskContext } from '../electron/services/agent-runtime/host-capability-registry.ts';
import type { HostTaskSnapshot, HostTaskUpdateRequest } from '../electron/services/agent-runtime/host-task-service.ts';
import { resolveLocalMediaTools } from '../electron/services/agent-runtime/local-media-runtime.ts';
import {
  assessLocalVideoShotQaAvailability,
  normalizeLocalVideoShotQaInput,
  runLocalVideoShotQa,
} from '../electron/services/agent-runtime/local-video-shot-qa.ts';

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `${path.basename(executable)} exited with ${code}`)));
  });
}

test('normalizes a shot QA request and rejects unsupported dimensions', () => {
  const normalized = normalizeLocalVideoShotQaInput({ sourcePath: '/managed/shot.mp4' });
  assert.equal(normalized.sampleFrameCount, 6);
  assert.equal(normalized.requireAudio, false);
  assert.equal(normalized.includeSourceArtifact, false);
  assert.equal(normalized.durationToleranceSeconds, 0.35);
  assert.throws(() => normalizeLocalVideoShotQaInput({ sourcePath: '/managed/shot.mp4', expectedWidth: 641 }), /even integer/);
  assert.throws(() => normalizeLocalVideoShotQaInput({ sourcePath: '/managed/shot.mp4', sampleFrameCount: 2 }), /integer from 3 to 12/);
});

test('reports shot QA capability from the packaged media runtime', async () => {
  const availability = await assessLocalVideoShotQaAvailability();
  if (availability.availability === 'unavailable') {
    assert.match(availability.reason ?? '', /FFmpeg|media runtime/iu);
  } else {
    assert.equal(availability.availability, 'available');
  }
});

test('creates a contact sheet and flags black/frozen samples without rejecting valid media', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-video-shot-qa-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    const tools = await resolveLocalMediaTools();
    assert.ok(tools, 'packaged media runtime is required for this smoke test');
    const fixtureDir = path.join(root, 'media', 'outbound', 'shot-qa-fixtures');
    const sourcePath = path.join(fixtureDir, 'black-still-with-audio.mp4');
    await mkdir(fixtureDir, { recursive: true });
    await run(tools.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath,
    ]);
    const input = {
      sourcePath,
      expectedDurationSeconds: 2,
      durationToleranceSeconds: 0.2,
      expectedWidth: 320,
      expectedHeight: 180,
      requireAudio: true,
      includeSourceArtifact: true,
      sampleFrameCount: 4,
    };
    const task: HostTaskSnapshot = {
      version: 3,
      taskId: 'shot-qa-smoke-task',
      sessionKey: 'agent:main:shot-qa-smoke',
      runId: 'run-shot-qa-smoke',
      toolCallId: 'tool-shot-qa-smoke',
      idempotencyKey: 'shot-qa-smoke-key',
      capability: 'local.video.shot.qa',
      title: 'Shot QA smoke',
      input,
      acceptance: {
        source: 'host_capability',
        requiresArtifact: true,
        requiresVerification: true,
        requiredVerificationKinds: ['media.shot.qa'],
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
    await runLocalVideoShotQa(context);
    const completed = updates.findLast((update) => update.status === 'succeeded');
    assert.ok(completed);
    assert.equal(completed.artifacts?.length, 6);
    const sourceVideo = completed.artifacts?.find((artifact) => artifact.id.endsWith(':source-video'));
    assert.ok(sourceVideo?.filePath);
    const shotQa = completed.verifications?.find((verification) => verification.kind === 'media.shot.qa');
    assert.equal(shotQa?.status, 'passed');
    assert.equal(shotQa?.artifactId, sourceVideo?.id);
    const qa = JSON.parse(completed.verifications?.find((verification) => verification.kind === 'media.shot.qa')?.detail ?? '{}') as {
      qualitySignals?: { blackFrameCount?: number; possibleFreeze?: boolean };
    };
    assert.equal(qa.qualitySignals?.blackFrameCount, 4);
    assert.equal(qa.qualitySignals?.possibleFreeze, true);
    const contactSheet = completed.artifacts?.find((artifact) => artifact.id.endsWith(':contact-sheet'));
    assert.ok(contactSheet?.filePath);
    assert.ok((await stat(contactSheet.filePath)).size > 0);
  } finally {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});
