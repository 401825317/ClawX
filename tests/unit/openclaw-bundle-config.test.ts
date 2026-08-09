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
      'uclaw-local-artifacts',
      'uclaw-blender',
      'uclaw-video',
    ]);
    expect(BUNDLED_OPENCLAW_PLUGINS).toContainEqual({
      npmName: '@openclaw/parallel-plugin',
      pluginId: 'parallel',
      manifestId: 'parallel',
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

  it('requires the Parallel plugin in the Windows USB self-check', () => {
    const selfCheckSource = readFileSync(
      resolve(process.cwd(), 'scripts/windows-support/UClaw-SelfCheck.mjs'),
      'utf8',
    );

    expect(selfCheckSource).toContain(
      "{ pluginId: 'parallel', manifestId: 'parallel', packageNames: ['@openclaw/parallel-plugin'] }",
    );
  });
});
