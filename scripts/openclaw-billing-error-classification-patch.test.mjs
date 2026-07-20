import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  patchOpenClawBillingErrorClassificationContent,
  patchOpenClawBillingErrorClassificationRuntime,
} from './openclaw-billing-error-classification-patch.mjs';

async function findBillingFixtures() {
  const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');
  let classifier = null;
  let profileGuard = null;
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = await readFile(filePath, 'utf8');
    if (!classifier && content.includes('function isBillingErrorMessage(raw)') && content.includes('billing: [')) {
      classifier = {
        filePath,
        content: content
          .replace('const UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2 = true;\n', '')
          .replace('const UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V1 = true;\n', '')
          .replace('/insufficient(?:[_ -]+user)?[_ -]+quota/i,', '/insufficient[_ ]quota/i,'),
      };
    }
    if (!profileGuard && content.includes('const maybeMarkAuthProfileFailure = async (failure) => {')) {
      profileGuard = {
        filePath,
        content: content
          .replace('const UCLAW_BILLING_PROFILE_COOLDOWN_GUARD_V1 = true;\n\t\t\t', '')
          .replace('\t\t\t\tif (reason === "billing") return;\n', ''),
      };
    }
  }
  if (!classifier || !profileGuard) throw new Error('OpenClaw billing fixtures were not found.');
  return { classifier, profileGuard };
}

test('classifies insufficient_user_quota as a billing signal and migrates V1', async () => {
  const { classifier } = await findBillingFixtures();
  const first = patchOpenClawBillingErrorClassificationContent(classifier.content, classifier.filePath);
  assert.equal(first.matched, true);
  assert.equal(first.changed, true);
  assert.equal(first.role, 'classifier');
  assert.match(first.content, /UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2/u);
  assert.match(first.content, /insufficient\(\?:\[_ -\]\+user\)\?\[_ -\]\+quota/u);
  assert.doesNotMatch(first.content, /\/insufficient\[_ \]quota\/i/u);

  const legacy = first.content.replace(
    'UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2',
    'UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V1',
  );
  const migrated = patchOpenClawBillingErrorClassificationContent(legacy, classifier.filePath);
  assert.equal(migrated.changed, true);
  assert.match(migrated.content, /UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2/u);
  assert.doesNotMatch(migrated.content, /UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V1/u);

  const second = patchOpenClawBillingErrorClassificationContent(first.content, classifier.filePath);
  assert.equal(second.matched, true);
  assert.equal(second.changed, false);
});

test('billing failures surface without writing auth profile cooldown state', async () => {
  const fixture = [
    'const maybeMarkAuthProfileFailure = async (failure) => {',
    '\t\t\t\tconst { profileId, reason } = failure;',
    '\t\t\t\tif (!profileId || !reason) return;',
    '\t\t\t\tif (pluginHarnessOwnsTransport && reason === "timeout") return;',
    '\t\t\t\tawait markAuthProfileFailure({ profileId, reason });',
    '\t\t\t};',
    'globalThis.maybeMarkAuthProfileFailure = maybeMarkAuthProfileFailure;',
  ].join('\n');
  const patched = patchOpenClawBillingErrorClassificationContent(fixture, '<profile-guard-fixture>');
  assert.equal(patched.matched, true);
  assert.equal(patched.changed, true);
  assert.equal(patched.role, 'profile-guard');
  assert.match(patched.content, /UCLAW_BILLING_PROFILE_COOLDOWN_GUARD_V1/u);

  const failures = [];
  const context = vm.createContext({
    pluginHarnessOwnsTransport: false,
    markAuthProfileFailure: async (failure) => failures.push(failure),
  });
  new vm.Script(patched.content).runInContext(context);
  await context.maybeMarkAuthProfileFailure({ profileId: 'managed-openai', reason: 'billing' });
  assert.equal(failures.length, 0);
  await context.maybeMarkAuthProfileFailure({ profileId: 'managed-openai', reason: 'rate_limit' });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].profileId, 'managed-openai');
  assert.equal(failures[0].reason, 'rate_limit');

  const second = patchOpenClawBillingErrorClassificationContent(patched.content, '<profile-guard-fixture>');
  assert.equal(second.changed, false);
});

test('patches exactly one classifier and one profile guard runtime file', async () => {
  const { classifier, profileGuard } = await findBillingFixtures();
  const distDir = mkdtempSync(join(tmpdir(), 'uclaw-billing-classifier-'));
  writeFileSync(join(distDir, 'billing.js'), classifier.content, 'utf8');
  writeFileSync(join(distDir, 'embedded.js'), profileGuard.content, 'utf8');
  writeFileSync(join(distDir, 'unrelated.js'), 'const unrelated = true;', 'utf8');

  const first = patchOpenClawBillingErrorClassificationRuntime(distDir, { logger: { log() {} } });
  assert.equal(first.matchedFiles, 2);
  assert.equal(first.classifierFiles, 1);
  assert.equal(first.profileGuardFiles, 1);
  assert.equal(first.patchedFiles, 2);
  assert.match(
    readFileSync(join(distDir, 'billing.js'), 'utf8'),
    /UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2/u,
  );
  assert.match(
    readFileSync(join(distDir, 'embedded.js'), 'utf8'),
    /UCLAW_BILLING_PROFILE_COOLDOWN_GUARD_V1/u,
  );

  const second = patchOpenClawBillingErrorClassificationRuntime(distDir, { logger: { log() {} } });
  assert.equal(second.matchedFiles, 2);
  assert.equal(second.patchedFiles, 0);
  assert.equal(second.alreadyPatchedFiles, 2);
});
