import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

export const OPENCLAW_SKILL_SHIM_IDS = [
  'presentation-maker',
  'spreadsheet-maker',
  'document-maker',
  'blender-maker',
];

export const OPENCLAW_SKILL_SHIM_ALLOWLIST = [
  ...OPENCLAW_SKILL_SHIM_IDS,
  'cad-editor',
  'ecommerce-main-image',
];

export const VERSIONED_OPENCLAW_SKILL_SHIMS = {
  'cad-editor': 'v1',
  'ecommerce-main-image': 'v1',
};

const MANIFEST_PATH = path.join(ROOT, 'resources', 'skills', 'preinstalled-manifest.json');
const VERSION_MARKER_NAME = '.uclaw-skill-shim.json';

function readSkillShimManifest(manifestPath = MANIFEST_PATH) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error(`Invalid OpenClaw skill shim manifest: ${manifestPath}`);
  }

  const skills = parsed.skills.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.installMode !== 'string') {
      throw new Error(`Invalid OpenClaw skill shim manifest entry: ${manifestPath}`);
    }
    return entry;
  });
  const manifestIds = skills.map((entry) => entry.id);
  if (JSON.stringify(manifestIds) !== JSON.stringify(OPENCLAW_SKILL_SHIM_ALLOWLIST)) {
    throw new Error('OpenClaw skill shim manifest does not match the bundle allowlist');
  }

  for (const [skillId, version] of Object.entries(VERSIONED_OPENCLAW_SKILL_SHIMS)) {
    const entry = skills.find((candidate) => candidate.id === skillId);
    if (entry?.installMode !== 'managed-sync' || entry.version !== version) {
      throw new Error(`Versioned OpenClaw skill shim contract is invalid: ${skillId}`);
    }
  }
  return skills;
}

function listRelativeFiles(rootDir, currentDir = rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files.sort();
}

function isManagedShimCurrent({ sourceDir, targetDir, skillId, version }) {
  const markerPath = path.join(targetDir, VERSION_MARKER_NAME);
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker?.managedBy !== 'uclaw' || marker.id !== skillId || marker.version !== version) {
      return false;
    }
    const sourceFiles = listRelativeFiles(sourceDir);
    const targetFiles = listRelativeFiles(targetDir).filter((file) => file !== VERSION_MARKER_NAME);
    if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) return false;
    return sourceFiles.every((relativePath) => fs.readFileSync(path.join(sourceDir, relativePath))
      .equals(fs.readFileSync(path.join(targetDir, relativePath))));
  } catch {
    return false;
  }
}

