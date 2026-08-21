// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  countSourceMaps,
  prepareSentrySourceMaps,
} from '../../scripts/prepare-sentry-sourcemaps.mjs';

const require = createRequire(import.meta.url);

type UploadIdentity = {
  appVersion: string;
  buildId: string;
};

type UploadOptions = {
  environment?: NodeJS.ProcessEnv;
  execFileSync?: ReturnType<typeof vi.fn>;
  log?: ReturnType<typeof vi.fn>;
  resolveCli?: () => string;
};

type UploadResult = {
  status: 'skipped' | 'uploaded';
  release?: string;
};

type ChildProcessOptions = {
  cwd: string;
  encoding: string;
  env: Record<string, string>;
  stdio: string[];
  windowsHide: boolean;
};

type ChildProcessCall = [string, string[], ChildProcessOptions];

type AfterPackTestHooks = {
  assertNoPackagedSourceMaps: (
    resourcesDir: string,
    listAsarPackage?: (asarPath: string) => string[],
  ) => void;
  findPackagedSourceMaps: (
    resourcesDir: string,
    listAsarPackage?: (asarPath: string) => string[],
  ) => string[];
  removeSourceMapFiles: (resourcesDir: string) => number;
  uploadSentrySourceMaps: (
    projectDir: string,
    identity: UploadIdentity,
    options?: UploadOptions,
  ) => UploadResult;
};

const afterPack = require('../../scripts/after-pack.cjs') as { __test?: AfterPackTestHooks };
const hooks = afterPack.__test!;

describe('Sentry source map build lifecycle', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'uclaw-sentry-maps-'));
    tempRoots.push(root);
    return root;
  }

  it('keeps hidden map generation, debug-ID injection, and package exclusions connected', () => {
    const projectRoot = resolve(import.meta.dirname, '..', '..');
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const viteConfig = readFileSync(join(projectRoot, 'vite.config.ts'), 'utf8');
    const builderConfig = parseYaml(
      readFileSync(join(projectRoot, 'electron-builder.yml'), 'utf8'),
    ) as { afterPack?: string; files?: string[] };

    expect(packageJson.scripts?.['build:vite']).toContain('prepare-sentry-sourcemaps.mjs');
    expect(viteConfig.match(/sourcemap:\s*'hidden'/gu)).toHaveLength(3);
    expect(builderConfig.afterPack).toBe('./scripts/after-pack.cjs');
    expect(builderConfig.files).toEqual(expect.arrayContaining([
      '!dist/**/*.map',
      '!dist-electron/**/*.map',
      '!**/*.map',
    ]));
  });

  it('injects debug IDs into generated maps without exposing the ambient environment', () => {
    const root = makeTempRoot();
    const rendererDir = join(root, 'dist', 'assets');
    const mainDir = join(root, 'dist-electron', 'main');
    mkdirSync(rendererDir, { recursive: true });
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(join(rendererDir, 'renderer.js.map'), '{}', 'utf8');
    writeFileSync(join(mainDir, 'index.js.MAP'), '{}', 'utf8');
    writeFileSync(join(rendererDir, 'renderer.js'), 'void 0;', 'utf8');

    const execute = vi.fn(() => ({ status: 0 }));
    const log = vi.fn();
    const result = prepareSentrySourceMaps({
      root,
      log,
      resolveCli: () => 'mock-sentry-cli',
      spawnSync: execute,
    });

    expect(result).toEqual({ status: 'injected', sourceMapCount: 2 });
    expect(countSourceMaps(root)).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const [command, args, options] = execute.mock.calls[0] as unknown as ChildProcessCall;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      'mock-sentry-cli',
      'sourcemaps',
      'inject',
      join(root, 'dist'),
      join(root, 'dist-electron'),
    ]);
    expect(options).toMatchObject({
      cwd: root,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(log.mock.calls.flat().join(' ')).not.toContain('token');
  });

  it('fails before resolving the CLI when an expected output has no generated maps', () => {
    const root = makeTempRoot();
    const resolveCli = vi.fn(() => 'must-not-run');
    const execute = vi.fn();

    expect(() => prepareSentrySourceMaps({ root, resolveCli, spawnSync: execute }))
      .toThrow('an expected build output has no source maps');
    expect(resolveCli).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not relay CLI output when local injection fails', () => {
    const root = makeTempRoot();
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'dist-electron'), { recursive: true });
    writeFileSync(join(root, 'dist', 'app.js.map'), '{}', 'utf8');
    writeFileSync(join(root, 'dist-electron', 'main.js.map'), '{}', 'utf8');
    const leakedValue = 'synthetic-secret-never-log';

    expect(() => prepareSentrySourceMaps({
      root,
      resolveCli: () => 'mock-sentry-cli',
      spawnSync: () => ({ status: 7, stderr: leakedValue }),
    })).toThrow('Sentry source map injection failed with exit code 7');
    try {
      prepareSentrySourceMaps({
        root,
        resolveCli: () => 'mock-sentry-cli',
        spawnSync: () => ({ status: 7, stderr: leakedValue }),
      });
    } catch (error) {
      expect(String(error)).not.toContain(leakedValue);
    }
  });

  it('removes loose maps and blocks maps embedded in app.asar', () => {
    const root = makeTempRoot();
    const resourcesDir = join(root, 'resources');
    const nestedDir = join(resourcesDir, 'openclaw', 'node_modules', 'dependency');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'index.js.map'), '{}', 'utf8');
    writeFileSync(join(nestedDir, 'index.js'), 'void 0;', 'utf8');

    expect(hooks.removeSourceMapFiles(resourcesDir)).toBe(1);
    expect(existsSync(join(nestedDir, 'index.js.map'))).toBe(false);
    expect(existsSync(join(nestedDir, 'index.js'))).toBe(true);
    expect(hooks.findPackagedSourceMaps(resourcesDir)).toEqual([]);

    writeFileSync(join(resourcesDir, 'app.asar'), '', 'utf8');
    const listAsarPackage = vi.fn(() => ['/dist/assets/app.js', '/dist/assets/app.js.map']);
    expect(hooks.findPackagedSourceMaps(resourcesDir, listAsarPackage)).toEqual([
      'app.asar:/dist/assets/app.js.map',
    ]);
    expect(() => hooks.assertNoPackagedSourceMaps(resourcesDir, listAsarPackage))
      .toThrow('Source map packaging gate failed (1 file(s))');
  });
});

