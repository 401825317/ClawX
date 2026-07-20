import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-billing-error-classification-patch';
const CLASSIFIER_PATCH_MARKER = 'UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V2';
const LEGACY_CLASSIFIER_PATCH_MARKER = 'UCLAW_INSUFFICIENT_USER_QUOTA_BILLING_V1';
const PROFILE_GUARD_PATCH_MARKER = 'UCLAW_BILLING_PROFILE_COOLDOWN_GUARD_V1';
const BILLING_PATTERN_ANCHOR = '\t\t/insufficient[_ ]quota/i,';
const BILLING_PATTERN_PATCH = '\t\t/insufficient(?:[_ -]+user)?[_ -]+quota/i,';
const CLASSIFIER_MARKER_ANCHOR = 'const BILLING_ERROR_HEAD_RE = ';
const PROFILE_GUARD_SIGNATURE = 'const maybeMarkAuthProfileFailure = async (failure) => {';
const PROFILE_GUARD_ANCHOR = [
  '\t\t\t\tconst { profileId, reason } = failure;',
  '\t\t\t\tif (!profileId || !reason) return;',
  '\t\t\t\tif (pluginHarnessOwnsTransport && reason === "timeout") return;',
].join('\n');
const PROFILE_GUARD_PATCH = [
  '\t\t\t\tconst { profileId, reason } = failure;',
  '\t\t\t\tif (!profileId || !reason) return;',
  '\t\t\t\tif (reason === "billing") return;',
  '\t\t\t\tif (pluginHarnessOwnsTransport && reason === "timeout") return;',
].join('\n');

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

function patchBillingClassifier(content, filePath) {
  if (!content.includes('function isBillingErrorMessage(raw)') || !content.includes('billing: [')) {
    return { content, changed: false, matched: false, role: null };
  }

  let next = content;
  const hasPatchedPattern = next.includes(BILLING_PATTERN_PATCH);
  const rawPatternCount = countOccurrences(next, BILLING_PATTERN_ANCHOR);
  if (!hasPatchedPattern) {
    if (rawPatternCount !== 1) {
      throw new Error(
        `[${PATCH_NAME}] Expected one unpatched billing pattern in ${filePath}; found ${rawPatternCount}.`,
      );
    }
    next = next.replace(BILLING_PATTERN_ANCHOR, BILLING_PATTERN_PATCH);
  } else if (rawPatternCount !== 0) {
    throw new Error(`[${PATCH_NAME}] Found mixed billing classifier patterns in ${filePath}.`);
  }

  if (next.includes(`const ${LEGACY_CLASSIFIER_PATCH_MARKER} = true;`)) {
    next = next.replace(LEGACY_CLASSIFIER_PATCH_MARKER, CLASSIFIER_PATCH_MARKER);
  } else if (!next.includes(`const ${CLASSIFIER_PATCH_MARKER} = true;`)) {
    const markerCount = countOccurrences(next, CLASSIFIER_MARKER_ANCHOR);
    if (markerCount !== 1) {
      throw new Error(
        `[${PATCH_NAME}] Expected one classifier marker anchor in ${filePath}; found ${markerCount}.`,
      );
    }
    next = next.replace(
      CLASSIFIER_MARKER_ANCHOR,
      `const ${CLASSIFIER_PATCH_MARKER} = true;\n${CLASSIFIER_MARKER_ANCHOR}`,
    );
  }

  return { content: next, changed: next !== content, matched: true, role: 'classifier' };
}

function patchBillingProfileCooldownGuard(content, filePath) {
  if (!content.includes(PROFILE_GUARD_SIGNATURE)) {
    return { content, changed: false, matched: false, role: null };
  }

  let next = content;
  const guardLine = '\t\t\t\tif (reason === "billing") return;';
  if (!next.includes(guardLine)) {
    const anchorCount = countOccurrences(next, PROFILE_GUARD_ANCHOR);
    if (anchorCount !== 1) {
      throw new Error(
        `[${PATCH_NAME}] Expected one auth profile failure guard anchor in ${filePath}; found ${anchorCount}.`,
      );
    }
    next = next.replace(PROFILE_GUARD_ANCHOR, PROFILE_GUARD_PATCH);
  }

  if (!next.includes(`const ${PROFILE_GUARD_PATCH_MARKER} = true;`)) {
    const signatureCount = countOccurrences(next, PROFILE_GUARD_SIGNATURE);
    if (signatureCount !== 1) {
      throw new Error(
        `[${PATCH_NAME}] Expected one auth profile failure function in ${filePath}; found ${signatureCount}.`,
      );
    }
    next = next.replace(
      PROFILE_GUARD_SIGNATURE,
      `const ${PROFILE_GUARD_PATCH_MARKER} = true;\n\t\t\t${PROFILE_GUARD_SIGNATURE}`,
    );
  }

  return { content: next, changed: next !== content, matched: true, role: 'profile-guard' };
}

export function patchOpenClawBillingErrorClassificationContent(content, filePath = '<fixture>') {
  const classifier = patchBillingClassifier(content, filePath);
  if (classifier.matched) return classifier;
  return patchBillingProfileCooldownGuard(content, filePath);
}

export function patchOpenClawBillingErrorClassificationRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  let matchedFiles = 0;
  let patchedFiles = 0;
  let alreadyPatchedFiles = 0;
  let classifierFiles = 0;
  let profileGuardFiles = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const content = readFileSync(filePath, 'utf8');
    const result = patchOpenClawBillingErrorClassificationContent(content, filePath);
    if (!result.matched) continue;
    matchedFiles += 1;
    if (result.role === 'classifier') classifierFiles += 1;
    if (result.role === 'profile-guard') profileGuardFiles += 1;
    if (result.changed) {
      patchedFiles += 1;
      if (!dryRun) writeFileSync(filePath, result.content, 'utf8');
    } else {
      alreadyPatchedFiles += 1;
    }
  }

  if (classifierFiles !== 1 || profileGuardFiles !== 1) {
    throw new Error(
      `[${PATCH_NAME}] Expected one classifier and one profile guard file; `
      + `found classifier=${classifierFiles} profileGuard=${profileGuardFiles}.`,
    );
  }
  logger.log?.(
    `[${PATCH_NAME}] ${dryRun ? 'Dry-run matched' : 'Patched'} ${patchedFiles} file(s); `
    + `${alreadyPatchedFiles} already patched.`,
  );
  return {
    matchedFiles,
    patchedFiles,
    alreadyPatchedFiles,
    classifierFiles,
    profileGuardFiles,
  };
}

export function patchInstalledOpenClawBillingErrorClassificationRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawBillingErrorClassificationRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
