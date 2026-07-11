import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __test } from '../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs';

function blockedDeck() {
  return {
    title: 'Incremental Repair Test',
    designIntent: 'Verify focused quality-gate repair without regenerating the deck.',
    outputDir: 'output',
    slides: [{
      background: 'FFFFFF',
      elements: [
        {
          type: 'text', role: 'title', text: 'First', x: 8, y: 10, w: 50, h: 20,
          fontSize: 36, color: '111111',
        },
        {
          type: 'text', role: 'body', text: 'Second', x: 20, y: 16, w: 45, h: 16,
          fontSize: 20, color: '111111',
        },
      ],
    }],
  };
}

test('repairs only a blocked element and renders the original high-design deck', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'uclaw-ppt-repair-'));
  try {
    const tools = __test.createTools();
    const create = tools.find((tool) => tool.name === 'create_designed_pptx_file');
    const repair = tools.find((tool) => tool.name === 'repair_designed_pptx_file');
    assert.ok(create);
    assert.ok(repair);

    const blocked = await create.execute('create-1', blockedDeck(), undefined, undefined, { cwd });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.details.repair.baseRevision, 0);
    assert.equal(blocked.details.repair.issues[0].code, 'text_overlap');
    assert.deepEqual(blocked.details.repair.issues[0].elementIndexes, [0, 1]);

    const result = await repair.execute('repair-1', {
      repairToken: blocked.details.repair.repairToken,
      baseRevision: 0,
      patches: [{
        op: 'replace_element',
        slideIndex: 0,
        elementIndex: 1,
        element: {
          type: 'text', role: 'body', text: 'Second', x: 20, y: 55, w: 45, h: 16,
          fontSize: 20, color: '111111',
        },
      }],
    }, undefined, undefined, { cwd });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.ok, true);
    assert.equal(result.details.verification.status, 'passed');
    assert.equal(result.details.verification.slideCount, 1);
    assert.equal(existsSync(result.details.filePath), true);
    assert.equal(__test.studioRepairDrafts.has(blocked.details.repair.repairToken), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('keeps a blocked repair draft revisioned and rejects stale retries', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'uclaw-ppt-repair-'));
  try {
    const tools = __test.createTools();
    const create = tools.find((tool) => tool.name === 'create_designed_pptx_file');
    const repair = tools.find((tool) => tool.name === 'repair_designed_pptx_file');
    const blocked = await create.execute('create-2', blockedDeck(), undefined, undefined, { cwd });
    const repairToken = blocked.details.repair.repairToken;

    const stillBlocked = await repair.execute('repair-2', {
      repairToken,
      baseRevision: 0,
      patches: [{
        op: 'replace_element',
        slideIndex: 0,
        elementIndex: 1,
        element: blockedDeck().slides[0].elements[1],
      }],
    }, undefined, undefined, { cwd });
    assert.equal(stillBlocked.isError, true);
    assert.equal(stillBlocked.details.repair.baseRevision, 1);

    const stale = await repair.execute('repair-3', {
      repairToken,
      baseRevision: 0,
      patches: [{
        op: 'replace_slide',
        slideIndex: 0,
        slide: blockedDeck().slides[0],
      }],
    }, undefined, undefined, { cwd });
    assert.equal(stale.isError, true);
    assert.match(stale.details.error, /revision mismatch/u);
  } finally {
    __test.studioRepairDrafts.clear();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rejects empty designed PPT input without writing a zero-slide artifact', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'uclaw-ppt-empty-'));
  try {
    const create = __test.createTools().find((tool) => tool.name === 'create_designed_pptx_file');
    assert.ok(create);
    const result = await create.execute('create-empty', {}, undefined, undefined, { cwd });
    assert.equal(result.isError, true);
    assert.equal(result.details.verification.status, 'blocked');
    assert.match(result.details.error, /title is required/u);
    assert.match(result.details.error, /at least one slide/u);
    assert.equal(result.details.filePath, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
