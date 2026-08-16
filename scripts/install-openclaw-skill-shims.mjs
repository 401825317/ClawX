#!/usr/bin/env node

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

/** Install missing compatibility skills without replacing an OpenClaw-owned implementation. */
export function installOpenClawSkillShims({
  skillsRoot = resolveDevelopmentSkillsRoot(),
  shimsRoot = path.join(ROOT, 'resources', 'openclaw-skill-shims'),
} = {}) {
  fs.mkdirSync(skillsRoot, { recursive: true });
  const installed = [];

  for (const skillId of OPENCLAW_SKILL_SHIM_IDS) {
    const sourceDir = path.join(shimsRoot, skillId);
    const sourceManifest = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceManifest)) {
      throw new Error(`OpenClaw skill shim is incomplete: ${sourceManifest}`);
    }

    const targetDir = path.join(skillsRoot, skillId);
    if (fs.existsSync(path.join(targetDir, 'SKILL.md'))) continue;

    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: false,
    });
    installed.push(skillId);
  }

  return installed;
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
      if (!fs.existsSync(bundledFile)) {
        throw new Error(`Bundled OpenClaw skill file is missing: ${skillId}/${relativePath}`);
      }
      if (!fs.readFileSync(sourceFile).equals(fs.readFileSync(bundledFile))) {
        throw new Error(`Bundled OpenClaw skill file was modified: ${skillId}/${relativePath}`);
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
