import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

type RegisteredTool = {
  name: string;
  parameters?: {
    properties?: Record<string, unknown>;
  };
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

describe('uclaw-computer-use office artifact tools', () => {
  it('registers and creates real PPTX, DOCX, and XLSX packages', async () => {
    const { pluginEntry } = await import('../../resources/openclaw-plugins/uclaw-computer-use/index.mjs');
    const registered: RegisteredTool[] = [];

    await pluginEntry.register({
      pluginConfig: {},
      registerTool(definition: RegisteredTool) {
        registered.push(definition);
      },
    });

    const tools = new Map(registered.map((tool) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual(expect.arrayContaining([
      'create_pptx_file',
      'create_docx_file',
      'create_xlsx_file',
    ]));
    expect(tools.get('create_pptx_file')?.parameters?.properties).toHaveProperty('openAfterCreate');
    expect(tools.get('create_docx_file')?.parameters?.properties).toHaveProperty('openAfterCreate');
    expect(tools.get('create_xlsx_file')?.parameters?.properties).toHaveProperty('openAfterCreate');

    const root = mkdtempSync(join(tmpdir(), 'uclaw-office-artifacts-'));
    const cases = [
      {
        name: 'create_pptx_file',
        path: join(root, 'deck.pptx'),
        params: {
          title: '办公能力验证',
          slides: [
            { title: '首页', bullets: ['生成真实 PPTX', '返回本地路径'] },
            { title: '验证', bullets: ['包含 Content Types', '包含 slide XML'] },
          ],
        },
        expectedFile: 'ppt/presentation.xml',
      },
      {
        name: 'create_docx_file',
        path: join(root, 'document.docx'),
        params: {
          title: '办公能力验证文档',
          paragraphs: ['这是 UClaw DOCX 生成验证。'],
        },
        expectedFile: 'word/document.xml',
      },
      {
        name: 'create_xlsx_file',
        path: join(root, 'sheet.xlsx'),
        params: {
          title: '办公能力验证表格',
          rows: [['项目', '状态'], ['PPTX', 'OK'], ['DOCX', 'OK'], ['XLSX', 'OK']],
        },
        expectedFile: 'xl/workbook.xml',
      },
    ];

    for (const item of cases) {
      const tool = tools.get(item.name);
      expect(tool).toBeTruthy();
      const result = await tool?.execute('test-call', {
        ...item.params,
        outputPath: item.path,
      });
      const resultRecord = asRecord(asRecord(result).data || result);

      expect(statSync(item.path).size).toBeGreaterThan(0);
      expect(resultRecord.filePath || item.path).toBe(item.path);

      const zip = await JSZip.loadAsync(readFileSync(item.path));
      expect(zip.file('[Content_Types].xml')).toBeTruthy();
      expect(zip.file(item.expectedFile)).toBeTruthy();
    }
  });
});
