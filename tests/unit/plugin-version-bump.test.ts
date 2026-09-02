// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkPluginVersionBumps,
  comparePluginVersions,
  parsePluginVersion,
  runPluginVersionCheck,
} from '../../scripts/check-plugin-version-bumps.mjs';

const ROOT = 'resources/openclaw-plugins';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function writePluginSnapshot(root: string, {
  id = 'uclaw-video',
  version = '0.1.0',
  source = 'export default {}',
}: { id?: string; version?: string; source?: string } = {}) {
  const pluginDir = join(root, ROOT, id);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: `${id}-plugin`,
    version,
    main: 'index.mjs',
  }));
  writeFileSync(join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({
    id,
    version,
    entry: 'index.mjs',
    configSchema: {},
  }));
  writeFileSync(join(pluginDir, 'index.mjs'), `${source}\n`);
}

function createPluginHistory() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-plugin-version-guard-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'uclaw-tests@example.invalid');
  git(root, 'config', 'user.name', 'UClaw Tests');
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  writePluginSnapshot(root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'introduce plugin');
  return { root, base };
}

function createVersionEpochHistory() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-plugin-version-epoch-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'uclaw-tests@example.invalid');
  git(root, 'config', 'user.name', 'UClaw Tests');
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  writePluginSnapshot(root, {
    id: 'clawx-openai-image',
    version: '0.1.3',
    source: 'export default { baseline: true };',
  });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline plugin release');
  const base = git(root, 'rev-parse', 'HEAD');

  // An unrelated release bump establishes the 0.1.11 content epoch.
  writeFileSync(
    join(root, ROOT, 'clawx-openai-image', 'package.json'),
    JSON.stringify({ name: 'clawx-openai-image-plugin', version: '0.1.11', main: 'index.mjs' }),
  );
  writeFileSync(
    join(root, ROOT, 'clawx-openai-image', 'openclaw.plugin.json'),
    JSON.stringify({ id: 'clawx-openai-image', version: '0.1.11', entry: 'index.mjs', configSchema: {} }),
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'release metadata bump');

  // This is the historical failure: schema changes after the bump while the
  // plugin remains at 0.1.11. A net base/head comparison sees a version bump
  // and would incorrectly allow it without the epoch check.
  writeFileSync(
    join(root, ROOT, 'clawx-openai-image', 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'clawx-openai-image',
      version: '0.1.11',
      entry: 'index.mjs',
      configSchema: { properties: { defaultModel: { type: 'string' } } },
    }),
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'schema change without bump');
  const head = git(root, 'rev-parse', 'HEAD');
  return { root, base, head };
}

function snapshots({
  id = 'uclaw-video',
  version = '0.1.0',
  manifestVersion = version,
  schema = '{}',
  source = 'export default {};',
} = {}) {
  const packagePath = `${ROOT}/${id}/package.json`;
  const manifestPath = `${ROOT}/${id}/openclaw.plugin.json`;
  return new Map([
    [packagePath, JSON.stringify({
      name: `${id}-plugin`,
      version,
      main: 'index.mjs',
    })],
    [manifestPath, JSON.stringify({
      id,
      version: manifestVersion,
      entry: 'index.mjs',
      configSchema: JSON.parse(schema),
    })],
    [`${ROOT}/${id}/index.mjs`, source],
  ]);
}

function check({
  before = snapshots(),
  after = snapshots(),
  changedFiles = [`${ROOT}/uclaw-video/index.mjs`],
} = {}) {
  return checkPluginVersionBumps({
    changedFiles,
    beforeSnapshots: before,
    afterSnapshots: after,
  });
}