describe('Sentry source map release upload', () => {
  const identity = {
    appVersion: '2.0.3',
    buildId: 'abcdef123456-ci-42',
  };

  it('safely skips when the release token is absent, even if public settings exist', () => {
    const execute = vi.fn();
    const resolveCli = vi.fn(() => 'must-not-run');
    const log = vi.fn();

    const result = hooks.uploadSentrySourceMaps('C:\\project', identity, {
      environment: {
        SENTRY_URL: 'https://sentry.example.test',
        SENTRY_ORG: 'uclaw',
        SENTRY_PROJECT: 'desktop',
      },
      execFileSync: execute,
      log,
      resolveCli,
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(resolveCli).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[after-pack] Sentry source map upload skipped: release authorization is not configured.',
    );
  });

  it('runs the exact create, upload, and finalize sequence with an isolated environment', () => {
    const projectDir = 'C:\\uclaw-source';
    const token = 'synthetic-release-token';
    const dsn = 'https://public:synthetic-private@sentry.example.test/42';
    const execute = vi.fn(() => '');
    const log = vi.fn();

    const result = hooks.uploadSentrySourceMaps(projectDir, identity, {
      environment: {
        PATH: 'C:\\Windows\\System32',
        SENTRY_AUTH_TOKEN: token,
        SENTRY_DSN: dsn,
        SENTRY_ORG: 'uclaw-org',
        SENTRY_PROJECT: 'uclaw-desktop',
        SENTRY_URL: 'https://sentry.example.test/root',
        UNRELATED_SECRET: 'must-not-reach-child',
      },
      execFileSync: execute,
      log,
      resolveCli: () => 'mock-sentry-cli',
    });

    const release = `uclaw@${identity.appVersion}+${identity.buildId}`;
    expect(result).toEqual({ status: 'uploaded', release });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(
      (call) => (call as unknown as ChildProcessCall)[1],
    )).toEqual([
      ['mock-sentry-cli', 'releases', 'new', release],
      [
        'mock-sentry-cli',
        'sourcemaps',
        'upload',
        '--release', release,
        '--strict',
        '--validate',
        join(projectDir, 'dist'),
        join(projectDir, 'dist-electron'),
      ],
      ['mock-sentry-cli', 'releases', 'finalize', release],
    ]);

    for (const call of execute.mock.calls) {
      const [command, , options] = call as unknown as ChildProcessCall;
      expect(command).toBe(process.execPath);
      expect(options).toMatchObject({
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      expect(options.env).toMatchObject({
        PATH: 'C:\\Windows\\System32',
        SENTRY_AUTH_TOKEN: token,
        SENTRY_LOG_LEVEL: 'error',
        SENTRY_ORG: 'uclaw-org',
        SENTRY_PROJECT: 'uclaw-desktop',
        SENTRY_RELEASE: release,
        SENTRY_URL: 'https://sentry.example.test/root',
      });
      expect(options.env).not.toHaveProperty('SENTRY_DSN');
      expect(options.env).not.toHaveProperty('UNRELATED_SECRET');
    }
    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toContain(token);
    expect(output).not.toContain(dsn);
  });

  it('rejects unsafe release endpoints without echoing their credentials', () => {
    const embeddedCredential = 'synthetic-url-password';
    const environment = {
      SENTRY_AUTH_TOKEN: 'synthetic-release-token',
      SENTRY_ORG: 'uclaw',
      SENTRY_PROJECT: 'desktop',
      SENTRY_URL: `https://public:${embeddedCredential}@sentry.example.test/root`,
    };

    try {
      hooks.uploadSentrySourceMaps('C:\\project', identity, { environment });
      throw new Error('expected upload configuration to be rejected');
    } catch (error) {
      expect(String(error)).toContain('must not contain credentials');
      expect(String(error)).not.toContain(embeddedCredential);
    }
  });

  it('does not relay CLI stderr or credentials when upload fails', () => {
    const token = 'synthetic-release-token';
    const dsn = 'https://public@sentry.example.test/42';
    const environment = {
      SENTRY_AUTH_TOKEN: token,
      SENTRY_DSN: dsn,
      SENTRY_ORG: 'uclaw',
      SENTRY_PROJECT: 'desktop',
      SENTRY_URL: 'https://sentry.example.test',
    };
    const failure = Object.assign(new Error(`upstream rejected ${token} ${dsn}`), {
      status: 9,
      stderr: `${token} ${dsn}`,
    });

    try {
      hooks.uploadSentrySourceMaps('C:\\project', identity, {
        environment,
        execFileSync: vi.fn(() => { throw failure; }),
        resolveCli: () => 'mock-sentry-cli',
      });
      throw new Error('expected upload to fail');
    } catch (error) {
      expect(String(error)).toBe(
        'Error: [after-pack] Sentry source map release creation failed (exit code 9).',
      );
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(dsn);
    }
  });
});
