// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('openclaw bundle config', () => {
  it('includes Electron runtime-only packages needed in packaged builds', async () => {
    const {
      ELECTRON_MAIN_RUNTIME_PACKAGES,
      EXTRA_BUNDLED_PACKAGES,
      BUNDLED_OPENCLAW_PLUGINS,
      LOCAL_OPENCLAW_PLUGIN_IDS,
      OPENCLAW_SKILL_SHIM_ALLOWLIST,
      VERSIONED_OPENCLAW_SKILL_SHIMS,
    } = await import('../../scripts/openclaw-bundle-config.mjs');

    expect(ELECTRON_MAIN_RUNTIME_PACKAGES).toEqual([
      '@whiskeysockets/baileys',
      'qrcode-terminal',
    ]);
    expect(EXTRA_BUNDLED_PACKAGES).toEqual(expect.arrayContaining([
      '@whiskeysockets/baileys',
      '@larksuiteoapi/node-sdk',
      '@grammyjs/runner',
      '@grammyjs/transformer-throttler',
      'grammy',
      '@buape/carbon',
      '@discordjs/voice',
      'discord-api-types',
      'opusscript',
      '@tencent-connect/qqbot-connector',
      'mpg123-decoder',
      'silk-wasm',
      'acpx',
      'playwright-core',
      'qrcode-terminal',
    ]));
    expect(LOCAL_OPENCLAW_PLUGIN_IDS).toEqual([
      'clawx-openai-image',
      'uclaw-artifact-orchestrator',
      'uclaw-local-artifacts',
      'uclaw-blender',
      'uclaw-video',
    ]);
    expect(BUNDLED_OPENCLAW_PLUGINS).toContainEqual({
      npmName: '@openclaw/parallel-plugin',
      pluginId: 'parallel',
      manifestId: 'parallel',
    });
    expect(OPENCLAW_SKILL_SHIM_ALLOWLIST).toEqual([
      'presentation-maker',
      'spreadsheet-maker',
      'document-maker',
      'blender-maker',
      'cad-editor',
      'ecommerce-main-image',
    ]);
    expect(VERSIONED_OPENCLAW_SKILL_SHIMS).toEqual({
      'cad-editor': 'v1',
      'ecommerce-main-image': 'v1',
    });
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.devDependencies?.acpx ?? packageJson.dependencies?.acpx).toBe('0.5.3');
    expect(packageJson.devDependencies?.['@openclaw/parallel-plugin']).toBe('2026.6.10');
  });

  it('keeps externalized Electron main packages in production dependencies', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      jszip: '^3.10.1',
      ms: '2.1.3',
      pptxgenjs: '4.0.1',
      sharp: '^0.34.5',
      undici: '8.1.0',
    });
    expect(packageJson.devDependencies).not.toHaveProperty('jszip');
    expect(packageJson.devDependencies).not.toHaveProperty('sharp');
    expect(packageJson.devDependencies).not.toHaveProperty('undici');
  });

  it('unpacks the complete sharp runtime used by Electron main', () => {
    const builderConfig = parse(
      readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8'),
    ) as { asarUnpack?: string[] };

    expect(builderConfig.asarUnpack).toEqual(expect.arrayContaining([
      '**/node_modules/sharp/**',
      '**/node_modules/@img/sharp-*/**',
    ]));
  });

  it('preserves bundled OpenClaw skills without packaging retired UClaw skill copies', () => {
    const builderConfig = parse(
      readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8'),
    ) as { extraResources?: Array<Record<string, unknown>> };
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const bundleSource = readFileSync(
      resolve(process.cwd(), 'scripts/bundle-openclaw.mjs'),
      'utf8',
    );
    expect(JSON.stringify(builderConfig.extraResources)).not.toContain('preinstalled-skills');
    expect(JSON.stringify(packageJson.scripts)).not.toContain('preinstalled-skills');
    expect(bundleSource).not.toContain('trimBundledOpenClawSkills');
    expect(bundleSource).toContain('verifyOpenClawSkillsPreserved');
  });

  it('keeps the offline skill manifest aligned with the bundle allowlist', async () => {
    const { OPENCLAW_SKILL_SHIM_ALLOWLIST, VERSIONED_OPENCLAW_SKILL_SHIMS } = await import(
      '../../scripts/openclaw-bundle-config.mjs'
    );
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), 'resources/skills/preinstalled-manifest.json'),
      'utf8',
    )) as {
      schemaVersion: number;
      skills: Array<{ id: string; version?: string; installMode: string }>;
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.skills.map((skill) => skill.id)).toEqual(OPENCLAW_SKILL_SHIM_ALLOWLIST);
    expect(Object.fromEntries(
      manifest.skills
        .filter((skill) => skill.installMode === 'managed-sync')
        .map((skill) => [skill.id, skill.version]),
    )).toEqual(VERSIONED_OPENCLAW_SKILL_SHIMS);
  });

  it('declares every managed video request timeout in the plugin config schema', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-video/openclaw.plugin.json'),
      'utf8',
    )) as {
      configSchema?: { properties?: Record<string, unknown> };
    };

    expect(manifest.configSchema?.properties).toMatchObject({
      requestTimeoutMs: { type: 'integer', minimum: 1 },
      contentDownloadAttemptTimeoutMs: { type: 'integer', minimum: 1 },
      contentDownloadMaxAttempts: { type: 'integer', minimum: 1 },
    });
  });

  it('keeps every local plugin package and manifest version synchronized', async () => {
    const { LOCAL_OPENCLAW_PLUGIN_IDS } = await import('../../scripts/openclaw-bundle-config.mjs');
    for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
      const packageJson = JSON.parse(readFileSync(
        resolve(process.cwd(), `resources/openclaw-plugins/${pluginId}/package.json`),
        'utf8',
      )) as { version?: string };
      const manifest = JSON.parse(readFileSync(
        resolve(process.cwd(), `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`),
        'utf8',
      )) as { version?: string };
      expect(packageJson.version, `${pluginId} package.json version`).toBeTruthy();
      expect(manifest.version, `${pluginId} manifest version`).toBe(packageJson.version);
    }

    // Both provider schemas gained new configuration properties in
    // 1013338e; they must not regress to their pre-schema 0.1.x versions.
    for (const pluginId of ['uclaw-video', 'clawx-openai-image']) {
      const packageJson = JSON.parse(readFileSync(
        resolve(process.cwd(), `resources/openclaw-plugins/${pluginId}/package.json`),
        'utf8',
      )) as { version?: string };
      expect(packageJson.version).toBe('0.2.0');
    }
  });

  it('writes the build identity schema required by the USB self-check', () => {
    const afterPackSource = readFileSync(
      resolve(process.cwd(), 'scripts/after-pack.cjs'),
      'utf8',
    );
    const selfCheckSource = readFileSync(
      resolve(process.cwd(), 'scripts/windows-support/UClaw-SelfCheck.mjs'),
      'utf8',
    );
    const writtenSchema = Number(afterPackSource.match(/schemaVersion:\s*(\d+)/u)?.[1]);
    const requiredSchema = Number(
      selfCheckSource.match(/usbIdentity\.schemaVersion !== (\d+)/u)?.[1],
    );

    expect(writtenSchema).toBe(2);
    expect(writtenSchema).toBe(requiredSchema);
  });

  it('requires every local plugin in the Windows USB self-check', async () => {
    const selfCheckSource = readFileSync(
      resolve(process.cwd(), 'scripts/windows-support/UClaw-SelfCheck.mjs'),
      'utf8',
    );

    expect(selfCheckSource).toContain(
      "{ pluginId: 'parallel', manifestId: 'parallel', packageNames: ['@openclaw/parallel-plugin'] }",
    );
    const { LOCAL_OPENCLAW_PLUGIN_IDS } = await import('../../scripts/openclaw-bundle-config.mjs');
    for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
      // Keep the standalone self-check payload in lockstep with the bundle
      // allowlist. It cannot import the source config at runtime because the
      // payload is copied into a user's USB root as a single .cmd artifact.
      expect(selfCheckSource).toContain(`'${pluginId}'`);
    }
  });

  it('keeps the self-check aligned with the typed Host API and announcement route', () => {
    const selfCheckSource = readFileSync(
      resolve(process.cwd(), 'scripts/windows-support/UClaw-SelfCheck.mjs'),
      'utf8',
    );

    expect(selfCheckSource).not.toContain('13210');
    expect(selfCheckSource).toContain('/api/clawx/client-config');
    expect(selfCheckSource).toContain("credentials: 'omit'");
  });
});
