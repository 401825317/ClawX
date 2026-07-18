import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { patchOpenClawSessionYieldGuardContent } from './openclaw-session-yield-guard-patch.mjs';

const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
const runtimeFile = readdirSync(distDir).find((name) => name.startsWith('openclaw-tools-') && name.endsWith('.js'));
assert.ok(runtimeFile, 'OpenClaw tool runtime was not found');

const source = readFileSync(join(distDir, runtimeFile), 'utf8');
const first = patchOpenClawSessionYieldGuardContent(source, runtimeFile);
assert.equal(first.matched, true);
assert.match(first.content, /UCLAW_SESSION_YIELD_GUARD_V1/u);
assert.match(first.content, /active spawned child work/u);
assert.match(first.content, /No active spawned child work is registered for this session; do not call sessions_yield/u);
assert.match(first.content, /sessionKey: options\?\.sessionKey/u);
assert.match(first.content, /const activeChildren = opts\?\.sessionKey \? countActiveRunsForSession\(opts\.sessionKey\) : 0;/u);
assert.doesNotMatch(first.content, /Use after spawning subagents; results arrive as next message/iu);

const second = patchOpenClawSessionYieldGuardContent(first.content, runtimeFile);
assert.equal(second.matched, true);
assert.equal(second.changed, false);
assert.equal(second.content, first.content);

console.log('openclaw session yield guard patch tests passed');
