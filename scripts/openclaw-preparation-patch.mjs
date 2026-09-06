import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.6.10';
const RUNTIME_SOURCE = '\tif (runtime === "openclaw") return;';
const RUNTIME_TARGET = '\tif (runtime === "openclaw" || runtime === "pi") return;';
const BUNDLE_SOURCE = [
  '\tconst registry = params.manifestRegistry ?? loadPluginManifestRegistryForPluginRegistry({',
  '\t\tworkspaceDir: params.workspaceDir,',
  '\t\tconfig: params.cfg,',
  '\t\tincludeDisabled: true',
  '\t});',
].join('\n');
const BUNDLE_TARGET = [
  '\tconst registry = params.manifestRegistry ?? (() => {',
  '\t\tconst registryParams = { workspaceDir: params.workspaceDir, config: params.cfg, includeDisabled: true };',
  '\t\tconst index = loadPluginRegistrySnapshot(registryParams);',
  '\t\t// The installed index already distinguishes bundle formats; retain normal registry validation.',
  '\t\tconst pluginIds = [...new Set(index.plugins.filter((plugin) => plugin.format === "bundle").map((plugin) => plugin.pluginId))];',
  '\t\treturn loadPluginManifestRegistryForPluginRegistry({ ...registryParams, pluginIds });',
  '\t})();',
].join('\n');

function replaceExactlyOnce(content, source, target, label) {
  const before = content.split(source).length - 1;
  const after = content.split(target).length - 1;
  if (before === 0 && after === 1) return { content, changed: false };
  if (before !== 1 || after !== 0) throw new Error(`Unsupported ${label} layout (${before}/${after})`);
  return { content: content.replace(source, target), changed: true };
}

export function rewriteNativeRuntimeAlias(content) {
  if (!content.includes('function resolveCliRuntimeExecutionProvider(params)')) {
    throw new Error('Missing CLI runtime execution selector');
  }
  return replaceExactlyOnce(content, RUNTIME_SOURCE, RUNTIME_TARGET, 'native runtime alias');
}

export function rewriteBundleManifestScope(content) {
  const imports = [...content.matchAll(/import \{ n as loadPluginManifestRegistryForPluginRegistry \} from "(\.\/plugin-registry-[^"\n]+\.js)";/gu)];
  const patchedImports = [...content.matchAll(/import \{ n as loadPluginManifestRegistryForPluginRegistry, p as loadPluginRegistrySnapshot \} from "(\.\/plugin-registry-[^"\n]+\.js)";/gu)];
  const rewritten = replaceExactlyOnce(content, BUNDLE_SOURCE, BUNDLE_TARGET, 'bundle manifest scope');
  if (rewritten.changed) {
    if (imports.length !== 1 || patchedImports.length !== 0) throw new Error('Unsupported bundle registry import');
    return {
      changed: true,
      content: rewritten.content.replace(imports[0][0], `import { n as loadPluginManifestRegistryForPluginRegistry, p as loadPluginRegistrySnapshot } from "${imports[0][1]}";`),
    };
  }
  if (imports.length !== 0 || patchedImports.length !== 1) throw new Error('Partial bundle manifest scope patch');
  return rewritten;
}

export async function patchOpenClawPreparationRuntime(openclawDir) {
  const pkg = JSON.parse(await readFile(path.join(openclawDir, 'package.json'), 'utf8'));
  if (pkg.version !== VERSION) throw new Error(`Expected OpenClaw ${VERSION}, found ${pkg.version}`);
  const dist = path.join(openclawDir, 'dist');
  const entries = await readdir(dist);
  const edits = [];
  for (const [prefix, rewrite] of [
    ['model-runtime-aliases-', rewriteNativeRuntimeAlias],
    ['bundle-mcp-', rewriteBundleManifestScope],
  ]) {
    const candidates = entries.filter((name) => name.startsWith(prefix) && name.endsWith('.js'));
    // Config merging and Codex transport adapters are separate from the bundle loader.
    const names = candidates.filter((name) => !/^bundle-mcp-(?:config|codex)-/u.test(name));
    if (names.length !== 1) throw new Error(`Expected one ${prefix} chunk, found ${names.length}`);
    const file = path.join(dist, names[0]);
    edits.push({ file, ...rewrite(await readFile(file, 'utf8')) });
  }
  // Validate every target before changing any file.
  for (const edit of edits) if (edit.changed) await writeFile(edit.file, edit.content);
  return { filesPatched: edits.filter((edit) => edit.changed).length, filesScanned: edits.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await patchOpenClawPreparationRuntime(path.resolve(process.argv[2] ?? 'node_modules/openclaw'))));
}
