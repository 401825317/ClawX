/**
 * Portable workspace compatibility migration.
 *
 * Portable releases keep the durable OpenClaw configuration on removable
 * media while the active state (including the default workspace) is restored
 * into a machine-local profile.  Older releases persisted a physical absolute
 * workspace path in openclaw.json.  This module rewrites only paths that can
 * be proven to be ClawX's default workspace; user-selected workspaces remain
 * untouched.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';
import {
  collapseOpenClawWorkspacePath,
  expandOpenClawPath,
  resolveOpenClawConfigPath,
  resolveOpenClawStateDir,
} from './paths';
import { withConfigLock } from './config-mutex';

type JsonRecord = Record<string, unknown>;

export type PortableWorkspaceMigrationOptions = {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  stateDir?: string;
  /** Test/embedding override; production uses the portable environment flags. */
  portable?: boolean;
};

export type PortableWorkspaceMigrationResult = {
  changed: boolean;
  backupPath?: string;
  migratedFields: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPortableEnvironment(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CLAWX_PORTABLE?.trim().toLowerCase();
  return flag === '1'
    || flag === 'true'
    || flag === 'yes'
    || flag === 'on'
    || Boolean(env.CLAWX_PORTABLE_ID?.trim())
    || env.CLAWX_PORTABLE_RUNTIME_STATE?.trim() === 'local';
}

function canonicalLogicalPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
}

/** Normalize separators without asking the host OS to parse a foreign path. */
function portablePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/u, '');
}

function defaultWorkspaceRelativePath(value: string): string | undefined {
  const normalized = portablePath(value);
  const root = portablePath(DEFAULT_WORKSPACE_CWD);
  const compared = normalized.toLocaleLowerCase('en-US');
  const comparedRoot = root.toLocaleLowerCase('en-US');
  if (compared !== comparedRoot && !compared.startsWith(`${comparedRoot}/`)) return undefined;

  const relative = normalized.slice(root.length).replace(/^\/+/, '');
  if (!relative) return '';
  const segments = relative.split('/');
  // Do not turn a traversal-looking config value into a local path.
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  return segments.join('/');
}

/**
 * Return the relative child below the managed default workspace. Physical
 * paths are first collapsed through the shared resolver, which knows the
 * legacy USB and current local-runtime layouts.
 */
function resolveDefaultWorkspaceRelativePath(
  value: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const direct = defaultWorkspaceRelativePath(value);
  if (direct !== undefined) return direct;
  return defaultWorkspaceRelativePath(collapseOpenClawWorkspacePath(value, stateDir, env));
}

function localDefaultWorkspacePath(stateDir: string, relativePath: string): string {
  const root = path.resolve(stateDir, 'workspace');
  return relativePath ? path.resolve(root, ...relativePath.split('/')) : root;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value.trim());
}

/** Identify an exact ClawX-managed secondary-agent workspace path. */
function isExactManagedAgentWorkspacePath(
  value: unknown,
  agentId: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!validAgentId(agentId) || typeof value !== 'string' || !value.trim()) return false;
  const normalizedId = agentId.trim();
  const logicalAlias = `~/.openclaw/workspace-${normalizedId}`;
  if (canonicalLogicalPath(value) === canonicalLogicalPath(logicalAlias)) return true;

  const runtimeWorkspace = path.join(stateDir, `workspace-${normalizedId}`);
  if (sameFilesystemPath(value, runtimeWorkspace)) return true;

  // A legacy config may contain the USB-expanded form instead of the logical
  // alias. Match only the known portable suffix; `path.resolve` cannot parse
  // a Windows path while tests (or recovery) run on a POSIX host.
  const normalized = portablePath(value).toLocaleLowerCase('en-US');
  const escapedId = normalizedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacyUsb = new RegExp(
    `(?:^|/)uclawdata/openclaw-home/\\.openclaw/workspace-${escapedId}$`,
    'iu',
  );
  if (legacyUsb.test(normalized)) return true;

  const portableId = env.CLAWX_PORTABLE_ID?.trim();
  if (portableId) {
    const escapedPortableId = portableId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacyRuntime = new RegExp(
      `(?:^|/)uclawruntime/profiles/${escapedPortableId}/openclaw-state/workspace-${escapedId}$`,
      'iu',
    );
    if (legacyRuntime.test(normalized)) return true;
  }

  // Keep the current effective-home check for paths that are already on the
  // active machine and therefore can be compared by the host path module.
  const expanded = expandOpenClawPath(value, env);
  const openClawManagedWorkspace = path.join(
    env.OPENCLAW_HOME?.trim() || '',
    '.openclaw',
    `workspace-${normalizedId}`,
  );
  return Boolean(env.OPENCLAW_HOME?.trim()) && sameFilesystemPath(expanded, openClawManagedWorkspace);
}

