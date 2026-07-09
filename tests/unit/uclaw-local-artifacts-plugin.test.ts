import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
    expect(JSON.parse(text.content[0].text).media).toBe(`MEDIA:${textPath}`);

    const html = await toolByName(tools, 'create_html_app_file').execute('html', {
      title: '灵感收集小程序',
    }, undefined, undefined, { cwd });
    const htmlPath = String(html.details?.filePath);
    const htmlContent = readFileSync(htmlPath, 'utf8');
    expect(htmlContent).toContain('<!doctype html>');
    expect(htmlContent).toContain('localStorage');
    expect(JSON.parse(html.content[0].text).media).toBe(`MEDIA:${htmlPath}`);
  });

  it('normalizes ClawX brand text in local artifact names and content', async () => {
    const plugin = await loadPlugin();
    const tools = plugin.__test.createTools() as Array<{ name: string }>;
    const cwd = mkdtempSync(join(tmpdir(), 'uclaw-local-artifacts-brand-'));

    const ppt = await toolByName(tools, 'create_pptx_file').execute('ppt', {
      filename: 'ClawX能力演示PPT.pptx',
      title: 'ClawX 能力演示',
      footer: 'ClawX',
      slides: [
        { title: 'ClawX 图片生成', bullets: ['ClawX 可以生成图片'] },
      ],
    }, undefined, undefined, { cwd });
    const pptPath = String(ppt.details?.filePath);
    expect(basename(pptPath)).toContain('UClaw');
    expect(basename(pptPath)).not.toMatch(/clawx/iu);
    const pptZip = await JSZip.loadAsync(readFileSync(pptPath));
    const pptXml = [
      await pptZip.file('docProps/core.xml')?.async('string'),
      await pptZip.file('ppt/slides/slide1.xml')?.async('string'),
      await pptZip.file('ppt/slides/slide2.xml')?.async('string'),
    ].join('\n');
    expect(pptXml).toContain('UClaw');
    expect(pptXml).not.toMatch(/clawx/iu);

    const text = await toolByName(tools, 'create_text_file').execute('text', {
      filename: 'ClawX文案.md',
      title: 'ClawX 文案',
      content: '这是 ClawX 的能力演示。',
    }, undefined, undefined, { cwd });
    const textPath = String(text.details?.filePath);
    expect(basename(textPath)).toContain('UClaw');
    expect(readFileSync(textPath, 'utf8')).not.toMatch(/clawx/iu);

    const html = await toolByName(tools, 'create_html_app_file').execute('html', {
      filename: 'ClawX小程序.html',
      title: 'ClawX 小程序',
      html: '<!doctype html><html><head><meta charset="utf-8"><title>ClawX 小程序</title><style>body{font-family:sans-serif}.panel{display:grid;gap:12px}</style></head><body><main class="panel"><h1>ClawX 小程序</h1><form id="form"><input id="input" placeholder="输入内容"><button type="submit">添加</button></form><ul id="list"></ul></main><script>const form=document.getElementById("form");const input=document.getElementById("input");const list=document.getElementById("list");form.onsubmit=(event)=>{event.preventDefault();const li=document.createElement("li");li.textContent=input.value||"ClawX 示例";list.appendChild(li);input.value=""};</script></body></html>',
    }, undefined, undefined, { cwd });
    const htmlPath = String(html.details?.filePath);
    expect(basename(htmlPath)).toContain('UClaw');
    expect(readFileSync(htmlPath, 'utf8')).not.toMatch(/clawx/iu);
  });

  it('composes structured HTML parts when a shell document is provided', async () => {
    const plugin = await loadPlugin();
    const tools = plugin.__test.createTools() as Array<{ name: string }>;
    const cwd = mkdtempSync(join(tmpdir(), 'uclaw-local-artifacts-html-parts-'));

    const result = await toolByName(tools, 'create_html_app_file').execute('html', {
      title: '活动报名页面',
      html: '<!doctype html><html><head><title>空壳</title></head><body></body></html>',
      body: '<main><form id="signupForm"><input id="nameInput"><button type="submit">提交报名</button></form><p id="success" hidden>报名成功</p></main>',
      css: '.success-state{display:grid}',
      js: 'document.getElementById("signupForm").onsubmit = (event) => { event.preventDefault(); document.getElementById("success").hidden = false; };',
    }, undefined, undefined, { cwd });

    expect(result.details?.ok).toBe(true);
    const htmlPath = String(result.details?.filePath);
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('id="signupForm"');
    expect(html).toContain('[hidden]{display:none!important}');
    expect(html).toContain('.success-state{display:grid}');
    expect(html).toContain('onsubmit');
    expect(html).not.toContain('<body></body>');
  });

  it('does not report success for empty shell HTML app output', async () => {
    const plugin = await loadPlugin();
    const tools = plugin.__test.createTools() as Array<{ name: string }>;
    const cwd = mkdtempSync(join(tmpdir(), 'uclaw-local-artifacts-empty-html-'));

    const result = await toolByName(tools, 'create_html_app_file').execute('html', {
      title: '空壳页面',
      html: '<!doctype html><html><head><title>空壳页面</title></head><body></body></html>',
    }, undefined, undefined, { cwd });

    expect(result.details?.ok).toBe(false);
    expect(result.details?.status).toBe('error');
    expect(result.details?.verification).toEqual(expect.objectContaining({
      status: 'blocked',
      kind: 'artifact.content',
      severity: 'blocking',
    }));
    expect(result.content[0].text).toContain('HTML 产物 body 为空');
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
