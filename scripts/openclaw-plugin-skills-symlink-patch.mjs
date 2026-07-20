import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_NAME = 'openclaw-plugin-skills-copy-patch';
const PATCH_MARKER = 'UCLAW_PLUGIN_SKILLS_COPY_V3';
const LEGACY_PATCH_MARKER = 'UCLAW_PLUGIN_SKILLS_COPY_V2';
const RUNTIME_SIGNATURE = 'function publishPluginSkills(skillDirs, opts) {';
const PUBLISH_BLOCK_PATTERN = /function publishPluginSkills\(skillDirs, opts\) \{[\s\S]*?\n\}\nfunction isNotFoundError\(err\) \{/u;
const PATCHED_BLOCK_PATTERN = /function isUclawManagedPluginSkillManifest\(value, expectedName\) \{[\s\S]*?\nfunction isNotFoundError\(err\) \{/u;
const NO_WORKSPACE_PUBLISH_ANCHOR = [
  '\tif (!workspaceDir) {',
  '\t\tpublishPluginSkills([], { pluginSkillsDir: params.pluginSkillsDir });',
].join('\n');
const NO_WORKSPACE_PUBLISH_PATCH = [
  '\tif (!workspaceDir) {',
  '\t\tpublishPluginSkills([], { pluginSkillsDir: params.pluginSkillsDir, reconcile: false });',
].join('\n');

const COPY_RUNTIME = `function isUclawManagedPluginSkillManifest(value, expectedName) {
\treturn Boolean(value && typeof value === "object" && (value.schema === "uclaw.plugin-skill-copy/v1" || value.schema === "uclaw.plugin-skill-copy/v2") && value.name === expectedName);
}
function readUclawManagedPluginSkillManifest(entryPath) {
\ttry {
\t\tconst manifestPath = path.join(entryPath, ".uclaw-skill-manifest.json");
\t\tif (!fs.existsSync(manifestPath)) return null;
\t\tconst parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
\t\treturn isUclawManagedPluginSkillManifest(parsed, path.basename(entryPath)) ? parsed : null;
\t} catch {
\t\treturn null;
\t}
}
function isUclawManagedPluginSkillEntry(entryPath) {
\ttry {
\t\tconst entry = fs.lstatSync(entryPath);
\t\tif (entry.isSymbolicLink()) return true;
\t\treturn entry.isDirectory() && Boolean(readUclawManagedPluginSkillManifest(entryPath));
\t} catch (err) {
\t\treturn false;
\t}
}
function removeGeneratedPluginSkillEntry(entryPath) {
\tif (!isUclawManagedPluginSkillEntry(entryPath)) return false;
\ttry {
\t\tconst entry = fs.lstatSync(entryPath);
\t\tif (entry.isSymbolicLink()) fs.unlinkSync(entryPath);
\t\telse fs.rmSync(entryPath, { recursive: true, force: true });
\t\treturn true;
\t} catch {
\t\treturn false;
\t}
}
function computePluginSkillTreeFingerprint(rootDir) {
\tconst parts = [];
\tconst walk = (currentDir, relativeDir) => {
\t\tconst entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
\t\tfor (const entry of entries) {
\t\t\tif (entry.isSymbolicLink()) continue;
\t\t\tconst relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
\t\t\tconst normalizedPath = relativePath.split(path.sep).join("/");
\t\t\tconst sourcePath = path.join(currentDir, entry.name);
\t\t\tif (entry.isDirectory()) {
\t\t\t\tparts.push(\`d:\${normalizedPath}\`);
\t\t\t\twalk(sourcePath, relativePath);
\t\t\t} else if (entry.isFile()) {
\t\t\t\tconst stat = fs.statSync(sourcePath);
\t\t\t\tparts.push(\`f:\${normalizedPath}:\${stat.size}:\${Math.trunc(stat.mtimeMs)}\`);
\t\t\t}
\t\t}
\t};
\twalk(rootDir, "");
\tlet hash = 2166136261;
\tconst value = parts.join("\\n");
\tfor (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
\treturn \`\${parts.length}-\${(hash >>> 0).toString(16)}\`;
}
function copyPluginSkillTree(sourceDir, targetDir) {
\tfs.mkdirSync(targetDir, { recursive: true });
\tfor (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
\t\tconst sourcePath = path.join(sourceDir, entry.name);
\t\tconst targetPath = path.join(targetDir, entry.name);
\t\tif (entry.isSymbolicLink()) continue;
\t\tif (entry.isDirectory()) copyPluginSkillTree(sourcePath, targetPath);
\t\telse if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
\t}
}
function syncPluginSkillTree(sourceDir, targetDir, opts) {
\tfs.mkdirSync(targetDir, { recursive: true });
\tconst sourceEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
\tconst sourceNames = new Set(sourceEntries.filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name));
\tconst deferredManifest = opts?.deferOwnershipManifest === true ? sourceEntries.find((entry) => entry.name === ".uclaw-skill-manifest.json" && entry.isFile()) : null;
\tfor (const entry of sourceEntries) {
\t\tif (entry.isSymbolicLink() || entry === deferredManifest) continue;
\t\tconst sourcePath = path.join(sourceDir, entry.name);
\t\tconst targetPath = path.join(targetDir, entry.name);
\t\tconst targetEntry = (() => { try { return fs.lstatSync(targetPath); } catch (err) { return null; } })();
\t\tif (entry.isDirectory()) {
\t\t\tif (targetEntry && (targetEntry.isSymbolicLink() || !targetEntry.isDirectory())) fs.rmSync(targetPath, { recursive: true, force: true });
\t\t\tsyncPluginSkillTree(sourcePath, targetPath);
\t\t} else if (entry.isFile()) {
\t\t\tif (targetEntry && (targetEntry.isSymbolicLink() || !targetEntry.isFile())) fs.rmSync(targetPath, { recursive: true, force: true });
\t\t\tfs.copyFileSync(sourcePath, targetPath);
\t\t}
\t}
\tfor (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
\t\tif (sourceNames.has(entry.name)) continue;
\t\tfs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
\t}
\tif (deferredManifest) fs.copyFileSync(path.join(sourceDir, deferredManifest.name), path.join(targetDir, deferredManifest.name));
}
function publishPluginSkillCopy(name, target, pluginSkillsDir) {
\tconst entryPath = path.join(pluginSkillsDir, name);
\tconst existing = (() => { try { return fs.lstatSync(entryPath); } catch (err) { return null; } })();
\tconst existingManifest = existing ? readUclawManagedPluginSkillManifest(entryPath) : null;
\tif (existing && !isUclawManagedPluginSkillEntry(entryPath)) {
\t\tlog.warn(\`plugin skill entry is a user-owned directory or file; preserving it: \${entryPath}\`);
\t\treturn false;
\t}
\tconst stagePath = path.join(pluginSkillsDir, \`.uclaw-skill-\${name}-\${process.pid}-\${Date.now()}-stage\`);
\ttry {
\t\tconst sourceFingerprint = computePluginSkillTreeFingerprint(target);
\t\tif (existingManifest?.schema === "uclaw.plugin-skill-copy/v2" && existingManifest.sourcePath === target && existingManifest.sourceFingerprint === sourceFingerprint) return true;
\t\tcopyPluginSkillTree(target, stagePath);
\t\tfs.writeFileSync(path.join(stagePath, ".uclaw-skill-manifest.json"), JSON.stringify({
\t\t\tschema: "uclaw.plugin-skill-copy/v2",
\t\t\tname,
\t\t\tsourcePath: target,
\t\t\tsourceFingerprint,
\t\t\tupdatedAt: new Date().toISOString()
\t\t}, null, 2) + "\\n", "utf8");
\t\tif (!existing) fs.renameSync(stagePath, entryPath);
\t\telse if (existing.isSymbolicLink()) {
\t\t\tfs.unlinkSync(entryPath);
\t\t\tfs.renameSync(stagePath, entryPath);
\t\t} else {
\t\t\tsyncPluginSkillTree(stagePath, entryPath, { deferOwnershipManifest: true });
\t\t\tfs.rmSync(stagePath, { recursive: true, force: true });
\t\t}
\t\treturn true;
\t} catch (err) {
\t\ttry { fs.rmSync(stagePath, { recursive: true, force: true }); } catch (cleanupErr) {}
\t\tlog.warn(\`failed to publish plugin skill copy "\${entryPath}" <- "\${target}": \${String(err)}\`);
\t\treturn false;
\t}
}
/** Publishes managed skill copies. Only entries carrying the UClaw manifest may be removed. */
function publishPluginSkills(skillDirs, opts) {
\tconst pluginSkillsDir = opts?.pluginSkillsDir ?? resolveDefaultPluginSkillsDir();
\tconst managedTargets = /* @__PURE__ */ new Map();
\tfor (const dir of skillDirs) collectSkillTargets(dir, managedTargets);
\ttry { fs.mkdirSync(pluginSkillsDir, { recursive: true }); } catch (err) {
\t\tlog.warn(\`failed to create plugin skills directory "\${pluginSkillsDir}": \${String(err)}\`);
\t\treturn;
\t}
\tfor (const [name, target] of managedTargets) publishPluginSkillCopy(name, target, pluginSkillsDir);
\tif (opts?.reconcile === false) return;
\tlet existingEntries;
\ttry { existingEntries = fs.readdirSync(pluginSkillsDir, { withFileTypes: true }); } catch (err) { return; }
\tfor (const entry of existingEntries) {
\t\tif (entry.name.startsWith(".uclaw-skill-")) continue;
\t\tconst entryPath = path.join(pluginSkillsDir, entry.name);
\t\tif (!managedTargets.has(entry.name) && isUclawManagedPluginSkillEntry(entryPath)) removeGeneratedPluginSkillEntry(entryPath);
\t}
}
function isNotFoundError(err) {`;

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

export function patchOpenClawPluginSkillsSymlinkContent(content, filePath = '<fixture>') {
  if (!content.includes(RUNTIME_SIGNATURE)) return { content, changed: false, matched: false };
  if (content.includes(PATCH_MARKER)) return { content, changed: false, matched: true };

  let next = content;
  if (PATCHED_BLOCK_PATTERN.test(next)) {
    next = next.replace(PATCHED_BLOCK_PATTERN, COPY_RUNTIME);
  } else if (PUBLISH_BLOCK_PATTERN.test(next)) {
    next = next.replace(PUBLISH_BLOCK_PATTERN, COPY_RUNTIME);
  } else {
    throw new Error(`[${PATCH_NAME}] Expected the complete plugin skill publisher in ${filePath}.`);
  }

  if (!next.includes(NO_WORKSPACE_PUBLISH_PATCH)) {
    const noWorkspaceCount = countOccurrences(next, NO_WORKSPACE_PUBLISH_ANCHOR);
    if (noWorkspaceCount !== 1) {
      throw new Error(
        `[${PATCH_NAME}] Expected one no-workspace publisher anchor in ${filePath}; found ${noWorkspaceCount}.`,
      );
    }
    next = next.replace(NO_WORKSPACE_PUBLISH_ANCHOR, NO_WORKSPACE_PUBLISH_PATCH);
  }

  next = next.replace(`\n/* ${LEGACY_PATCH_MARKER} */`, '');
  return {
    content: `${next}\n/* ${PATCH_MARKER} */`,
    changed: true,
    matched: true,
  };
}

export function patchOpenClawPluginSkillsSymlinkRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  const dryRun = options.dryRun === true;
  if (!existsSync(distDir)) throw new Error(`[${PATCH_NAME}] OpenClaw dist directory not found: ${distDir}`);

  const targets = [];
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filePath = join(distDir, entry.name);
    const result = patchOpenClawPluginSkillsSymlinkContent(readFileSync(filePath, 'utf8'), filePath);
    if (result.matched) targets.push({ file: entry.name, filePath, result });
  }
  if (targets.length !== 1) throw new Error(`[${PATCH_NAME}] Expected exactly one plugin skill runtime file; found ${targets.length}.`);

  const target = targets[0];
  if (target.result.changed && !dryRun) writeFileSync(target.filePath, target.result.content, 'utf8');
  logger.log?.(`[${PATCH_NAME}] ${target.result.changed ? (dryRun ? 'Dry-run matched' : 'Patched') : 'Already patched'}: ${target.file}`);
  return {
    patchedFiles: target.result.changed ? 1 : 0,
    alreadyPatchedFiles: target.result.changed ? 0 : 1,
    file: target.filePath,
  };
}

export function patchInstalledOpenClawPluginSkillsSymlinkRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawPluginSkillsSymlinkRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
