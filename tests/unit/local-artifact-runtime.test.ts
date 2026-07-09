import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalArtifact } from '@electron/utils/local-artifact-runtime';

describe('local artifact runtime sourcePrompt planning', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'uclaw-local-artifact-runtime-'));
    vi.stubEnv('OPENCLAW_HOME', tempRoot);
    vi.stubEnv('OPENCLAW_STATE_DIR', join(tempRoot, '.openclaw'));
    vi.stubEnv('OPENCLAW_CONFIG_PATH', '');
    vi.stubEnv('OPENCLAW_CONFIG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('generates a multi-page presentation from sourcePrompt and verifies it', async () => {
    const result = await createLocalArtifact({
      kind: 'presentation',
      sourcePrompt: '请制作 4 页 PPT，主题是《本地交付验证》。包含背景、方案、验证、下一步。',
    });

    expect(result.planning.mode).toBe('prompt-heuristic');
    expect(result.planning.prompt).toContain('4 页 PPT');
    expect(result.verification.status).toBe('passed');
    expect(result.verification.evidence).toContain('slides=4');
    expect(result.filePath).toContain(join(tempRoot, '.openclaw', 'workspace', 'outputs'));
    expect(existsSync(result.filePath)).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(result.filePath));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
    expect(slides).toHaveLength(4);
    expect(await zip.file('docProps/app.xml')?.async('string')).toContain('<Slides>4</Slides>');
    expect(await zip.file('ppt/slides/slide1.xml')?.async('string')).toContain('本地交付验证');
  });

  it('generates a formula spreadsheet from sourcePrompt and verifies it', async () => {
    const result = await createLocalArtifact({
      kind: 'spreadsheet',
      sourcePrompt: '请根据主题《销售漏斗》制作 Excel，包含线索、商机、成交、转化率和预计收入公式。',
    });

    expect(result.planning.mode).toBe('prompt-heuristic');
    expect(result.verification.status).toBe('passed');
    expect(result.verification.evidence).toContain('formulas=');
    expect(result.verification.evidence).not.toContain('formulas=0');
    expect(existsSync(result.filePath)).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(result.filePath));
    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    expect(workbookXml).toContain('销售漏斗');
    expect(sheetXml).toContain('<f>B3/B2</f>');
    expect(sheetXml).toContain('<f>SUM(D2:D5)</f>');
  });

  it('generates requested simulated sales rows and formula cell evidence', async () => {
    const result = await createLocalArtifact({
      kind: 'spreadsheet',
      sourcePrompt: '做一个 Excel：20 条模拟销售数据，含线索、商机、成交率、客单价、预计收入；生成后列出公式单元格',
    });

    expect(result.planning.mode).toBe('prompt-heuristic');
    expect(result.verification.status).toBe('passed');
    expect(result.verification.evidence).toContain('formulaCells=');
    expect(result.verification.evidence).toContain('F2=E2/C2');
    expect(result.verification.evidence).toContain('H2=E2*G2');

    const zip = await JSZip.loadAsync(readFileSync(result.filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    expect([...(sheetXml ?? '').matchAll(/<row\b/gu)]).toHaveLength(22);
    expect(sheetXml).toContain('客户 20');
    expect(sheetXml).toContain('<f>SUM(C2:C21)</f>');
  });

  it('generates an input-delete-filter HTML mini program from sourcePrompt and verifies it', async () => {
    const result = await createLocalArtifact({
      kind: 'mini_program',
      sourcePrompt: '请做一个 Todo 小程序，需要输入任务、删除任务、按全部/进行中/已完成筛选。',
    });

    expect(result.kind).toBe('webpage');
    expect(result.planning.mode).toBe('prompt-heuristic');
    expect(result.verification.status).toBe('passed');
    expect(result.verification.evidence).toContain('hasInput=true');
    expect(result.verification.evidence).toContain('hasDelete=true');
    expect(result.verification.evidence).toContain('hasFilter=true');

    const html = readFileSync(result.filePath, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<input id="taskInput"');
    expect(html).toContain('class="delete"');
    expect(html).toContain('data-filter="all"');
    expect(html).toContain('data-filter="active"');
    expect(html).toContain('data-filter="done"');
    expect(html).toContain('form.onsubmit');
    expect(html).toContain('onclick');
    expect(html).toContain('localStorage');
  });

  it('composes body/css/js when provided html is only an empty shell document', async () => {
    const result = await createLocalArtifact({
      kind: 'mini_program',
      title: '活动报名页面',
      html: '<!doctype html><html><head><title>空壳</title></head><body></body></html>',
      body: '<main class="panel"><form id="signupForm"><input id="nameInput"><button type="submit">提交报名</button></form><p id="success" hidden>报名成功</p></main>',
      css: '.panel{display:grid;gap:12px}',
      js: 'const form=document.getElementById("signupForm");const success=document.getElementById("success");form.onsubmit=(event)=>{event.preventDefault();success.hidden=false;};',
    });

    expect(result.planning.mode).toBe('provided');
    expect(result.verification.status).toBe('passed');
    expect(result.verification.evidence).toContain('hiddenDisplaySafe=true');

    const html = readFileSync(result.filePath, 'utf8');
    expect(html).toContain('[hidden]{display:none!important}');
    expect(html).toContain('id="signupForm"');
    expect(html).toContain('onsubmit');
    expect(html).not.toContain('<body></body>');
  });

  it('blocks HTML mini programs when hidden state is overridden visible at first paint', async () => {
    const result = await createLocalArtifact({
      kind: 'mini_program',
      title: '活动报名页面',
      html: '<!doctype html><html><head><style>.success-state{display:grid}</style></head><body><form id="signupForm"><input><button>提交</button></form><p class="success-state" hidden>报名成功</p><script>document.getElementById("signupForm").onsubmit=(event)=>{event.preventDefault()};</script></body></html>',
      sourcePrompt: '做一个活动报名页面，包含表单校验、报名成功状态、报名列表和本地保存',
    });

    expect(result.verification.status).toBe('blocked');
    expect(result.verification.evidence).toContain('hiddenDisplaySafe=false');
    expect(result.verification.evidence).toContain('.success-state');
  });

  it.each([
    {
      name: 'idea collector',
      prompt: '做一个灵感收集小工具，支持标签、搜索、本地保存',
      evidence: ['hasSearch=true', 'hasTags=true'],
      snippets: ['id="searchInput"', 'id="tagInput"', 'localStorage'],
    },
    {
      name: 'signup form',
      prompt: '做一个活动报名页面，包含表单校验、报名成功状态、报名列表和本地保存',
      evidence: ['hasValidation=true', 'hasSuccess=true', 'hasPersistence=true', 'hasList=true'],
      snippets: ['id="signupForm"', 'id="signupList"', 'localStorage', 'role="alert"', '报名成功'],
    },
    {
      name: 'coffee menu cart',
      prompt: '做一个咖啡店菜单小程序，可以按分类筛选并计算购物车总价',
      evidence: ['hasFilter=true', 'hasCart=true'],
      snippets: ['id="categoryBar"', 'id="cartTotal"', '加入购物车'],
    },
    {
      name: 'sales kanban',
      prompt: '做一个销售线索 Kanban，小卡片可以拖动或至少切换状态',
      evidence: ['hasKanban=true'],
      snippets: ['id="board"', 'statuses=', 'function move'],
    },
  ])('generates a prompt-specific interactive HTML mini program: $name', async ({ prompt, evidence, snippets }) => {
    const result = await createLocalArtifact({
      kind: 'mini_program',
      sourcePrompt: prompt,
    });

    expect(result.kind).toBe('webpage');
    expect(result.planning.mode).toBe('prompt-heuristic');
    expect(result.verification.status).toBe('passed');
    for (const item of evidence) expect(result.verification.evidence).toContain(item);

    const html = readFileSync(result.filePath, 'utf8');
    for (const snippet of snippets) expect(html).toContain(snippet);
  });
});
