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

function resolveDevelopmentSkillsRoot() {
  const openClawLink = path.join(ROOT, 'node_modules', 'openclaw');
  if (!fs.existsSync(openClawLink)) {
    throw new Error(`OpenClaw package not found: ${openClawLink}`);
  }
  return path.join(fs.realpathSync(openClawLink), 'skills');
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const installed = installOpenClawSkillShims();
  console.log(installed.length > 0
    ? `Installed OpenClaw skill shims: ${installed.join(', ')}`
    : 'OpenClaw skill shims are already installed');
}
