import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const PORTABLE_FIRST_LAUNCH_REPAIR_SCHEMA = 1;
const REPAIR_MARKER_FILE = '.uclaw-first-launch-repair.json';
const USB_BUILD_IDENTITY_FILE = 'uclaw-usb-build.json';

type JsonRecord = Record<string, unknown>;

type PackagedPluginSpec = {
  id: string;
  manifestId: string;
  packageNames: readonly string[];
  strictLocalMetadata?: boolean;
};

const PACKAGED_PLUGINS: readonly PackagedPluginSpec[] = [
  { id: 'dingtalk', manifestId: 'dingtalk', packageNames: ['@soimy/dingtalk'] },
  { id: 'wecom', manifestId: 'wecom-openclaw-plugin', packageNames: ['@wecom/wecom-openclaw-plugin'] },
  { id: 'feishu-openclaw-plugin', manifestId: 'openclaw-lark', packageNames: ['@larksuite/openclaw-lark'] },
  { id: 'discord', manifestId: 'discord', packageNames: ['@openclaw/discord'] },
  { id: 'qqbot', manifestId: 'qqbot', packageNames: ['@openclaw/qqbot'] },
  { id: 'whatsapp', manifestId: 'whatsapp', packageNames: ['@openclaw/whatsapp'] },
  { id: 'openclaw-weixin', manifestId: 'openclaw-weixin', packageNames: ['@tencent-weixin/openclaw-weixin'] },
  { id: 'parallel', manifestId: 'parallel', packageNames: ['@openclaw/parallel-plugin'] },
  { id: 'clawx-openai-image', manifestId: 'clawx-openai-image', packageNames: ['clawx-openai-image', 'clawx-openai-image-plugin'], strictLocalMetadata: true },
  { id: 'uclaw-artifact-orchestrator', manifestId: 'uclaw-artifact-orchestrator', packageNames: ['uclaw-artifact-orchestrator', 'uclaw-artifact-orchestrator-plugin'], strictLocalMetadata: true },
  { id: 'uclaw-local-artifacts', manifestId: 'uclaw-local-artifacts', packageNames: ['uclaw-local-artifacts', 'uclaw-local-artifacts-plugin'], strictLocalMetadata: true },
  { id: 'uclaw-blender', manifestId: 'uclaw-blender', packageNames: ['uclaw-blender', 'uclaw-blender-plugin'], strictLocalMetadata: true },
  { id: 'uclaw-video', manifestId: 'uclaw-video', packageNames: ['uclaw-video', 'uclaw-video-plugin'], strictLocalMetadata: true },
];

export type PortableFirstLaunchRepairInput = {
  enabled: boolean;
  packaged: boolean;
  platform: string;
  arch: string;
  rootDir: string | null;
  /** Immutable application root; may differ from rootDir in isolated tests. */
  packageRootDir?: string | null;
  resourcesDir: string;
  runtimeProfileDir?: string | null;
  expectedVersion?: string | null;
};

export type PortableFirstLaunchRepairResult = {
  status: 'not-applicable' | 'ready' | 'repaired' | 'already-checked' | 'blocked';
  actions: readonly string[];
  errors: readonly string[];
  markerPath?: string;
};

