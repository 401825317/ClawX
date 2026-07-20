import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchOpenClawReplySessionInitConflictRuntime } from './openclaw-reply-session-init-conflict-patch.mjs';

async function findReplyFixture() {
  const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = await readFile(filePath, 'utf8');
    if (content.includes('async function initSessionState(params) {')) {
      return content;
    }
  }
  throw new Error('OpenClaw reply-session fixture was not found.');
}

const fixture = await findReplyFixture();
const distDir = mkdtempSync(join(tmpdir(), 'uclaw-reply-session-coordinator-'));
writeFileSync(join(distDir, 'get-reply.js'), fixture);
writeFileSync(join(distDir, 'unrelated.js'), 'const unrelated = true;');

const first = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log() {} } });
assert.equal(first.patchedFiles, fixture.includes('UCLAW_SESSION_COORDINATOR_V1') ? 0 : 1);
const patched = readFileSync(join(distDir, 'get-reply.js'), 'utf8');
assert.match(patched, /UCLAW_SESSION_COORDINATOR_V1/u);
assert.match(patched, /String\(operation \|\| "unknown"\) \+ ":" \+ key/u);
assert.match(patched, /UCLAW_REPLY_SESSION_INIT_CONFLICT_RELOAD_MARKER/u);
assert.doesNotMatch(patched, /__uclawReplySessionInitConflictQueues/u);

const second = patchOpenClawReplySessionInitConflictRuntime(distDir, { logger: { log() {} } });
assert.equal(second.patchedFiles, 0);
assert.equal(second.distDir, distDir);

console.log('openclaw reply-session initialization contract patch tests passed');