function replaceManagedShim({ sourceDir, targetDir, skillId, version }) {
  const parentDir = path.dirname(targetDir);
  const stagingDir = fs.mkdtempSync(path.join(parentDir, `.uclaw-${skillId}-staging-`));
  const backupDir = `${targetDir}.uclaw-backup-${process.pid}-${Date.now()}`;
  let movedExistingTarget = false;
  try {
    fs.cpSync(sourceDir, stagingDir, { recursive: true, dereference: true });
    fs.writeFileSync(path.join(stagingDir, VERSION_MARKER_NAME), `${JSON.stringify({
      schemaVersion: 1,
      managedBy: 'uclaw',
      id: skillId,
      version,
    }, null, 2)}\n`, 'utf8');
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      movedExistingTarget = true;
    }
    fs.renameSync(stagingDir, targetDir);
    if (movedExistingTarget) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(targetDir) && movedExistingTarget && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (fs.existsSync(targetDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

function resolveDevelopmentOpenClawRoot() {
  const openClawLink = path.join(ROOT, 'node_modules', 'openclaw');
  if (!fs.existsSync(openClawLink)) {
    throw new Error(`OpenClaw package not found: ${openClawLink}`);
  }
  return fs.realpathSync(openClawLink);
}

function resolveDevelopmentSkillsRoot() {
  return path.join(resolveDevelopmentOpenClawRoot(), 'skills');
}

/** Synchronize the complete offline shim contract into an OpenClaw skills directory. */
export function synchronizeOpenClawSkillShims({
  skillsRoot = resolveDevelopmentSkillsRoot(),
  shimsRoot = path.join(ROOT, 'resources', 'openclaw-skill-shims'),
  manifestPath = MANIFEST_PATH,
} = {}) {
  fs.mkdirSync(skillsRoot, { recursive: true });
  const installed = [];
  const synchronized = [];
  const unchanged = [];

  for (const manifestEntry of readSkillShimManifest(manifestPath)) {
    const skillId = manifestEntry.id;
    const sourceDir = path.join(shimsRoot, skillId);
    const sourceManifest = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceManifest)) {
      throw new Error(`OpenClaw skill shim is incomplete: ${sourceManifest}`);
    }

    const targetDir = path.join(skillsRoot, skillId);
    if (manifestEntry.installMode === 'managed-sync') {
      if (isManagedShimCurrent({
        sourceDir,
        targetDir,
        skillId,
        version: manifestEntry.version,
      })) {
        unchanged.push(skillId);
      } else {
        replaceManagedShim({
          sourceDir,
          targetDir,
          skillId,
          version: manifestEntry.version,
        });
        synchronized.push(skillId);
      }
      continue;
    }

    if (manifestEntry.installMode !== 'missing-only') {
      throw new Error(`Unsupported OpenClaw skill shim install mode: ${manifestEntry.installMode}`);
    }
    if (fs.existsSync(path.join(targetDir, 'SKILL.md'))) {
      unchanged.push(skillId);
      continue;
    }

    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: false,
    });
    installed.push(skillId);
  }

  return { installed, synchronized, unchanged };
}

/** Install missing compatibility shims while also synchronizing versioned UClaw shims. */
export function installOpenClawSkillShims(options = {}) {
  return synchronizeOpenClawSkillShims(options).installed;
}

function listSkillFiles(rootDir, currentDir = rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listSkillFiles(rootDir, fullPath));
    } else if (stat.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files.sort();
}

/** Fail packaging if any OpenClaw-owned bundled skill is missing or changed. */
export function verifyOpenClawSkillsPreserved({ sourceSkillsRoot, bundledSkillsRoot }) {
  const sourceSkillIds = fs.readdirSync(sourceSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillId) => fs.existsSync(path.join(sourceSkillsRoot, skillId, 'SKILL.md')))
    .sort();

  if (sourceSkillIds.length === 0) {
    throw new Error(`OpenClaw package contains no bundled skills: ${sourceSkillsRoot}`);
  }

  for (const skillId of sourceSkillIds) {
    const sourceDir = path.join(sourceSkillsRoot, skillId);
    const bundledDir = path.join(bundledSkillsRoot, skillId);
    if (!fs.existsSync(path.join(bundledDir, 'SKILL.md'))) {
      throw new Error(`Bundled OpenClaw skill is missing: ${skillId}`);
    }

    for (const relativePath of listSkillFiles(sourceDir)) {
      const sourceFile = path.join(sourceDir, relativePath);
      const bundledFile = path.join(bundledDir, relativePath);
      const displayPath = relativePath.split(path.sep).join('/');
      if (!fs.existsSync(bundledFile)) {
        throw new Error(`Bundled OpenClaw skill file is missing: ${skillId}/${displayPath}`);
      }
      if (!fs.readFileSync(sourceFile).equals(fs.readFileSync(bundledFile))) {
        throw new Error(`Bundled OpenClaw skill file was modified: ${skillId}/${displayPath}`);
      }
    }
  }

  return sourceSkillIds;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const openclawRoot = resolveDevelopmentOpenClawRoot();
  const installed = installOpenClawSkillShims({ skillsRoot: path.join(openclawRoot, 'skills') });
  console.log(installed.length > 0
    ? `Installed OpenClaw skill shims: ${installed.join(', ')}`
    : 'OpenClaw skill shims are already installed');
}