function readJson(filePath: string): JsonRecord | null {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function isFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isInside(rootDir: string, candidate: string): boolean {
  const relativePath = relative(resolve(rootDir), resolve(candidate));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`));
}

function resolveDeclaredEntry(pluginDir: string, entry: unknown): string | null {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const target = resolve(pluginDir, entry);
  return isInside(pluginDir, target) ? target : null;
}

function resolveDependencyPackagePath(pluginDir: string, dependency: string): string | null {
  const nodeModulesDir = resolve(pluginDir, 'node_modules');
  const dependencyDir = resolve(nodeModulesDir, ...dependency.split('/'));
  return isInside(nodeModulesDir, dependencyDir)
    ? join(dependencyDir, 'package.json')
    : null;
}

function declaredEntries(pkg: JsonRecord, manifest: JsonRecord): string[] {
  return [...new Set([
    manifest.entry,
    pkg.main,
    pkg.module,
    ...(
      pkg.openclaw && typeof pkg.openclaw === 'object' && !Array.isArray(pkg.openclaw)
        && Array.isArray((pkg.openclaw as JsonRecord).runtimeExtensions)
        ? (pkg.openclaw as JsonRecord).runtimeExtensions as unknown[]
        : []
    ),
    ...(
      pkg.openclaw && typeof pkg.openclaw === 'object' && !Array.isArray(pkg.openclaw)
        && Array.isArray((pkg.openclaw as JsonRecord).extensions)
        ? (pkg.openclaw as JsonRecord).extensions as unknown[]
        : []
    ),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))];
}

function declaredDependencies(pkg: JsonRecord): string[] {
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
    ? Object.keys(pkg.dependencies as JsonRecord)
    : [];
  const optionalDependencies = pkg.optionalDependencies
    && typeof pkg.optionalDependencies === 'object'
    && !Array.isArray(pkg.optionalDependencies)
    ? Object.keys(pkg.optionalDependencies as JsonRecord)
    : [];
  return [...new Set([...dependencies, ...optionalDependencies])];
}

function inspectPlugin(resourcesDir: string, spec: PackagedPluginSpec, errors: string[]): void {
  const pluginDir = join(resourcesDir, 'openclaw-plugins', spec.id);
  const packagePath = join(pluginDir, 'package.json');
  const manifestPath = join(pluginDir, 'openclaw.plugin.json');
  const pkg = readJson(packagePath);
  const manifest = readJson(manifestPath);
  if (!pkg) {
    errors.push(`plugin ${spec.id}: package.json missing or invalid`);
    return;
  }
  if (!manifest) {
    errors.push(`plugin ${spec.id}: openclaw.plugin.json missing or invalid`);
    return;
  }
  if (typeof pkg.name !== 'string' || !spec.packageNames.includes(pkg.name)) {
    errors.push(`plugin ${spec.id}: package name mismatch`);
  }
  if (manifest.id !== spec.manifestId) {
    errors.push(`plugin ${spec.id}: manifest id mismatch`);
  }
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    errors.push(`plugin ${spec.id}: package version missing`);
  }
  if (manifest.version !== undefined && manifest.version !== pkg.version) {
    errors.push(`plugin ${spec.id}: package/manifest version mismatch`);
  }
  const entries = declaredEntries(pkg, manifest);
  if (entries.length === 0 || !entries.some((entry) => {
    const target = resolveDeclaredEntry(pluginDir, entry);
    return Boolean(target && isFile(target));
  })) {
    errors.push(`plugin ${spec.id}: declared entrypoint missing`);
  }
  if (spec.strictLocalMetadata) {
    if (typeof manifest.version !== 'string' || manifest.version !== pkg.version) {
      errors.push(`plugin ${spec.id}: local package/manifest version mismatch`);
    }
    if (typeof pkg.main !== 'string' || pkg.main !== manifest.entry) {
      errors.push(`plugin ${spec.id}: local entrypoint mismatch`);
    }
    const openclaw = pkg.openclaw;
    const extensions = openclaw && typeof openclaw === 'object' && !Array.isArray(openclaw)
      ? (openclaw as JsonRecord).extensions
      : undefined;
    if (extensions !== undefined
      && (!Array.isArray(extensions) || !extensions.includes(`./${String(manifest.entry ?? '')}`))) {
      errors.push(`plugin ${spec.id}: OpenClaw entry declaration mismatch`);
    }
  }
  for (const dependency of declaredDependencies(pkg)) {
    const dependencyPath = resolveDependencyPackagePath(pluginDir, dependency);
    if (!dependencyPath || !isFile(dependencyPath)) {
      errors.push(`plugin ${spec.id}: runtime dependency missing: ${dependency}`);
    }
  }
}

function inspectPackage(input: PortableFirstLaunchRepairInput): string[] {
  const errors: string[] = [];
  const { platform, arch, rootDir, resourcesDir, expectedVersion } = input;
  const packageRootDir = input.packageRootDir ?? rootDir;
  if (!packageRootDir || !isDirectory(packageRootDir)) {
    errors.push('portable root is missing or not a directory');
    return errors;
  }
  const requiredFiles: Array<[string, string]> = [
    ['resources/app.asar', join(resourcesDir, 'app.asar')],
    ['resources/openclaw/openclaw.mjs', join(resourcesDir, 'openclaw', 'openclaw.mjs')],
    ['resources/openclaw/package.json', join(resourcesDir, 'openclaw', 'package.json')],
  ];
  if (platform === 'win32') {
    requiredFiles.push(
      ['resources/cli/openclaw.cmd', join(resourcesDir, 'cli', 'openclaw.cmd')],
      ['UClaw.exe', join(packageRootDir, 'UClaw.exe')],
      ['resources/bin/node.exe', join(resourcesDir, 'bin', 'node.exe')],
      ['resources/bin/uv.exe', join(resourcesDir, 'bin', 'uv.exe')],
      ['resources/bin/agent-browser.exe', join(resourcesDir, 'bin', 'agent-browser.exe')],
      ['uclaw-usb-build.json', join(packageRootDir, USB_BUILD_IDENTITY_FILE)],
      ['UClaw-SelfCheck.cmd', join(packageRootDir, 'UClaw-SelfCheck.cmd')],
      ['resources/openclaw/node_modules/sharp/package.json', join(resourcesDir, 'openclaw', 'node_modules', 'sharp', 'package.json')],
      ['resources/openclaw/node_modules/@img/sharp-win32-x64/package.json', join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'package.json')],
      ['resources/openclaw/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node', join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node')],
      ['resources/openclaw/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', join(resourcesDir, 'openclaw', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll')],
      ['resources/app.asar.unpacked/node_modules/sharp/package.json', join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'sharp', 'package.json')],
      ['resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json', join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'package.json')],
      ['resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node', join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node')],
      ['resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll')],
      ['resources/openclaw-plugins/clawx-openai-image/index.mjs', join(resourcesDir, 'openclaw-plugins', 'clawx-openai-image', 'index.mjs')],
      ['resources/openclaw-plugins/uclaw-video/index.mjs', join(resourcesDir, 'openclaw-plugins', 'uclaw-video', 'index.mjs')],
      ['resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json', join(resourcesDir, 'openclaw-plugins', 'clawx-openai-image', 'node_modules', 'undici', 'package.json')],
      ['resources/resources/updater/win32-x64/uclaw-portable-updater.exe', join(resourcesDir, 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater.exe')],
    );
    if (rootDir) {
      requiredFiles.push(['portable.flag', join(rootDir, 'portable.flag')]);
    }
  } else if (platform === 'darwin') {
    requiredFiles.push(
      ['resources/cli/openclaw', join(resourcesDir, 'cli', 'openclaw')],
      ['resources/bin/uv', join(resourcesDir, 'bin', 'uv')],
      ['resources/bin/agent-browser', join(resourcesDir, 'bin', 'agent-browser')],
      [`resources/resources/updater/darwin-${arch}/uclaw-portable-updater`, join(resourcesDir, 'resources', 'updater', `darwin-${arch}`, 'uclaw-portable-updater')],
    );
  }
  if (platform !== 'linux') {
    requiredFiles.push(
      ['resources/resources/blender/runtime/uclaw_scene_runner.py', join(resourcesDir, 'resources', 'blender', 'runtime', 'uclaw_scene_runner.py')],
      ['resources/resources/blender/runtime/scene-spec.schema.json', join(resourcesDir, 'resources', 'blender', 'runtime', 'scene-spec.schema.json')],
    );
  }
  for (const [label, filePath] of requiredFiles) {
    if (!isFile(filePath)) errors.push(`required package file missing: ${label}`);
  }
  if (!readJson(join(resourcesDir, 'openclaw', 'package.json'))) {
    errors.push('OpenClaw package metadata missing or invalid');
  }

  const identityPath = join(resourcesDir, 'uclaw-build.json');
  const identity = readJson(identityPath);
  if (!identity) {
    errors.push('packaged build identity missing or invalid');
  } else {
    if (identity.schemaVersion !== 2 || identity.product !== 'UClaw') {
      errors.push('packaged build identity schema/product mismatch');
    }
    if (expectedVersion && identity.appVersion !== expectedVersion) {
      errors.push(`packaged app version mismatch: ${String(identity.appVersion)}`);
    }
    if (identity.platform !== platform || identity.arch !== arch) {
      errors.push(`packaged target mismatch: ${String(identity.platform)}/${String(identity.arch)}`);
    }
    if (identity.sourceTreeState !== 'clean') errors.push('packaged source identity is not clean');
    for (const field of ['appVersion', 'buildId', 'gitCommit']) {
      if (typeof identity[field] !== 'string' || !String(identity[field]).trim()) {
        errors.push(`packaged build identity field missing: ${field}`);
      }
    }
    if (!/^[0-9a-f]{40}$/iu.test(String(identity.gitCommit ?? ''))) {
      errors.push('packaged build identity gitCommit is invalid');
    }
  }

  if (platform === 'win32') {
    const usbIdentity = readJson(join(packageRootDir, USB_BUILD_IDENTITY_FILE));
    if (!usbIdentity) {
      errors.push('USB build identity missing or invalid');
    } else {
      if (usbIdentity.schemaVersion !== 2
        || usbIdentity.product !== 'UClaw'
        || usbIdentity.packageType !== 'portable_zip'
        || usbIdentity.platform !== 'win32'
        || usbIdentity.arch !== 'x64'
        || usbIdentity.sourceTreeState !== 'clean') {
        errors.push('USB build identity schema/target/package mismatch');
      }
      for (const field of ['appVersion', 'buildId', 'gitCommit', 'appAsarVersion']) {
        if (typeof usbIdentity[field] !== 'string' || !String(usbIdentity[field]).trim()) {
          errors.push(`USB build identity field missing: ${field}`);
        }
      }
      if (!/^[0-9a-f]{40}$/iu.test(String(usbIdentity.gitCommit ?? ''))) {
        errors.push('USB build identity gitCommit is invalid');
      }
      if (identity) {
        for (const field of ['appVersion', 'buildId', 'gitCommit'] as const) {
          if (usbIdentity[field] !== identity[field]) {
            errors.push(`USB/packaged identity mismatch: ${field}`);
          }
        }
      }
      if (usbIdentity.appAsarVersion !== usbIdentity.appVersion) {
        errors.push('USB app.asar version mismatch');
      }
    }
  }

  if (platform === 'win32' && rootDir && !isDirectory(join(rootDir, 'UClawData'))) {
    errors.push('portable data directory missing: UClawData');
  }

  const pluginsRoot = join(resourcesDir, 'openclaw-plugins');
  if (!isDirectory(pluginsRoot)) {
    errors.push('packaged OpenClaw plugins directory missing');
  } else {
    for (const spec of PACKAGED_PLUGINS) inspectPlugin(resourcesDir, spec, errors);
  }
  return errors;
}

function markerPath(input: PortableFirstLaunchRepairInput): string | null {
  if (input.runtimeProfileDir && isDirectory(input.runtimeProfileDir)) {
    return join(input.runtimeProfileDir, REPAIR_MARKER_FILE);
  }
  if (input.rootDir) return join(input.rootDir, REPAIR_MARKER_FILE);
  return null;
}

function writeMarker(filePath: string, input: PortableFirstLaunchRepairInput): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const identity = readJson(join(input.resourcesDir, 'uclaw-build.json')) ?? {};
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({
      schemaVersion: PORTABLE_FIRST_LAUNCH_REPAIR_SCHEMA,
      status: 'ready',
      appVersion: identity.appVersion ?? input.expectedVersion ?? null,
      buildId: identity.buildId ?? null,
      checkedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    try { unlinkSync(temporaryPath); } catch { /* already renamed */ }
  }
}

function markerMatches(filePath: string, input: PortableFirstLaunchRepairInput): boolean {
  const marker = readJson(filePath);
  const identity = readJson(join(input.resourcesDir, 'uclaw-build.json'));
  return marker?.schemaVersion === PORTABLE_FIRST_LAUNCH_REPAIR_SCHEMA
    && marker.status === 'ready'
    && marker.appVersion === identity?.appVersion
    && marker.buildId === identity?.buildId;
}

/**
 * Validate a manually extracted packaged portable root before Gateway startup.
 * The repair is deliberately narrow: directory/runtime/plugin repairs already
 * have their own atomic implementations; this function only admits a package
 * whose immutable payload can be proven complete and records a per-build check.
 */
export function runPortableFirstLaunchRepair(
  input: PortableFirstLaunchRepairInput,
): PortableFirstLaunchRepairResult {
  if (!input.enabled || !input.packaged) {
    return { status: 'not-applicable', actions: [], errors: [] };
  }

  const errors = inspectPackage(input);
  if (errors.length > 0) {
    return { status: 'blocked', actions: [], errors };
  }

  const actions: string[] = [];
  const repairMarkerPath = markerPath(input);
  if (repairMarkerPath && markerMatches(repairMarkerPath, input)) {
    return { status: 'already-checked', actions, errors: [], markerPath: repairMarkerPath };
  }

  if (repairMarkerPath) {
    try {
      mkdirSync(join(repairMarkerPath, '..'), { recursive: true });
      writeMarker(repairMarkerPath, input);
      actions.push('wrote-first-launch-repair-marker');
    } catch {
      // A read-only portable volume can still run from the local runtime cache.
      // Do not turn a marker write failure into a false package failure.
    }
  }
  return {
    status: actions.length > 0 ? 'repaired' : 'ready',
    actions,
    errors: [],
    ...(repairMarkerPath ? { markerPath: repairMarkerPath } : {}),
  };
}
