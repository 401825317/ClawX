import path from 'node:path';

const PLUGIN_INSTALL_WORK_DIR_NAME = '.uclaw-plugin-install';
const LEGACY_TRANSIENT_DIR_PATTERN = /^\..+\.uclaw-(?:staging|backup)-[^/\\]+$/i;

export interface PluginInstallWorkPaths {
  workRoot: string;
  stagingDir: string;
  backupDir: string;
}

export function isTransientPluginInstallPath(pluginPath: string): boolean {
  const segments = pluginPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment) => (
    segment === PLUGIN_INSTALL_WORK_DIR_NAME
    || LEGACY_TRANSIENT_DIR_PATTERN.test(segment)
  ));
}

export function resolvePluginInstallWorkRoot(extensionsRoot: string): string {
  return path.join(path.dirname(extensionsRoot), PLUGIN_INSTALL_WORK_DIR_NAME);
}

export function resolvePluginInstallWorkPaths(
  targetDir: string,
  nonce: string,
): PluginInstallWorkPaths {
  const extensionsRoot = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const workRoot = resolvePluginInstallWorkRoot(extensionsRoot);

  return {
    workRoot,
    stagingDir: path.join(workRoot, `${targetName}.staging-${nonce}`),
    backupDir: path.join(workRoot, `${targetName}.backup-${nonce}`),
  };
}