function setLocalDefaultWorkspace(
  owner: JsonRecord,
  fieldName: string,
  value: unknown,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  removeExactRoot: boolean,
): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const relative = resolveDefaultWorkspaceRelativePath(value, stateDir, env);
  if (relative === undefined) return false;
  if (!relative && removeExactRoot) {
    return removeWorkspaceField(owner, fieldName);
  }

  const next = localDefaultWorkspacePath(stateDir, relative);
  if (next === value) return false;
  owner[fieldName] = next;
  return true;
}

function removeWorkspaceField(owner: JsonRecord, fieldName: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(owner, fieldName)) return false;
  delete owner[fieldName];
  return true;
}

function migrationBackupPath(configPath: string): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.workspace-migration-${stamp}-${process.pid}-${randomUUID()}.bak`,
  );
}

async function writeConfigAtomically(
  configPath: string,
  originalContent: string,
  config: JsonRecord,
): Promise<string> {
  const backupPath = migrationBackupPath(configPath);
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.workspace-migration-${process.pid}-${randomUUID()}.tmp`,
  );

  // The backup is published before the replacement.  If either write or the
  // final rename fails, the original config remains the active file.
  await writeFile(backupPath, originalContent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(config, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await rename(temporaryPath, configPath);
    return backupPath;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/**
 * Rewrite legacy physical default-workspace paths before Gateway startup.
 * Missing or malformed configs are left alone so OpenClaw's normal bootstrap
 * can handle them; a required replacement failure is allowed to abort launch
 * rather than starting with a known-invalid workspace.
 */
export async function migratePortableDefaultWorkspaceConfig(
  options: PortableWorkspaceMigrationOptions = {},
): Promise<PortableWorkspaceMigrationResult> {
  const env = options.env ?? process.env;
  if (options.portable !== true && !isPortableEnvironment(env)) {
    return { changed: false, migratedFields: 0 };
  }

  const configPath = options.configPath ?? resolveOpenClawConfigPath(env);
  const stateDir = options.stateDir ?? resolveOpenClawStateDir(env);

  return withConfigLock(async () => {
    let originalContent: string;
    try {
      originalContent = await readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { changed: false, migratedFields: 0 };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(originalContent);
    } catch {
      // Preserve malformed user data exactly; the existing config sanitizer
      // will report the parse failure through its normal diagnostics.
      return { changed: false, migratedFields: 0 };
    }
    if (!isRecord(parsed)) return { changed: false, migratedFields: 0 };

    const config = parsed;
    const agents = isRecord(config.agents) ? config.agents : undefined;
    let migratedFields = 0;

    const defaults = agents && isRecord(agents.defaults) ? agents.defaults : undefined;
    if (defaults && setLocalDefaultWorkspace(
      defaults,
      'workspace',
      defaults.workspace,
      stateDir,
      env,
      true,
    )) migratedFields += 1;

    // Agent entries can carry either a duplicate default workspace or the
    // legacy `workspace-<id>` managed alias.  Remove only exact managed roots;
    // descendants are retained by relocating them to the active local state.
    const entries = agents?.list;
    if (Array.isArray(entries)) {
      const firstEntryId = entries.find((entry) => isRecord(entry) && typeof entry.id === 'string') as JsonRecord | undefined;
      const firstId = typeof firstEntryId?.id === 'string' ? firstEntryId.id.trim().toLowerCase() : '';
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const agentId = typeof entry.id === 'string' ? entry.id.trim() : '';
        const isDefaultEntry = entry.default === true
          || agentId.toLowerCase() === 'main'
          || (Boolean(firstId) && agentId.toLowerCase() === firstId);

        if (setLocalDefaultWorkspace(
          entry,
          'workspace',
          entry.workspace,
          stateDir,
          env,
          isDefaultEntry,
        )) {
          migratedFields += 1;
          continue;
        }

        if (!agentId || !isExactManagedAgentWorkspacePath(entry.workspace, agentId, stateDir, env)) {
          continue;
        }

        if (isDefaultEntry) {
          // A default agent with the secondary alias is unusual but valid;
          // keep its identity while moving it off the removable volume.
          const next = path.resolve(stateDir, `workspace-${agentId}`);
          if (entry.workspace !== next) {
            entry.workspace = next;
            migratedFields += 1;
          }
        } else if (removeWorkspaceField(entry, 'workspace')) {
          migratedFields += 1;
        }
      }
    }

    if (migratedFields === 0) return { changed: false, migratedFields: 0 };
    const backupPath = await writeConfigAtomically(configPath, originalContent, config);
    return { changed: true, backupPath, migratedFields };
  });
}
