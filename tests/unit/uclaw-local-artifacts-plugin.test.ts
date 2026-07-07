import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

async function loadPlugin() {
  return import(
    `${join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-local-artifacts', 'index.mjs')}?t=${Date.now()}-${Math.random()}`
  );
}

function toolByName(tools: Array<{ name: string }>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`tool missing: ${name}`);
  return tool as typeof tool & {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: { cwd: string },
    ) => Promise<{ details?: Record<string, unknown>; content: Array<{ type: string; text: string }> }>;
  };
}

describe('uclaw-local-artifacts plugin', () => {
  it('registers stable local artifact tools', async () => {
    const plugin = await loadPlugin();
    const tools = plugin.__test.createTools() as Array<{ name: string }>;

    expect(tools.map((tool) => tool.name)).toEqual([
      'create_pptx_file',
      'create_docx_file',
      'create_xlsx_file',
      'create_text_file',
      'create_html_app_file',
    ]);
  });

  it('creates verifiable PPTX, DOCX, XLSX, text, and HTML artifacts', async () => {
    const plugin = await loadPlugin();
    const tools = plugin.__test.createTools() as Array<{ name: string }>;
    const cwd = mkdtempSync(join(tmpdir(), 'uclaw-local-artifacts-'));

    const ppt = await toolByName(tools, 'create_pptx_file').execute('ppt', {
      title: '城市口袋绿洲',
      subtitle: '组合任务示例',
      slides: [
        { title: '概念', bullets: ['城市街角微绿洲', '低维护植物', '太阳能长椅'] },
        { title: '价值', bullets: ['提升停留体验', '增强社区记忆点'] },
      ],
    }, undefined, undefined, { cwd });
    const pptPath = String(ppt.details?.filePath);
    expect(existsSync(pptPath)).toBe(true);
    const pptZip = await JSZip.loadAsync(readFileSync(pptPath));
    expect(pptZip.file('ppt/presentation.xml')).toBeTruthy();
    expect(pptZip.file('ppt/slides/slide1.xml')).toBeTruthy();
    expect(pptZip.file('ppt/slides/slide3.xml')).toBeTruthy();

    const doc = await toolByName(tools, 'create_docx_file').execute('doc', {
      title: '城市口袋绿洲说明',
      paragraphs: ['这是一个用于验证本地产物插件的 DOCX。'],
    }, undefined, undefined, { cwd });
    const docPath = String(doc.details?.filePath);
    expect(existsSync(docPath)).toBe(true);
    const docZip = await JSZip.loadAsync(readFileSync(docPath));
    expect(docZip.file('word/document.xml')).toBeTruthy();
    const docXml = await docZip.file('word/document.xml')?.async('string');
    expect(docXml).toContain('城市口袋绿洲说明');

    const xlsx = await toolByName(tools, 'create_xlsx_file').execute('xlsx', {
      title: '月度预算',
      headers: ['项目', '预算', '实际'],
      rows: [
        ['植物采购', 3000, 2600],
        ['座椅维护', 1200, 900],
      ],
    }, undefined, undefined, { cwd });
    const xlsxPath = String(xlsx.details?.filePath);
    expect(existsSync(xlsxPath)).toBe(true);
    const workbook = XLSX.readFile(xlsxPath);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    expect(rows).toContainEqual(['项目', '预算', '实际']);
    expect(rows).toContainEqual(['植物采购', 3000, 2600]);

    const text = await toolByName(tools, 'create_text_file').execute('text', {
      title: '推广文案',
      content: '把城市角落变成可以停留的绿色片刻。',
    }, undefined, undefined, { cwd });
    const textPath = String(text.details?.filePath);
    expect(readFileSync(textPath, 'utf8')).toContain('推广文案');
    expect(text.content[0].text).toContain(`MEDIA:${textPath}`);

    const html = await toolByName(tools, 'create_html_app_file').execute('html', {
      title: '灵感收集小程序',
    }, undefined, undefined, { cwd });
    const htmlPath = String(html.details?.filePath);
    const htmlContent = readFileSync(htmlPath, 'utf8');
    expect(htmlContent).toContain('<!doctype html>');
    expect(htmlContent).toContain('localStorage');
    expect(html.content[0].text).toContain(`MEDIA:${htmlPath}`);
  });

  it('falls back to the OpenClaw workspace when tool context has no cwd', async () => {
    const previousHome = process.env.OPENCLAW_HOME;
    const openclawHome = mkdtempSync(join(tmpdir(), 'uclaw-home-'));
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const plugin = await loadPlugin();
      const tools = plugin.__test.createTools() as Array<{ name: string }>;
      const result = await toolByName(tools, 'create_text_file').execute('text', {
        title: 'Fallback Workspace',
        content: 'cwd-less invocation',
      }, undefined, undefined, {} as { cwd: string });
      const filePath = String(result.details?.filePath);

      expect(filePath).toContain(join(openclawHome, 'workspace', 'outputs'));
      expect(existsSync(filePath)).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousHome;
      }
    }
  });
});
