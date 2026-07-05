import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fsp from 'node:fs/promises';
import JSZip from 'jszip';

async function loadExtensionForHome(homeDir: string) {
  vi.resetModules();
  const paths = await import('@electron/utils/paths');
  vi.spyOn(paths, 'getOpenClawConfigDir').mockReturnValue(join(homeDir, '.openclaw'));
  const mod = await import('@electron/extensions/builtin/skillhub-marketplace');
  return mod.createSkillHubMarketplaceExtension();
}

async function loadSkillHubModuleForHome(homeDir: string) {
  vi.resetModules();
  const paths = await import('@electron/utils/paths');
  vi.spyOn(paths, 'getOpenClawConfigDir').mockReturnValue(join(homeDir, '.openclaw'));
  return await import('@electron/extensions/builtin/skillhub-marketplace');
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function skillZipResponse(): Promise<Response> {
  const zip = new JSZip();
  zip.file('SKILL.md', '---\nname: SkillHub Demo\n---\nDemo skill\n');
  zip.file('references/readme.md', 'hello');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': 'application/zip' },
  });
}

describe('SkillHub marketplace extension', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('searches SkillHub and maps Chinese marketplace metadata', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-skillhub-home-'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/skills?page=1&pageSize=1')) {
        return jsonResponse({ code: 0, data: { skills: [], total: 70412 }, message: 'success' });
      }
      if (url.includes('/api/skills?')) {
        return jsonResponse({
          code: 0,
          data: {
            total: 477,
            skills: [
              {
                slug: 'xiaohongshu-crawler-redfox',
                name: '小红书作品爬取',
                description: 'crawler',
                description_zh: '小红书作品爬取工具',
                version: '1.0.0',
                ownerName: 'user_e942ebfc',
                source: 'community',
                downloads: 205,
                stars: 1,
                category: 'data-analysis',
                subCategories: [{ key: 'data-web-scraping', name: '网页抓取' }],
              },
            ],
          },
          message: 'success',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const extension = await loadExtensionForHome(homeDir);
    const result = await extension.search({ query: '小红书', locale: 'zh', limit: 20 });

    expect(result).toMatchObject({
      total: 477,
      catalogTotal: 70412,
      source: 'skillhub',
      results: [
        {
          slug: 'xiaohongshu-crawler-redfox',
          name: '小红书作品爬取',
          description: '小红书作品爬取工具',
          provider: 'skillhub',
          source: 'community',
          author: 'user_e942ebfc',
          downloads: 205,
          stars: 1,
        },
      ],
    });
  });

  it('downloads and installs a SkillHub zip into the OpenClaw skills directory', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-skillhub-home-'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/skills/demo-skill')) {
        return jsonResponse({
          latestVersion: { version: '1.0.0' },
          owner: { displayName: 'SkillHub Author' },
          skill: {
            slug: 'demo-skill',
            displayName: 'SkillHub Demo',
            summary_zh: 'SkillHub demo desc',
            source: 'community',
            sourceUrl: 'https://skillhub.cn/skills/demo-skill',
            stats: { downloads: 3, stars: 2 },
          },
        });
      }
      if (url.includes('/api/v1/download?slug=demo-skill')) {
        return await skillZipResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const extension = await loadExtensionForHome(homeDir);
    await extension.install({ slug: 'demo-skill', version: '1.0.0', provider: 'skillhub' });

    const skillDir = join(homeDir, '.openclaw', 'skills', 'demo-skill');
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'readme.md'))).toBe(true);
    const origin = JSON.parse(readFileSync(join(skillDir, '.clawhub', 'origin.json'), 'utf-8'));
    expect(origin).toMatchObject({
      provider: 'skillhub',
      slug: 'demo-skill',
      installedVersion: '1.0.0',
      registry: 'https://api.skillhub.cn',
      source: 'community',
      sourceUrl: 'https://skillhub.cn/skills/demo-skill',
      displayName: 'SkillHub Demo',
      displayDescription: 'SkillHub demo desc',
    });
  });

  it('falls back to copy when Windows blocks the final rename', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-skillhub-home-'));
    const originalRename = fsp.rename;
    const renameMock = vi.fn(async (oldPath: Parameters<typeof fsp.rename>[0], newPath: Parameters<typeof fsp.rename>[1]) => {
      if (String(oldPath).includes('.demo-skill-skillhub-') && String(newPath).endsWith(join('skills', 'demo-skill'))) {
        const error = new Error('EPERM: operation not permitted, rename');
        (error as NodeJS.ErrnoException).code = 'EPERM';
        throw error;
      }
      return await originalRename(oldPath, newPath);
    });
    const skillHub = await loadSkillHubModuleForHome(homeDir);
    skillHub.__setSkillHubFsForTests({ ...fsp, rename: renameMock });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/skills/demo-skill')) {
        return jsonResponse({
          latestVersion: { version: '1.0.0' },
          skill: {
            slug: 'demo-skill',
            displayName: 'SkillHub Demo',
            summary_zh: 'SkillHub demo desc',
            source: 'community',
          },
        });
      }
      if (url.includes('/api/v1/download?slug=demo-skill')) {
        return await skillZipResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const extension = skillHub.createSkillHubMarketplaceExtension();
      await extension.install({ slug: 'demo-skill', version: '1.0.0', provider: 'skillhub' });

      const skillDir = join(homeDir, '.openclaw', 'skills', 'demo-skill');
      expect(renameMock).toHaveBeenCalled();
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'references', 'readme.md'))).toBe(true);
      const origin = JSON.parse(readFileSync(join(skillDir, '.clawhub', 'origin.json'), 'utf-8'));
      expect(origin).toMatchObject({
        provider: 'skillhub',
        slug: 'demo-skill',
        installedVersion: '1.0.0',
      });
    } finally {
      skillHub.__setSkillHubFsForTests(null);
    }
  });

  it('retries copy fallback when Windows temporarily blocks scanning extracted references', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'clawx-skillhub-home-'));
    const originalRename = fsp.rename;
    const originalCp = fsp.cp;
    const renameMock = vi.fn(async (oldPath: Parameters<typeof fsp.rename>[0], newPath: Parameters<typeof fsp.rename>[1]) => {
      if (String(oldPath).includes('.demo-skill-skillhub-') && String(newPath).endsWith(join('skills', 'demo-skill'))) {
        const error = new Error('EPERM: operation not permitted, rename');
        (error as NodeJS.ErrnoException).code = 'EPERM';
        throw error;
      }
      return await originalRename(oldPath, newPath);
    });
    const cpMock = vi.fn(async (source: Parameters<typeof fsp.cp>[0], destination: Parameters<typeof fsp.cp>[1], options?: Parameters<typeof fsp.cp>[2]) => {
      if (cpMock.mock.calls.length === 1) {
        const error = new Error(`EPERM: operation not permitted, scandir '${join(String(source), 'references')}'`);
        (error as NodeJS.ErrnoException).code = 'EPERM';
        (error as NodeJS.ErrnoException).syscall = 'scandir';
        (error as NodeJS.ErrnoException).path = join(String(source), 'references');
        throw error;
      }
      return await originalCp(source, destination, options);
    });
    const skillHub = await loadSkillHubModuleForHome(homeDir);
    skillHub.__setSkillHubFsForTests({ ...fsp, rename: renameMock, cp: cpMock });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/skills/demo-skill')) {
        return jsonResponse({
          latestVersion: { version: '1.0.0' },
          skill: {
            slug: 'demo-skill',
            displayName: 'SkillHub Demo',
            summary_zh: 'SkillHub demo desc',
            source: 'community',
          },
        });
      }
      if (url.includes('/api/v1/download?slug=demo-skill')) {
        return await skillZipResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const extension = skillHub.createSkillHubMarketplaceExtension();
      await extension.install({ slug: 'demo-skill', version: '1.0.0', provider: 'skillhub' });

      const skillDir = join(homeDir, '.openclaw', 'skills', 'demo-skill');
      expect(renameMock).toHaveBeenCalled();
      expect(cpMock).toHaveBeenCalledTimes(2);
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'references', 'readme.md'))).toBe(true);
    } finally {
      skillHub.__setSkillHubFsForTests(null);
    }
  });
});
