import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-plugin-skills-symlink-patch';
const PATCH_MARKER = 'UCLAW_PLUGIN_SKILLS_SYMLINK_RETRY_V1';
const RUNTIME_SIGNATURE = 'function publishPluginSkills(skillDirs, opts) {';

const SYMLINK_CREATE_PATTERN = /\t\ttry \{\n\t\t\tfs\.symlinkSync\(target, linkPath, resolvePluginSkillLinkType\(\)\);\n\t\t\} catch \(err\) \{\n\t\t\tlog\.warn\(`failed to create plugin skill symlink "\$\{linkPath\}"[\s\S]*?\$\{String\(err\)\}`\);\n\t\t\}/u;

const SYMLINK_CREATE_PATCH = `\t\ttry {
\t\t\tfs.symlinkSync(target, linkPath, resolvePluginSkillLinkType());
\t\t} catch (err) {
\t\t\tlet finalErr = err; // ${PATCH_MARKER}
\t\t\tconst code = err && typeof err === "object" ? err.code : void 0;
\t\t\tif (process.platform === "win32" && (code === "EISDIR" || code === "EEXIST" || code === "EPERM")) {
\t\t\t\tremoveGeneratedPluginSkillEntry(linkPath);
\t\t\t\ttry {
\t\t\t\t\tfs.symlinkSync(target, linkPath, resolvePluginSkillLinkType());
\t\t\t\t\tcontinue;
\t\t\t\t} catch (retryErr) {
\t\t\t\t\tfinalErr = retryErr;
\t\t\t\t}
\t\t\t}
\t\t\tlog.warn(\`failed to create plugin skill symlink "\${linkPath}" -> "\${target}": \${String(finalErr)}\`);
\t\t}`;

function countPatternMatches(content, pattern) {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('u') ? 'gu' : 'g');
  return [...content.matchAll(globalPattern)].length;
}

export function patchOpenClawPluginSkillsSymlinkContent(content, filePath = '<fixture>') {
  if (!content.includes(RUNTIME_SIGNATURE)) {
    return { content, changed: false, matched: false };
  }
  if (content.includes(PATCH_MARKER)) {
    return { content, changed: false, matched: true };
  }

  const matches = countPatternMatches(content, SYMLINK_CREATE_PATTERN);
  if (matches !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one plugin skill symlink creation anchor in ${filePath}; found ${matches}.`);
  }

  return {
    content: content.replace(SYMLINK_CREATE_PATTERN, SYMLINK_CREATE_PATCH),
    changed: true,
    matched: true,
  };
}

export function patchOpenClawPluginSkillsSymlinkRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) {
    throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);
  }

  const targets = [];
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const result = patchOpenClawPluginSkillsSymlinkContent(readFileSync(filePath, 'utf8'), filePath);
    if (result.matched) targets.push({ file: entry.name, filePath, result });
  }

  if (targets.length !== 1) {
    throw new Error(`[${PATCH_NAME}] Expected exactly one plugin skill symlink runtime file; found ${targets.length}.`);
  }

  for (const target of targets) {
    if (target.result.changed && !dryRun) {
      writeFileSync(target.filePath, target.result.content, 'utf8');
    }
    logger.log?.(
      `[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`,
    );
  }

  return {
    patchedFiles: targets.filter(({ result }) => result.changed).length,
    alreadyPatchedFiles: targets.filter(({ result }) => !result.changed).length,
    file: targets[0].filePath,
  };
}

export function patchInstalledOpenClawPluginSkillsSymlinkRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawPluginSkillsSymlinkRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