describe('plugin version/content guard', () => {
  it('is wired into pull-request CI with the base commit available', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/check.yml'), 'utf8');
    const releaseWorkflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/uclaw-portable-production.yml'),
      'utf8',
    );
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['check:plugin-versions']).toBe(
      'node scripts/check-plugin-version-bumps.mjs',
    );
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('PLUGIN_VERSION_BASE: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('pnpm run check:plugin-versions');
    expect(releaseWorkflow).toContain('PLUGIN_VERSION_BASE="$(git merge-base HEAD origin/main)"');
    expect(releaseWorkflow).toContain('node scripts/check-plugin-version-bumps.mjs --head HEAD');
  });

  it('requires a bump when plugin source changes', () => {
    const result = check({
      after: snapshots({ source: 'export default { changed: true };' }),
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      pluginId: 'uclaw-video',
      code: 'content-without-version-bump',
    });
  });

  it('requires a bump when the manifest schema changes', () => {
    const result = check({
      changedFiles: [`${ROOT}/uclaw-video/openclaw.plugin.json`],
      after: snapshots({ schema: '{"properties":{"enabled":{"type":"boolean"}}}' }),
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0].code).toBe('content-without-version-bump');
  });

  it('requires a bump when package runtime dependencies change', () => {
    const after = snapshots();
    const packagePath = `${ROOT}/uclaw-video/package.json`;
    after.set(packagePath, JSON.stringify({
      name: 'uclaw-video-plugin',
      version: '0.1.0',
      main: 'index.mjs',
      dependencies: { undici: '8.1.0' },
    }));
    const guarded = check({
      changedFiles: [packagePath],
      after,
    });

    expect(guarded.ok).toBe(false);
    expect(guarded.violations[0]).toMatchObject({
      pluginId: 'uclaw-video',
      code: 'content-without-version-bump',
    });
  });

  it('requires a bump when an auxiliary runtime file is added', () => {
    const before = snapshots();
    const after = new Map(before);
    const helperPath = `${ROOT}/uclaw-video/lib/request-helper.mjs`;
    after.set(helperPath, 'export function request() {}\n');

    const result = check({
      before,
      after,
      changedFiles: [helperPath],
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      pluginId: 'uclaw-video',
      code: 'content-without-version-bump',
    });
  });

  it('requires a bump when an auxiliary runtime file is removed', () => {
    const before = snapshots();
    const helperPath = `${ROOT}/uclaw-video/lib/request-helper.mjs`;
    before.set(helperPath, 'export function request() {}\n');
    const after = snapshots();

    const result = check({
      before,
      after,
      changedFiles: [helperPath],
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      pluginId: 'uclaw-video',
      code: 'content-without-version-bump',
    });
  });

  it('accepts a strictly newer package and manifest version for content changes', () => {
    const result = check({
      after: snapshots({
        version: '0.2.0',
        schema: '{"properties":{"enabled":{"type":"boolean"}}}',
        source: 'export default { changed: true };',
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.checked[0]).toMatchObject({
      pluginId: 'uclaw-video',
      contentChanged: true,
      versionChanged: true,
    });
  });

  it('accepts a version-only metadata bump without treating it as content change', () => {
    const before = snapshots();
    const after = snapshots({ version: '0.1.1' });
    const result = check({
      before,
      after,
      changedFiles: [
        `${ROOT}/uclaw-video/package.json`,
        `${ROOT}/uclaw-video/openclaw.plugin.json`,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checked[0].contentChanged).toBe(false);
    expect(result.checked[0].versionChanged).toBe(true);
  });

  it('ignores JSON formatting and key-order-only edits', () => {
    const before = snapshots();
    const packagePath = `${ROOT}/uclaw-video/package.json`;
    const manifestPath = `${ROOT}/uclaw-video/openclaw.plugin.json`;
    const after = new Map(before);
    after.set(packagePath, '{\n  "main": "index.mjs",\n  "version": "0.1.0",\n  "name": "uclaw-video-plugin"\n}\n');
    after.set(manifestPath, '{"entry":"index.mjs","configSchema":{},"version":"0.1.0","id":"uclaw-video"}');
    const result = check({
      before,
      after,
      changedFiles: [packagePath, manifestPath],
    });

    expect(result.ok).toBe(true);
    expect(result.checked[0].contentChanged).toBe(false);
  });

  it('allows a newly introduced plugin after validating metadata', () => {
    const after = snapshots({ id: 'uclaw-new', version: '1.0.0' });
    const result = check({
      before: new Map(),
      after,
      changedFiles: [
        `${ROOT}/uclaw-new/package.json`,
        `${ROOT}/uclaw-new/openclaw.plugin.json`,
        `${ROOT}/uclaw-new/index.mjs`,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checked[0]).toMatchObject({ pluginId: 'uclaw-new', added: true });
  });

  it('rejects a source-only plugin addition without package metadata', () => {
    const pluginPath = `${ROOT}/uclaw-new/index.mjs`;
    const result = check({
      before: new Map(),
      after: new Map([[pluginPath, 'export default {};\n']]),
      changedFiles: [pluginPath],
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      pluginId: 'uclaw-new',
      code: 'metadata-missing',
    });
  });

  it('allows a deliberately removed plugin when its baseline metadata exists', () => {
    const before = snapshots({ id: 'uclaw-old' });
    const result = check({
      before,
      after: new Map(),
      changedFiles: [
        `${ROOT}/uclaw-old/package.json`,
        `${ROOT}/uclaw-old/openclaw.plugin.json`,
        `${ROOT}/uclaw-old/index.mjs`,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toHaveLength(0);
  });

  it('rejects a version decrease and package/manifest mismatch', () => {
    const lower = check({ after: snapshots({ version: '0.0.9', source: 'changed' }) });
    expect(lower.ok).toBe(false);
    // A same-version content change is checked before ordering; use a changed
    // version to exercise the strict ordering branch.
    const mismatch = check({ after: snapshots({ version: '0.2.0', manifestVersion: '0.2.1' }) });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.violations[0].code).toBe('version-mismatch');
  });

  it('compares ordinary and prerelease semantic versions', () => {
    expect(parsePluginVersion('0.2.0')).not.toBeNull();
    expect(comparePluginVersions('0.2.0', '0.1.9')).toBe(1);
    expect(comparePluginVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBe(-1);
    expect(comparePluginVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(comparePluginVersions('not-semver', '1.0.0')).toBeNull();
  });

  it('checks content changes after a plugin is introduced beyond the base ref', () => {
    const history = createPluginHistory();
    try {
      const pluginPath = join(history.root, ROOT, 'uclaw-video', 'index.mjs');
      writeFileSync(pluginPath, 'export default { changed: true };\n');
      git(history.root, 'add', '.');
      git(history.root, 'commit', '-qm', 'change plugin without bump');
      const head = git(history.root, 'rev-parse', 'HEAD');

      const result = runPluginVersionCheck({
        root: history.root,
        base: history.base,
        head,
      });

      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatchObject({
        pluginId: 'uclaw-video',
        code: 'content-without-version-bump',
      });
    } finally {
      rmSync(history.root, { recursive: true, force: true });
    }
  });

  it('checks untracked content changes after a plugin is introduced beyond the base ref', () => {
    const history = createPluginHistory();
    try {
      // The plugin already has a complete metadata baseline in Git. Add only
      // an untracked auxiliary module in the current worktree; this must not
      // be mistaken for a newly introduced plugin or silently skipped by the
      // historical-baseline fallback.
      const helperDir = join(history.root, ROOT, 'uclaw-video', 'lib');
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(join(helperDir, 'request-helper.mjs'), 'export function request() {}\n');

      const result = runPluginVersionCheck({
        root: history.root,
        base: history.base,
        head: 'HEAD',
      });

      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatchObject({
        pluginId: 'uclaw-video',
        code: 'content-without-version-bump',
      });
      expect(result.violations[0].files).toContain(
        `${ROOT}/uclaw-video/lib/request-helper.mjs`,
      );
    } finally {
      rmSync(history.root, { recursive: true, force: true });
    }
  });

  it('accepts a version bump for post-introduction plugin content changes', () => {
    const history = createPluginHistory();
    try {
      writePluginSnapshot(history.root, {
        version: '0.2.0',
        source: 'export default { changed: true };',
      });
      git(history.root, 'add', '.');
      git(history.root, 'commit', '-qm', 'change plugin with bump');
      const head = git(history.root, 'rev-parse', 'HEAD');

      const result = runPluginVersionCheck({
        root: history.root,
        base: history.base,
        head,
      });

      expect(result.ok).toBe(true);
      expect(result.checked[0]).toMatchObject({
        pluginId: 'uclaw-video',
        contentChanged: true,
        versionChanged: true,
        added: false,
      });
    } finally {
      rmSync(history.root, { recursive: true, force: true });
    }
  });

  it('rejects content changed after an earlier version bump in the same range', () => {
    const history = createVersionEpochHistory();
    try {
      const result = runPluginVersionCheck({
        root: history.root,
        base: history.base,
        head: history.head,
      });

      expect(result.ok).toBe(false);
      expect(result.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'clawx-openai-image',
          code: 'content-without-version-bump',
        }),
      ]));
    } finally {
      rmSync(history.root, { recursive: true, force: true });
    }
  });

  it('rejects an untracked content edit after a committed version bump', () => {
    const history = createPluginHistory();
    try {
      // First establish a committed 0.2.0 epoch.
      writePluginSnapshot(history.root, {
        version: '0.2.0',
        source: 'export default { bumped: true };',
      });
      git(history.root, 'add', '.');
      git(history.root, 'commit', '-qm', 'release metadata and source bump');

      // Then add a helper without changing either version-bearing file. The
      // local HEAD mode must inspect the real working-tree metadata when it
      // flushes the history epoch; a synthetic Git ref would hide this edit.
      const helperDir = join(history.root, ROOT, 'uclaw-video', 'lib');
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(join(helperDir, 'request-helper.mjs'), 'export function request() {}\n');

      const result = runPluginVersionCheck({
        root: history.root,
        base: history.base,
        head: 'HEAD',
      });

      expect(result.ok).toBe(false);
      expect(result.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'uclaw-video',
          code: 'content-without-version-bump',
        }),
      ]));
    } finally {
      rmSync(history.root, { recursive: true, force: true });
    }
  });

});
