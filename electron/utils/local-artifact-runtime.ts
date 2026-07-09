import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { getOpenClawConfigDir } from './paths';

export type LocalArtifactKind = 'presentation' | 'spreadsheet' | 'mini_program' | 'copywriting';

export type LocalArtifactPlanningMode = 'model' | 'provided' | 'prompt-heuristic' | 'fallback-template';

export type LocalArtifactVerificationResult = {
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  kind: string;
  required: boolean;
  severity: 'info' | 'warning' | 'blocking';
  detail: string;
  evidence?: string;
};

export type LocalArtifactCreateRequest = {
  kind: LocalArtifactKind;
  title?: string;
  filename?: string;
  sourcePrompt?: string;
  originalPrompt?: string;
  planningMode?: LocalArtifactPlanningMode;
  planningSummary?: string;
  slides?: Array<{ title?: string; subtitle?: string; body?: string; bullets?: string[] }>;
  sheets?: Array<{ name?: string; headers?: string[]; rows?: unknown[][] }>;
  content?: string;
  sections?: Array<{ title?: string; paragraphs?: string[]; bullets?: string[] }>;
  html?: string;
  body?: string;
  css?: string;
  js?: string;
};

export type LocalArtifactCreateResult = {
  kind: string;
  title: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  media: string;
  planning: {
    mode: LocalArtifactPlanningMode;
    prompt?: string;
    summary: string;
  };
  verification: LocalArtifactVerificationResult;
};

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  html: 'text/html',
} as const;

const MIN_HTML_FILE_SIZE_BYTES = 512;
const BASE_HTML_APP_CSS = '[hidden]{display:none!important}';
const PLACEHOLDER_LINE_RE = /^(?:tbd|todo|lorem ipsum|待补充|待完善|内容待定|在此填写.*|请填写.*内容|示例(?:内容|文本|数据)|可继续编辑补充内容[。.！!]?|第\s*\d+\s*页|补充分析\s*\d+)$/iu;
const GENERIC_TEMPLATE_LINE_RE = /(?:^围绕业务目标补充事实依据$|^明确执行动作和衡量指标$|^沉淀可复用检查清单$|^给出明确动作、负责人或判断标准$|^用可验证产物支撑最终结论$|要服务于「.+」这个核心目标|这份文案强调清晰目标、快速执行和可验证交付)/u;

type PresentationSlide = {
  title: string;
  subtitle?: string;
  body?: string;
  bullets: string[];
};

type PresentationSlideRole = 'cover' | 'agenda' | 'section' | 'content';

type SpreadsheetCellFormat = 'text' | 'integer' | 'decimal' | 'percent' | 'currency' | 'date';

type NormalizedSheet = {
  name: string;
  headers: string[];
  rows: unknown[][];
  columnFormats: SpreadsheetCellFormat[];
  columnWidths: number[];
};

function xml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeParagraph(value: unknown): string {
  return cleanText(value).replace(/[。！？!?]\s*/gu, (match) => `${match.trim()} `).trim();
}

function hasOwnContent(request: LocalArtifactCreateRequest): boolean {
  const hasSlides = (request.slides ?? []).some((slide) => (
    Boolean(cleanText(slide.title) || cleanText(slide.subtitle) || cleanText(slide.body))
    || (slide.bullets ?? []).some((bullet) => Boolean(cleanText(bullet)))
  ));
  const hasSheets = (request.sheets ?? []).some((sheet) => (
    (sheet.headers ?? []).some((header) => Boolean(cleanText(header)))
    || (sheet.rows ?? []).some((row) => row.some((cell) => Boolean(cleanText(spreadsheetCellValue(cell)))))
  ));
  const hasSections = (request.sections ?? []).some((section) => (
    Boolean(cleanText(section.title))
    || (section.paragraphs ?? []).some((paragraph) => Boolean(cleanText(paragraph)))
    || (section.bullets ?? []).some((bullet) => Boolean(cleanText(bullet)))
  ));
  return Boolean(
    hasSlides
    || hasSheets
    || cleanText(request.content)
    || hasSections
    || cleanText(request.html)
    || cleanText(request.body)
    || cleanText(request.css)
    || cleanText(request.js),
  );
}

function hasTaskContext(request: LocalArtifactCreateRequest): boolean {
  return Boolean(sourcePrompt(request) || hasOwnContent(request));
}

function isPlaceholderLine(value: string): boolean {
  const normalized = cleanText(value);
  return PLACEHOLDER_LINE_RE.test(normalized) || GENERIC_TEMPLATE_LINE_RE.test(normalized);
}

function sourcePrompt(request: LocalArtifactCreateRequest): string {
  return cleanText(request.sourcePrompt) || cleanText(request.originalPrompt) || cleanText(request.title);
}

function extractQuotedTopic(prompt: string, fallback: string): string {
  const quoted = prompt.match(/《([^》]{2,80})》/u)
    ?? prompt.match(/["“]([^"”]{2,80})["”]/u)
    ?? prompt.match(/主题(?:是|为|：|:)?\s*([^，。；;,.]{2,80})/u);
  if (quoted?.[1]) return cleanText(quoted[1]);
  const afterColon = prompt.match(/[：:]\s*([^，。；;,.]{2,80})/u);
  if (afterColon?.[1]) return cleanText(afterColon[1]);
  return fallback;
}

function parseRequestedCount(prompt: string, unit: '页' | '条' | '个'): number | undefined {
  const direct = prompt.match(new RegExp(`(\\d{1,2})\\s*${unit}`, 'u'));
  if (direct?.[1]) {
    const count = Number.parseInt(direct[1], 10);
    if (Number.isFinite(count) && count > 0) return Math.min(count, 30);
  }
  const chineseDigits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const chinese = prompt.match(new RegExp(`([一二两三四五六七八九十])\\s*${unit}`, 'u'));
  return chinese?.[1] ? chineseDigits[chinese[1]] : undefined;
}

function splitRequestedTopics(prompt: string): string[] {
  const afterNeed = prompt.match(/(?:要有|包含|包括|需要|覆盖)([^。.!?！？]*)/u)?.[1] ?? '';
  return afterNeed
    .split(/[、,，;；/]/u)
    .map((item) => cleanText(item.replace(/和$/u, '')))
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function ensureLength<T>(items: T[], target: number, factory: (index: number) => T): T[] {
  const next = [...items];
  while (next.length < target) next.push(factory(next.length));
  return next.slice(0, target);
}

function sanitizeBaseName(value: unknown, fallback: string): string {
  const normalized = cleanText(value)
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/gu, '');
  return normalized || fallback;
}

function compactTimestamp(date = new Date()): string {
  return date.toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '')
    .replace(/[TZ]/gu, '-')
    .replace(/-$/u, '');
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

async function uniqueOutputPath(title: unknown, filename: unknown, extension: string, fallbackName: string): Promise<string> {
  const outputDir = join(getOpenClawConfigDir(), 'workspace', 'outputs');
  await mkdir(outputDir, { recursive: true });
  const requested = cleanText(filename);
  const base = requested
    ? sanitizeBaseName(requested.replace(/\.[^.]+$/u, ''), fallbackName)
    : `${sanitizeBaseName(title, fallbackName)}_${compactTimestamp()}_${randomUUID().slice(0, 6)}`;
  let candidate = join(outputDir, withExtension(base, extension));
  if (!existsSync(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = join(outputDir, withExtension(`${base}_${index}`, extension));
    if (!existsSync(candidate)) return candidate;
  }
  return join(outputDir, withExtension(`${base}_${randomUUID().slice(0, 8)}`, extension));
}

function relsXml(relationships: Array<{ id: string; type: string; target: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.map((rel) => `  <Relationship Id="${xml(rel.id)}" Type="${xml(rel.type)}" Target="${xml(rel.target)}"/>`).join('\n')}
</Relationships>`;
}

function coreXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xml(title)}</dc:title>
  <dc:creator>UClaw</dc:creator>
  <cp:lastModifiedBy>UClaw</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`;
}

function presentationAppXml(slideCount: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>UClaw</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
</Properties>`;
}

function presentationContentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) =>
    `  <Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
</Types>`;
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `    <p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function themeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="UClaw">
  <a:themeElements>
    <a:clrScheme name="UClaw"><a:dk1><a:sysClr val="windowText" lastClr="111827"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0F172A"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="F97316"/></a:accent3><a:accent4><a:srgbClr val="9333EA"/></a:accent4><a:accent5><a:srgbClr val="0EA5E9"/></a:accent5><a:accent6><a:srgbClr val="DC2626"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="9333EA"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="UClaw"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="UClaw"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function slideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function slideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`;
}

type PresentationParagraph = {
  text: string;
  size: number;
  color?: string;
  bold?: boolean;
  bullet?: boolean;
  align?: 'l' | 'ctr' | 'r';
  spaceAfter?: number;
};

function presentationShape(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  fill: string,
  line = fill,
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

function presentationTextBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: PresentationParagraph[],
  options: {
    fill?: string;
    line?: string;
    margin?: number;
    vertical?: 't' | 'ctr' | 'b';
  } = {},
): string {
  const margin = options.margin ?? 0;
  const fill = options.fill
    ? `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>`
    : '<a:noFill/>';
  const line = options.line
    ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${options.line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  const runs = paragraphs
    .map((paragraph) => {
      const text = cleanText(paragraph.text);
      if (!text) return '';
      const bullet = paragraph.bullet ? '<a:buChar char="•"/>' : '<a:buNone/>';
      const marginLeft = paragraph.bullet ? 342900 : 0;
      const indent = paragraph.bullet ? -228600 : 0;
      const spacing = paragraph.spaceAfter
        ? `<a:spcAft><a:spcPts val="${paragraph.spaceAfter}"/></a:spcAft>`
        : '';
      const color = paragraph.color ?? '172033';
      return `<a:p><a:pPr marL="${marginLeft}" indent="${indent}" algn="${paragraph.align ?? 'l'}">${spacing}${bullet}</a:pPr><a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${paragraph.size}"${paragraph.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t xml:space="preserve">${xml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${paragraph.size}"/></a:p>`;
    })
    .filter(Boolean)
    .join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${margin}" rIns="${margin}" tIns="${margin}" bIns="${margin}" anchor="${options.vertical ?? 't'}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runs || '<a:p/>'}</p:txBody></p:sp>`;
}

function presentationSlideRole(slide: PresentationSlide, index: number): PresentationSlideRole {
  if (index === 0) return 'cover';
  if (/^(?:目录|议程|内容概览|overview|agenda)$/iu.test(slide.title)) return 'agenda';
  if (/^(?:第?[一二三四五六七八九十百\d]+[章节部分篇]|chapter\s+\d+|part\s+\d+|section\s+\d+)/iu.test(slide.title)) return 'section';
  if (!slide.body && !slide.subtitle && slide.bullets.length <= 1) return 'section';
  return 'content';
}

function estimatedPresentationLines(values: string[], charsPerLine: number): number {
  return values.reduce((sum, value) => sum + Math.max(1, Math.ceil(cleanText(value).length / charsPerLine)), 0);
}

function presentationBodyFontSize(values: string[], charsPerLine = 34): number {
  const lines = estimatedPresentationLines(values, charsPerLine);
  if (lines > 24) return 1400;
  if (lines > 18) return 1550;
  if (lines > 12) return 1700;
  return 1900;
}

function slideBackgroundXml(fill: string): string {
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

function presentationSlideXml(slide: PresentationSlide, index: number, slideCount: number, deckTitle: string): string {
  const role = presentationSlideRole(slide, index);
  const shapes: string[] = [];
  let nextId = 2;
  const addShape = (shape: string): void => { shapes.push(shape); };
  const id = (): number => {
    const value = nextId;
    nextId += 1;
    return value;
  };
  let background: string;

  if (role === 'cover') {
    background = '172033';
    addShape(presentationShape(id(), 'UClaw Cover Accent', 0, 0, 190500, 6858000, '14B8A6'));
    addShape(presentationTextBox(id(), 'UClaw Cover Label', 914400, 640000, 4600000, 350000, [
      { text: 'UCLAW PRESENTATION', size: 1200, color: '5EEAD4', bold: true },
    ]));
    addShape(presentationTextBox(id(), 'UClaw Cover Title', 914400, 1500000, 9300000, 1900000, [
      { text: slide.title, size: slide.title.length > 24 ? 3600 : 4400, color: 'FFFFFF', bold: true },
    ], { vertical: 'ctr' }));
    const coverLead = [slide.subtitle, slide.body].map(cleanText).filter(Boolean);
    if (coverLead.length > 0) {
      addShape(presentationTextBox(id(), 'UClaw Cover Subtitle', 914400, 3550000, 8500000, 900000, coverLead.map((text) => ({
        text,
        size: 1900,
        color: 'CBD5E1',
        spaceAfter: 600,
      }))));
    }
    if (slide.bullets.length > 0) {
      addShape(presentationTextBox(id(), 'UClaw Cover Summary', 914400, 5000000, 9800000, 800000, slide.bullets.slice(0, 3).map((text) => ({
        text,
        size: 1400,
        color: 'E2E8F0',
        bullet: true,
        spaceAfter: 400,
      }))));
    }
    addShape(presentationTextBox(id(), 'UClaw Cover Footer', 914400, 6200000, 9800000, 250000, [
      { text: `${new Date().getFullYear()} · 可编辑演示文稿`, size: 1000, color: '94A3B8' },
    ]));
  } else if (role === 'agenda') {
    background = 'F7F9FC';
    addShape(presentationShape(id(), 'UClaw Agenda Accent', 0, 0, 12192000, 145000, '0F766E'));
    addShape(presentationTextBox(id(), 'UClaw Section Label', 762000, 520000, 2400000, 300000, [
      { text: '内容导航 / OUTLINE', size: 1100, color: '0F766E', bold: true },
    ]));
    addShape(presentationTextBox(id(), 'UClaw Title', 762000, 850000, 10600000, 700000, [
      { text: slide.title, size: 3000, color: '172033', bold: true },
    ]));
    const agendaItems = slide.bullets.length > 0
      ? slide.bullets.slice(0, 8)
      : [slide.body || slide.subtitle || '内容待补充'];
    agendaItems.forEach((item, itemIndex) => {
      const column = itemIndex % 2;
      const row = Math.floor(itemIndex / 2);
      const x = column === 0 ? 762000 : 6250000;
      const y = 1850000 + row * 1030000;
      addShape(presentationTextBox(id(), `UClaw Agenda Item ${itemIndex + 1}`, x, y, 5100000, 760000, [
        { text: String(itemIndex + 1).padStart(2, '0'), size: 1200, color: 'D97706', bold: true, spaceAfter: 300 },
        { text: item, size: 1700, color: '243247', bold: true },
      ], { fill: 'FFFFFF', line: 'DCE4EE', margin: 170000, vertical: 'ctr' }));
    });
  } else if (role === 'section') {
    background = '0F3D3A';
    addShape(presentationShape(id(), 'UClaw Section Accent', 0, 0, 220000, 6858000, 'F59E0B'));
    addShape(presentationTextBox(id(), 'UClaw Section Label', 914400, 1100000, 3600000, 360000, [
      { text: `章节 ${String(index).padStart(2, '0')} / SECTION`, size: 1200, color: '99F6E4', bold: true },
    ]));
    addShape(presentationTextBox(id(), 'UClaw Title', 914400, 2050000, 9400000, 1500000, [
      { text: slide.title, size: slide.title.length > 24 ? 3400 : 4200, color: 'FFFFFF', bold: true },
    ], { vertical: 'ctr' }));
    const summary = [slide.subtitle, slide.body, ...slide.bullets].map(cleanText).filter(Boolean);
    if (summary.length > 0) {
      addShape(presentationTextBox(id(), 'UClaw Section Summary', 914400, 4150000, 8200000, 900000, summary.slice(0, 3).map((text) => ({
        text,
        size: 1750,
        color: 'CCFBF1',
        bullet: summary.length > 1,
        spaceAfter: 500,
      }))));
    }
  } else {
    background = 'FFFFFF';
    addShape(presentationShape(id(), 'UClaw Content Accent', 0, 0, 160000, 6858000, '0F766E'));
    addShape(presentationTextBox(id(), 'UClaw Section Label', 762000, 430000, 2800000, 260000, [
      { text: `章节 ${String(index).padStart(2, '0')} / KEY POINT`, size: 1050, color: '0F766E', bold: true },
    ]));
    addShape(presentationTextBox(id(), 'UClaw Title', 762000, 760000, 10600000, 720000, [
      { text: slide.title, size: slide.title.length > 30 ? 2600 : 3100, color: '172033', bold: true },
    ]));
    addShape(presentationShape(id(), 'UClaw Title Rule', 762000, 1530000, 10600000, 17000, 'D7E0E8'));
    const lead = [slide.subtitle, slide.body].map(cleanText).filter(Boolean);
    let contentY = 1850000;
    if (lead.length > 0) {
      addShape(presentationTextBox(id(), 'UClaw Content Lead', 762000, contentY, 10600000, 760000, lead.map((text) => ({
        text,
        size: 1650,
        color: '405166',
        bold: lead.length === 1,
        spaceAfter: 350,
      })), { fill: 'EEF7F5', line: 'C8E7E1', margin: 180000, vertical: 'ctr' }));
      contentY = 2820000;
    }
    const bullets = slide.bullets.length > 0 ? slide.bullets : (lead.length > 0 ? [] : ['内容待补充']);
    if (bullets.length > 0) {
      const useColumns = bullets.length > 5 || estimatedPresentationLines(bullets, 34) > 14;
      const groups = useColumns
        ? [bullets.slice(0, Math.ceil(bullets.length / 2)), bullets.slice(Math.ceil(bullets.length / 2))]
        : [bullets];
      const gap = 260000;
      const width = useColumns ? Math.floor((10600000 - gap) / 2) : 10600000;
      groups.filter((group) => group.length > 0).forEach((group, groupIndex) => {
        const fontSize = presentationBodyFontSize(group, useColumns ? 23 : 40);
        addShape(presentationTextBox(id(), `UClaw Content ${groupIndex + 1}`, 762000 + groupIndex * (width + gap), contentY, width, 5900000 - contentY, group.map((text) => ({
          text,
          size: fontSize,
          color: '243247',
          bullet: true,
          spaceAfter: 650,
        })), { fill: 'F7F9FC', line: 'E1E7EF', margin: 230000 }));
      });
    }
  }

  if (role !== 'cover') {
    addShape(presentationTextBox(id(), 'UClaw Footer', 762000, 6350000, 10600000, 220000, [
      { text: `${deckTitle}    ${String(index + 1).padStart(2, '0')} / ${String(slideCount).padStart(2, '0')}`, size: 900, color: role === 'section' ? '99B8B4' : '7A8798', align: 'r' },
    ]));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${slideBackgroundXml(background)}<p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${shapes.join('\n    ')}
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildPlannedPresentation(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const topic = extractQuotedTopic(prompt, cleanText(request.title) || 'AI 工作流效率提升');
  const requestedTopics = splitRequestedTopics(prompt);
  const slideCount = parseRequestedCount(prompt, '页') ?? Math.max(6, Math.min(10, requestedTopics.length + 2));
  const outline = requestedTopics.length > 0
    ? requestedTopics
    : ['目录', '现状痛点', '解决方案', '示例场景', '价值与 ROI', '落地计划', '风险与下一步'];
  const slides = ensureLength([
    {
      title: topic,
      subtitle: '由 UClaw 根据当前任务自动规划的可编辑演示稿',
      bullets: ['目标清晰', '结构完整', '可继续编辑'],
    },
    {
      title: '目录',
      bullets: outline.slice(0, 6).map((item, index) => `${index + 1}. ${item}`),
    },
    ...outline
      .filter((item) => item !== '目录')
      .map((item) => ({
        title: item,
        bullets: presentationBulletsForTopic(topic, item),
      })),
  ], slideCount, (index) => ({
    title: index === slideCount - 1 ? '下一步行动' : `补充分析 ${index + 1}`,
    bullets: index === slideCount - 1
      ? ['确认目标用户与交付标准', '拆解试点场景与负责人', '按周复盘数据和体验反馈']
      : ['围绕业务目标补充事实依据', '明确执行动作和衡量指标', '沉淀可复用检查清单'],
  }));

  return {
    ...request,
    title: topic,
    slides,
  };
}

function presentationBulletsForTopic(topic: string, item: string): string[] {
  const normalized = item.toLowerCase();
  if (/痛点|问题|现状/u.test(item)) {
    return ['重复工作分散在多个工具里，交接成本高', '关键产物缺少统一验证，返工难以及时发现', '多人协作时上下文容易丢失或被误用'];
  }
  if (/方案|路径|架构|设计/u.test(item)) {
    return [`围绕「${topic}」建立统一任务入口`, '把任务拆成可追踪子任务和产物清单', '在最终回复前执行内容、文件和可用性验证'];
  }
  if (/案例|场景|示例/u.test(item)) {
    return ['从一个真实业务请求开始，自动拆解资料、数据和展示物', '让每个子任务形成独立文件或媒体产物', '通过验证证据降低交付不确定性'];
  }
  if (/roi|收益|价值|指标/u.test(normalized)) {
    return ['减少反复追问和人工整理时间', '降低文件打不开、公式缺失、页面不可用等返工', '把交付质量从个人经验变成可检查证据'];
  }
  if (/落地|计划|推进|里程碑/u.test(item)) {
    return ['第 1 周：选定高频场景和验收 prompt', '第 2-3 周：接入产物生成与验证链路', '第 4 周：灰度发布并收集失败样本'];
  }
  if (/风险|trade|取舍/u.test(normalized)) {
    return ['模型规划失败时必须有可恢复 fallback', '长任务需要明确进度和取消路径', '历史恢复必须以结构化 manifest 为准'];
  }
  return [
    `${item} 要服务于「${topic}」这个核心目标`,
    '给出明确动作、负责人或判断标准',
    '用可验证产物支撑最终结论',
  ];
}

function buildPlannedSpreadsheet(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const topic = extractQuotedTopic(prompt, cleanText(request.title) || '月度预算 Excel');
  if (/模拟.*销售|销售.*模拟|客户数据|销售数据/u.test(prompt)) {
    const requestedRows = parseRequestedCount(prompt, '条') ?? 20;
    const sources = ['官网咨询', '线下活动', '社媒私信', '老客转介绍', '渠道伙伴'];
    const rows = Array.from({ length: Math.min(Math.max(requestedRows, 5), 30) }, (_, index) => {
      const rowNumber = index + 2;
      const leads = 8 + (index % 5) * 3;
      const opportunities = Math.max(1, Math.round(leads * (0.32 + (index % 4) * 0.04)));
      const deals = Math.max(0, Math.round(opportunities * (0.28 + (index % 3) * 0.05)));
      const unitPrice = 6800 + (index % 6) * 900;
      return [
        `客户 ${String(index + 1).padStart(2, '0')}`,
        sources[index % sources.length],
        leads,
        opportunities,
        deals,
        { formula: `E${rowNumber}/C${rowNumber}`, value: Number((deals / leads).toFixed(4)) },
        unitPrice,
        { formula: `E${rowNumber}*G${rowNumber}`, value: deals * unitPrice },
        deals >= 3 ? '高优先级' : opportunities >= 4 ? '持续跟进' : '培育中',
      ];
    });
    const totalRowNumber = rows.length + 2;
    return {
      ...request,
      title: topic,
      sheets: [{
        name: '销售明细',
        headers: ['客户', '来源', '线索数', '商机数', '成交数', '成交率', '客单价', '预计收入', '备注'],
        rows: [
          ...rows,
          [
            '合计',
            '',
            { formula: `SUM(C2:C${totalRowNumber - 1})`, value: rows.reduce((sum, row) => sum + Number(row[2] ?? 0), 0) },
            { formula: `SUM(D2:D${totalRowNumber - 1})`, value: rows.reduce((sum, row) => sum + Number(row[3] ?? 0), 0) },
            { formula: `SUM(E2:E${totalRowNumber - 1})`, value: rows.reduce((sum, row) => sum + Number(row[4] ?? 0), 0) },
            { formula: `E${totalRowNumber}/C${totalRowNumber}`, value: 0 },
            { formula: `AVERAGE(G2:G${totalRowNumber - 1})`, value: 0 },
            { formula: `SUM(H2:H${totalRowNumber - 1})`, value: 0 },
            '自动汇总',
          ],
        ],
      }],
    };
  }
  if (/销售|漏斗|线索|商机|成交|转化/u.test(prompt)) {
    return {
      ...request,
      title: topic,
      sheets: [{
        name: '销售漏斗',
        headers: ['阶段', '数量', '转化率', '预计收入', '备注'],
        rows: [
          ['线索', 240, '', 0, '市场活动与自然流量合计'],
          ['商机', 96, { formula: 'B3/B2', value: 0.4 }, 288000, '按 3000 元客单价估算'],
          ['方案', 42, { formula: 'B4/B3', value: 0.4375 }, 252000, '已进入报价或演示'],
          ['成交', 18, { formula: 'B5/B4', value: 0.4286 }, 162000, '按 9000 元实际客单估算'],
          ['整体转化', { formula: 'B5/B2', value: 0.075 }, '', { formula: 'SUM(D2:D5)', value: 702000 }, '从线索到成交'],
        ],
      }],
    };
  }

  if (/排期|项目|任务|负责人|风险/u.test(prompt)) {
    return {
      ...request,
      title: topic,
      sheets: [{
        name: '项目排期',
        headers: ['任务', '负责人', '开始日期', '结束日期', '进度', '风险等级', '备注'],
        rows: [
          ['需求确认', '产品', '2026-07-10', '2026-07-12', 1, '低', '确认验收标准'],
          ['原型与评审', '设计', '2026-07-13', '2026-07-16', 0.6, '中', '关注移动端适配'],
          ['开发实现', '工程', '2026-07-17', '2026-07-25', 0.25, '中', '每日同步阻塞项'],
          ['联调验收', '测试', '2026-07-26', '2026-07-29', 0, '高', '需要提前准备样本数据'],
        ],
      }],
    };
  }

  const detailRows = [
    ['房租', 4200, 4200, { formula: 'B2-C2', value: 0 }, { formula: 'C2/B2', value: 1 }, '固定支出'],
    ['餐饮', 2200, 1980, { formula: 'B3-C3', value: 220 }, { formula: 'C3/B3', value: 0.9 }, '低于预算'],
    ['交通', 600, 520, { formula: 'B4-C4', value: 80 }, { formula: 'C4/B4', value: 0.8667 }, '通勤与打车'],
    ['学习', 800, 640, { formula: 'B5-C5', value: 160 }, { formula: 'C5/B5', value: 0.8 }, '课程与书籍'],
    ['工具订阅', 500, 580, { formula: 'B6-C6', value: -80 }, { formula: 'C6/B6', value: 1.16 }, '超预算需复核'],
    ['合计', { formula: 'SUM(B2:B6)', value: 8300 }, { formula: 'SUM(C2:C6)', value: 7920 }, { formula: 'SUM(D2:D6)', value: 380 }, { formula: 'C7/B7', value: 0.9542 }, '自动汇总'],
  ];
  return {
    ...request,
    title: topic,
    sheets: [
      {
        name: '预算明细',
        headers: ['分类', '预算', '实际', '差额', '完成率', '备注'],
        rows: detailRows,
      },
      {
        name: '图表数据',
        headers: ['分类', '预算', '实际'],
        rows: detailRows.slice(0, -1).map((row) => [row[0], row[1], row[2]]),
      },
    ],
  };
}

function buildTodoHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const title = extractQuotedTopic(prompt, cleanText(request.title) || 'Todo 小程序');
  const body = `<main class="shell">
  <header>
    <h1>${xml(title)}</h1>
    <div class="stats"><span id="total">0</span><span id="done">0</span></div>
  </header>
  <form id="taskForm">
    <input id="taskInput" placeholder="新增一个任务" autocomplete="off">
    <button type="submit">新增</button>
  </form>
  <nav class="filters" aria-label="任务筛选">
    <button type="button" data-filter="all" class="active">全部</button>
    <button type="button" data-filter="active">进行中</button>
    <button type="button" data-filter="done">已完成</button>
  </nav>
  <ul id="taskList" aria-live="polite"></ul>
  <p id="empty" class="empty">还没有任务，先添加一条。</p>
</main>`;
  const css = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f7fb;color:#172033}button,input{font:inherit}.shell{width:min(760px,calc(100vw - 32px));margin:32px auto;padding:20px;background:#fff;border:1px solid #dfe7f3;border-radius:8px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:24px;margin:0}.stats{display:flex;gap:8px;color:#456}.stats span{min-width:42px;text-align:center;background:#eef5ff;border-radius:6px;padding:8px}form{display:grid;grid-template-columns:1fr auto;gap:10px;margin:18px 0}input{border:1px solid #cbd7e6;border-radius:6px;padding:11px 12px}button{border:1px solid #2f6fed;border-radius:6px;background:#2f6fed;color:#fff;padding:10px 13px;cursor:pointer}.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.filters button{background:#f3f6fa;color:#1f2a44;border-color:#d7e0ec}.filters button.active{background:#183153;color:#fff}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}li{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;border:1px solid #e1e8f0;border-radius:6px;padding:10px}li.done .text{text-decoration:line-through;color:#7a8798}.delete{background:#fff;color:#b42318;border-color:#f2b8b5}.empty{color:#65758b;text-align:center}`;
  const js = `const key='uclaw-todo-items-v2';let items=JSON.parse(localStorage.getItem(key)||'[]');let filter='all';const form=document.getElementById('taskForm');const input=document.getElementById('taskInput');const list=document.getElementById('taskList');const empty=document.getElementById('empty');const total=document.getElementById('total');const done=document.getElementById('done');function save(){localStorage.setItem(key,JSON.stringify(items))}function visible(){return items.filter(item=>filter==='all'||(filter==='done'?item.done:!item.done))}function render(){const rows=visible();list.innerHTML='';rows.forEach(item=>{const li=document.createElement('li');li.className=item.done?'done':'';li.innerHTML='<input type="checkbox"><span class="text"></span><button class="delete" type="button">删除</button>';li.querySelector('input').checked=item.done;li.querySelector('input').onchange=()=>{item.done=!item.done;save();render()};li.querySelector('.text').textContent=item.text;li.querySelector('.delete').onclick=()=>{items=items.filter(candidate=>candidate.id!==item.id);save();render()};list.appendChild(li)});empty.style.display=rows.length?'none':'block';total.textContent=String(items.length);done.textContent=String(items.filter(item=>item.done).length)}form.onsubmit=event=>{event.preventDefault();const text=input.value.trim();if(!text)return;items.unshift({id:Date.now()+Math.random(),text,done:false});input.value='';save();render()};document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));render()});if(items.length===0){items=[{id:1,text:'整理今天的三个重点',done:false},{id:2,text:'检查交付物是否可打开',done:true}]};render();`;
  return { ...request, title, body, css, js };
}

function buildIdeaCollectorHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const title = extractQuotedTopic(prompt, cleanText(request.title) || '灵感收集小工具');
  const body = `<main class="shell">
  <header><h1>${xml(title)}</h1><input id="searchInput" placeholder="搜索灵感或标签"></header>
  <form id="ideaForm">
    <input id="ideaInput" placeholder="记录一个灵感" autocomplete="off">
    <input id="tagInput" placeholder="标签，例如 产品">
    <button type="submit">保存</button>
  </form>
  <section id="tagBar" class="tags" aria-label="标签筛选"></section>
  <ul id="ideaList" aria-live="polite"></ul>
</main>`;
  const css = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f8fb;color:#172033}button,input{font:inherit}.shell{width:min(820px,calc(100vw - 32px));margin:28px auto;padding:20px;background:#fff;border:1px solid #dfe7f2;border-radius:8px}header{display:grid;grid-template-columns:1fr minmax(180px,280px);gap:12px;align-items:center}h1{font-size:24px;margin:0}form{display:grid;grid-template-columns:1fr minmax(120px,180px) auto;gap:10px;margin:18px 0}input{border:1px solid #cbd7e6;border-radius:6px;padding:10px 12px;min-width:0}button{border:1px solid #2264d1;border-radius:6px;background:#2264d1;color:#fff;padding:10px 13px;cursor:pointer}.tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.tags button{background:#eef4ff;color:#17315f;border-color:#cfe0ff}.tags button.active{background:#17315f;color:#fff}ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}li{border:1px solid #e1e8f0;border-radius:6px;padding:12px}.meta{display:flex;justify-content:space-between;gap:10px;color:#667085;font-size:13px}.tag{color:#2264d1}@media(max-width:680px){header,form{grid-template-columns:1fr}}`;
  const js = `const key='uclaw-ideas-v2';let ideas=JSON.parse(localStorage.getItem(key)||'[]');let activeTag='all';const form=document.getElementById('ideaForm');const ideaInput=document.getElementById('ideaInput');const tagInput=document.getElementById('tagInput');const searchInput=document.getElementById('searchInput');const tagBar=document.getElementById('tagBar');const list=document.getElementById('ideaList');function save(){localStorage.setItem(key,JSON.stringify(ideas))}function tags(){return ['all',...new Set(ideas.map(item=>item.tag).filter(Boolean))]}function matches(item){const q=searchInput.value.trim().toLowerCase();const okTag=activeTag==='all'||item.tag===activeTag;const okSearch=!q||item.text.toLowerCase().includes(q)||item.tag.toLowerCase().includes(q);return okTag&&okSearch}function render(){tagBar.innerHTML='';tags().forEach(tag=>{const button=document.createElement('button');button.type='button';button.textContent=tag==='all'?'全部':tag;button.className=tag===activeTag?'active':'';button.onclick=()=>{activeTag=tag;render()};tagBar.appendChild(button)});list.innerHTML='';ideas.filter(matches).forEach(item=>{const li=document.createElement('li');li.innerHTML='<div class="meta"><span class="tag"></span><button type="button">删除</button></div><p></p>';li.querySelector('.tag').textContent='#'+item.tag;li.querySelector('p').textContent=item.text;li.querySelector('button').onclick=()=>{ideas=ideas.filter(candidate=>candidate.id!==item.id);save();render()};list.appendChild(li)})}form.onsubmit=event=>{event.preventDefault();const text=ideaInput.value.trim();if(!text)return;ideas.unshift({id:Date.now()+Math.random(),text,tag:tagInput.value.trim()||'未分类'});ideaInput.value='';tagInput.value='';save();render()};searchInput.oninput=render;if(ideas.length===0){ideas=[{id:1,text:'把多产物任务做成稳定 manifest',tag:'产品'},{id:2,text:'记录每个产物的验证证据',tag:'工程'}];save()}render();`;
  return { ...request, title, body, css, js };
}

function buildSignupHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const title = extractQuotedTopic(prompt, cleanText(request.title) || '活动报名页面');
  const body = `<main class="shell">
  <section>
    <h1>${xml(title)}</h1>
    <p class="lead">填写信息后提交，页面会即时校验并展示报名状态。</p>
    <form id="signupForm" novalidate>
      <label>姓名<input id="nameInput" autocomplete="name"></label>
      <label>手机号<input id="phoneInput" autocomplete="tel"></label>
      <label>人数<input id="countInput" type="number" min="1" max="8" value="1"></label>
      <button type="submit">提交报名</button>
    </form>
    <p id="error" class="error" role="alert"></p>
    <p id="success" class="success" role="status"></p>
    <h2>报名列表</h2>
    <ul id="signupList" aria-live="polite"></ul>
  </section>
</main>`;
  const css = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7fafc;color:#172033}.shell{min-height:100vh;display:grid;place-items:center;padding:24px}section{width:min(620px,100%);background:#fff;border:1px solid #dfe7f0;border-radius:8px;padding:22px}h1{font-size:24px;margin:0 0 8px}h2{font-size:17px;margin:18px 0 8px}.lead{color:#5f6f84;margin:0 0 16px}form{display:grid;gap:12px}label{display:grid;gap:6px;font-weight:600}input{border:1px solid #cbd7e6;border-radius:6px;padding:10px 12px}button{border:1px solid #14765a;border-radius:6px;background:#14765a;color:#fff;padding:11px 13px;cursor:pointer}.error{color:#b42318;min-height:22px}.success{color:#067647;font-weight:700;min-height:22px}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;gap:10px;border:1px solid #e4eaf2;border-radius:6px;padding:10px 12px}@media(max-width:520px){.shell{padding:14px}section{padding:16px}}`;
  const js = `const key='uclaw-signups-v2';let signups=JSON.parse(localStorage.getItem(key)||'[]');const form=document.getElementById('signupForm');const nameInput=document.getElementById('nameInput');const phoneInput=document.getElementById('phoneInput');const countInput=document.getElementById('countInput');const error=document.getElementById('error');const success=document.getElementById('success');const signupList=document.getElementById('signupList');function save(){localStorage.setItem(key,JSON.stringify(signups))}function renderList(){signupList.innerHTML='';if(signups.length===0){const li=document.createElement('li');li.textContent='暂无报名';signupList.appendChild(li);return}signups.forEach(item=>{const li=document.createElement('li');li.innerHTML='<span></span><strong></strong>';li.querySelector('span').textContent=item.name+' · '+item.phone;li.querySelector('strong').textContent=item.count+' 人';signupList.appendChild(li)})}form.onsubmit=event=>{event.preventDefault();error.textContent='';success.textContent='';const name=nameInput.value.trim();const phone=phoneInput.value.trim();const count=Number(countInput.value);if(name.length<2){error.textContent='请填写至少 2 个字的姓名。';return}if(!/^1\\d{10}$/.test(phone)){error.textContent='请填写 11 位手机号。';return}if(!Number.isFinite(count)||count<1||count>8){error.textContent='报名人数需在 1 到 8 人之间。';return}signups.unshift({id:Date.now()+Math.random(),name,phone,count});save();renderList();success.textContent='报名成功，已为 '+name+' 预留 '+count+' 个名额。';form.reset();countInput.value='1'};renderList();`;
  return { ...request, title, body, css, js };
}

function buildCoffeeMenuHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const title = extractQuotedTopic(prompt, cleanText(request.title) || '咖啡店菜单小程序');
  const body = `<main class="shell">
  <header><h1>${xml(title)}</h1><strong id="cartTotal">¥0</strong></header>
  <nav id="categoryBar" class="filters"></nav>
  <section id="menuGrid" class="grid"></section>
  <aside><h2>购物车</h2><ul id="cartList"></ul></aside>
</main>`;
  const css = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#182230}.shell{width:min(980px,calc(100vw - 32px));margin:24px auto;display:grid;grid-template-columns:1fr 280px;gap:16px}header{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:16px}h1,h2{margin:0;font-size:24px}.filters{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}.filters button,.card button{border:1px solid #244f3f;border-radius:6px;background:#244f3f;color:#fff;padding:9px 12px;cursor:pointer}.filters button{background:#fff;color:#244f3f}.filters button.active{background:#244f3f;color:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card,aside{background:#fff;border:1px solid #dfe5ee;border-radius:8px;padding:14px}.price{color:#b54708;font-weight:700}ul{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}@media(max-width:760px){.shell{grid-template-columns:1fr}aside{order:3}}`;
  const js = `const items=[{name:'燕麦拿铁',category:'咖啡',price:28},{name:'冷萃咖啡',category:'咖啡',price:30},{name:'抹茶拿铁',category:'茶饮',price:26},{name:'柠檬红茶',category:'茶饮',price:22},{name:'巴斯克蛋糕',category:'甜品',price:32},{name:'可颂',category:'甜品',price:18}];let category='全部';let cart=[];const categoryBar=document.getElementById('categoryBar');const menuGrid=document.getElementById('menuGrid');const cartList=document.getElementById('cartList');const cartTotal=document.getElementById('cartTotal');function renderCategories(){categoryBar.innerHTML='';['全部',...new Set(items.map(item=>item.category))].forEach(name=>{const button=document.createElement('button');button.type='button';button.textContent=name;button.className=name===category?'active':'';button.onclick=()=>{category=name;render()};categoryBar.appendChild(button)})}function add(item){const found=cart.find(row=>row.name===item.name);if(found)found.qty+=1;else cart.push({...item,qty:1});renderCart()}function renderMenu(){menuGrid.innerHTML='';items.filter(item=>category==='全部'||item.category===category).forEach(item=>{const card=document.createElement('article');card.className='card';card.innerHTML='<h3></h3><p></p><p class="price"></p><button type="button">加入购物车</button>';card.querySelector('h3').textContent=item.name;card.querySelector('p').textContent=item.category;card.querySelector('.price').textContent='¥'+item.price;card.querySelector('button').onclick=()=>add(item);menuGrid.appendChild(card)})}function renderCart(){cartList.innerHTML='';let total=0;cart.forEach(item=>{total+=item.price*item.qty;const li=document.createElement('li');li.textContent=item.name+' × '+item.qty+' = ¥'+item.price*item.qty;cartList.appendChild(li)});cartTotal.textContent='¥'+total}function render(){renderCategories();renderMenu();renderCart()}render();`;
  return { ...request, title, body, css, js };
}

function buildKanbanHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const title = extractQuotedTopic(prompt, cleanText(request.title) || '销售线索 Kanban');
  const body = `<main class="shell">
  <header><h1>${xml(title)}</h1><form id="leadForm"><input id="leadInput" placeholder="新增线索"><button>添加</button></form></header>
  <section id="board" class="board"></section>
</main>`;
  const css = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#172033}.shell{width:min(1100px,calc(100vw - 32px));margin:24px auto}header{display:grid;grid-template-columns:1fr minmax(260px,420px);gap:12px;align-items:center;margin-bottom:16px}h1{font-size:24px;margin:0}form{display:grid;grid-template-columns:1fr auto;gap:8px}input{border:1px solid #ccd6e4;border-radius:6px;padding:10px 12px}button{border:1px solid #3451b2;border-radius:6px;background:#3451b2;color:#fff;padding:9px 12px;cursor:pointer}.board{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.column{background:#fff;border:1px solid #dfe7f2;border-radius:8px;padding:12px;min-height:240px}.column h2{font-size:16px;margin:0 0 10px}.card{border:1px solid #e5eaf2;border-radius:6px;padding:10px;margin-bottom:8px;background:#fbfcff}.actions{display:flex;gap:6px;margin-top:8px}.actions button{background:#fff;color:#3451b2}@media(max-width:760px){header,.board{grid-template-columns:1fr}}`;
  const js = `const statuses=['新线索','跟进中','已成交'];let leads=[{id:1,text:'华东制造业客户',status:'新线索'},{id:2,text:'连锁咖啡品牌',status:'跟进中'}];const board=document.getElementById('board');const form=document.getElementById('leadForm');const input=document.getElementById('leadInput');function move(lead,delta){const index=statuses.indexOf(lead.status);lead.status=statuses[Math.max(0,Math.min(statuses.length-1,index+delta))];render()}function render(){board.innerHTML='';statuses.forEach(status=>{const column=document.createElement('section');column.className='column';column.innerHTML='<h2></h2>';column.querySelector('h2').textContent=status;leads.filter(lead=>lead.status===status).forEach(lead=>{const card=document.createElement('article');card.className='card';card.innerHTML='<strong></strong><div class="actions"><button type="button">前移</button><button type="button">后移</button><button type="button">删除</button></div>';card.querySelector('strong').textContent=lead.text;const buttons=card.querySelectorAll('button');buttons[0].onclick=()=>move(lead,-1);buttons[1].onclick=()=>move(lead,1);buttons[2].onclick=()=>{leads=leads.filter(item=>item.id!==lead.id);render()};column.appendChild(card)});board.appendChild(column)})}form.onsubmit=event=>{event.preventDefault();const text=input.value.trim();if(!text)return;leads.unshift({id:Date.now()+Math.random(),text,status:'新线索'});input.value='';render()};render();`;
  return { ...request, title, body, css, js };
}

function buildPlannedHtmlApp(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  if (/咖啡|菜单|购物车|总价|分类/u.test(prompt)) return buildCoffeeMenuHtmlApp(request);
  if (/报名|表单|校验|成功状态/u.test(prompt)) return buildSignupHtmlApp(request);
  if (/kanban|看板|线索|拖动|切换状态|状态/u.test(prompt)) return buildKanbanHtmlApp(request);
  if (/灵感|标签|搜索|本地保存/u.test(prompt)) return buildIdeaCollectorHtmlApp(request);
  if (/todo|待办|任务|完成|删除|筛选/u.test(prompt)) return buildTodoHtmlApp(request);
  return buildTodoHtmlApp({
    ...request,
    title: extractQuotedTopic(prompt, cleanText(request.title) || '灵感收集小工具'),
  });
}

function buildPlannedCopywriting(request: LocalArtifactCreateRequest): LocalArtifactCreateRequest {
  const prompt = sourcePrompt(request);
  const topic = extractQuotedTopic(prompt, cleanText(request.title) || '产品宣传文案');
  return {
    ...request,
    title: topic,
    content: normalizeParagraph(prompt)
      ? `围绕「${topic}」，这份文案强调清晰目标、快速执行和可验证交付。它适合用作首版宣传稿，后续可以根据品牌语气继续润色。`
      : undefined,
    sections: [
      { title: '主标题', paragraphs: [`${topic}，让想法更快变成能交付的结果。`] },
      { title: '核心卖点', bullets: ['自动拆解复杂任务', '多类型产物统一交付', '交付前保留验证证据'] },
      { title: '短文案', paragraphs: ['从一句需求到一组可用产物，UClaw 帮你把创意、数据、页面和内容连成完整工作流。'] },
    ],
  };
}

function planLocalArtifactRequest(request: LocalArtifactCreateRequest): { request: LocalArtifactCreateRequest; mode: LocalArtifactPlanningMode; summary: string } {
  if (hasOwnContent(request)) {
    return {
      request,
      mode: request.planningMode ?? 'provided',
      summary: cleanText(request.planningSummary) || '使用调用方提供的结构化内容生成产物。',
    };
  }
  const prompt = sourcePrompt(request);
  if (!prompt) {
    return { request, mode: 'fallback-template', summary: '没有可用 prompt，使用内置保底模板。' };
  }
  if (request.kind === 'presentation') {
    return { request: buildPlannedPresentation(request), mode: 'prompt-heuristic', summary: '已根据 prompt 规划 PPT 页纲与要点。' };
  }
  if (request.kind === 'spreadsheet') {
    return { request: buildPlannedSpreadsheet(request), mode: 'prompt-heuristic', summary: '已根据 prompt 规划工作表、字段、样例数据和公式。' };
  }
  if (request.kind === 'mini_program') {
    return { request: buildPlannedHtmlApp(request), mode: 'prompt-heuristic', summary: '已根据 prompt 规划可运行 HTML 小程序交互。' };
  }
  return { request: buildPlannedCopywriting(request), mode: 'prompt-heuristic', summary: '已根据 prompt 规划文案结构。' };
}

function normalizeSlides(request: LocalArtifactCreateRequest): PresentationSlide[] {
  const title = cleanText(request.title) || 'AI 工作流效率提升';
  const inputSlides = Array.isArray(request.slides) ? request.slides : [];
  const slides = inputSlides.length > 0 ? inputSlides : [
    { title, subtitle: '未来城市里的个人效率工作台' },
    { title: '目标', bullets: ['把重复工作交给自动化', '让创意、数据和交付流转更顺畅'] },
    { title: '核心流程', bullets: ['输入目标', '拆解任务', '生成产物', '验证并交付'] },
    { title: '收益', bullets: ['减少等待', '降低返工', '形成可复用模板'] },
    { title: '下一步', bullets: ['接入团队素材', '沉淀标准工作流', '按场景持续优化'] },
  ];
  return slides.map((slide, index) => ({
    title: cleanText(slide.title) || (index === 0 ? title : `第 ${index + 1} 页`),
    subtitle: cleanText(slide.subtitle),
    body: cleanText(slide.body),
    bullets: Array.isArray(slide.bullets) ? slide.bullets.map(cleanText).filter(Boolean) : [],
  }));
}

async function createPptxBuffer(request: LocalArtifactCreateRequest): Promise<Buffer> {
  const slides = normalizeSlides(request);
  const deckTitle = cleanText(request.title) || slides[0]?.title || 'UClaw PPT';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', presentationContentTypesXml(slides.length));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', target: 'docProps/app.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(deckTitle));
  zip.file('docProps/app.xml', presentationAppXml(slides.length));
  zip.file('ppt/presentation.xml', presentationXml(slides.length));
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((_, index) => ({ id: `rId${index + 2}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${index + 1}.xml` })),
  ]));
  zip.file('ppt/slideMasters/slideMaster1.xml', slideMasterXml());
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' },
  ]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml());
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' },
  ]));
  zip.file('ppt/theme/theme1.xml', themeXml());
  slides.forEach((slide, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, presentationSlideXml(slide, index, slides.length, deckTitle));
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, relsXml([
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    ]));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function columnName(index: number): string {
  let current = index + 1;
  let name = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function sanitizeSheetName(value: unknown, fallback: string): string {
  return cleanText(value)
    .replace(/[\\/*?:]/gu, ' ')
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .trim()
    .slice(0, 31) || fallback;
}

function uniqueSheetName(value: unknown, fallback: string, usedNames: Set<string>): string {
  const base = sanitizeSheetName(value, fallback);
  let candidate = base;
  for (let suffix = 2; usedNames.has(candidate.toLowerCase()); suffix += 1) {
    const suffixText = ` ${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffixText.length))}${suffixText}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function spreadsheetCellValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function spreadsheetColumnFormat(header: string, values: unknown[]): SpreadsheetCellFormat {
  if (/日期|时间|开始|结束|date|time/iu.test(header)) return 'date';
  if (/率|比例|占比|进度|完成度|percent|rate/iu.test(header)) return 'percent';
  if (/金额|收入|支出|预算|实际|差额|价格|单价|客单价|成本|费用|薪资|销售额|总价|amount|revenue|cost|price|budget/iu.test(header)) return 'currency';
  const numericValues = values
    .map(spreadsheetCellValue)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numericValues.length === 0) return 'text';
  return numericValues.every(Number.isInteger) ? 'integer' : 'decimal';
}

function spreadsheetDisplayText(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { formula?: unknown; value?: unknown };
    if (record.value !== undefined) return cleanText(record.value);
    if (record.formula !== undefined) return cleanText(record.formula);
  }
  return cleanText(value);
}

function spreadsheetTextWidth(value: string): number {
  return [...value].reduce((width, character) => width + ((character.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
}

function spreadsheetColumnWidth(header: string, values: unknown[]): number {
  const longest = Math.max(
    spreadsheetTextWidth(header),
    ...values.slice(0, 200).map((value) => spreadsheetTextWidth(spreadsheetDisplayText(value))),
  );
  return Math.min(42, Math.max(10, longest + 2));
}

function normalizeSheets(request: LocalArtifactCreateRequest): NormalizedSheet[] {
  const inputSheets = Array.isArray(request.sheets) && request.sheets.length > 0
    ? request.sheets
    : [{
        name: '月度预算',
        headers: ['分类', '预算', '实际', '差额'],
        rows: [
          ['房租', 4200, 4200, { formula: 'B2-C2', value: 0 }],
          ['餐饮', 2200, 1980, { formula: 'B3-C3', value: 220 }],
          ['交通', 600, 520, { formula: 'B4-C4', value: 80 }],
          ['学习', 800, 640, { formula: 'B5-C5', value: 160 }],
          ['合计', { formula: 'SUM(B2:B5)', value: 7800 }, { formula: 'SUM(C2:C5)', value: 7340 }, { formula: 'SUM(D2:D5)', value: 460 }],
        ],
      }];
  const usedNames = new Set<string>();
  return inputSheets.map((sheet, index) => {
    const headers = Array.isArray(sheet.headers) ? sheet.headers.map(cleanText) : [];
    const rows = Array.isArray(sheet.rows)
      ? sheet.rows.map((row) => (Array.isArray(row) ? row : [row]))
      : [];
    const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
    const columnValues = Array.from({ length: columnCount }, (_, columnIndex) => rows.map((row) => row[columnIndex]));
    return {
      name: uniqueSheetName(sheet.name, `Sheet${index + 1}`, usedNames),
      headers,
      rows,
      columnFormats: columnValues.map((values, columnIndex) => spreadsheetColumnFormat(headers[columnIndex] ?? '', values)),
      columnWidths: columnValues.map((values, columnIndex) => spreadsheetColumnWidth(headers[columnIndex] ?? '', values)),
    };
  });
}

function spreadsheetStyleId(format: SpreadsheetCellFormat, totalRow: boolean): number {
  const base: Record<SpreadsheetCellFormat, number> = {
    text: 2,
    integer: 3,
    decimal: 4,
    percent: 5,
    currency: 6,
    date: 7,
  };
  return base[format] + (totalRow ? 6 : 0);
}

function excelDateSerial(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 86400000) + 25569 : undefined;
}

function spreadsheetCellXml(
  rowIndex: number,
  columnIndex: number,
  value: unknown,
  format: SpreadsheetCellFormat,
  headerRow: boolean,
  totalRow: boolean,
): string {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
  const styleId = headerRow ? 1 : spreadsheetStyleId(format, totalRow);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { formula?: unknown; value?: unknown };
    const formula = typeof record.formula === 'string'
      ? record.formula.trim().replace(/^=+\s*/u, '')
      : '';
    if (formula) {
      if (typeof record.value === 'number' && Number.isFinite(record.value)) {
        return `<c r="${ref}" s="${styleId}"><f>${xml(formula)}</f><v>${record.value}</v></c>`;
      }
      if (typeof record.value === 'boolean') {
        return `<c r="${ref}" s="${styleId}" t="b"><f>${xml(formula)}</f><v>${record.value ? 1 : 0}</v></c>`;
      }
      if (record.value !== undefined && record.value !== null) {
        return `<c r="${ref}" s="${styleId}" t="str"><f>${xml(formula)}</f><v>${xml(record.value)}</v></c>`;
      }
      return `<c r="${ref}" s="${styleId}"><f>${xml(formula)}</f></c>`;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${styleId}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" s="${styleId}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (format === 'date' && typeof value === 'string') {
    const serial = excelDateSerial(value);
    if (serial !== undefined) return `<c r="${ref}" s="${styleId}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function xlsxContentTypesXml(sheetCount: number): string {
  const worksheets = Array.from({ length: sheetCount }, (_, index) =>
    `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${worksheets}
</Types>`;
}

function workbookXml(sheets: Array<{ name: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="0"/>
  <sheets>
${sheets.map((sheet, index) => `    <sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
  </sheets>
  <calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
}

function worksheetXml(sheet: NormalizedSheet): string {
  const hasHeader = sheet.headers.length > 0;
  const rows = hasHeader ? [sheet.headers, ...sheet.rows] : sheet.rows;
  const safeRows = rows.length > 0 ? rows : [['项目', '数值'], ['示例', 1]];
  const columnCount = Math.max(...safeRows.map((row) => row.length), 1);
  const rowXml = safeRows.map((row, rowIndex) => {
    const headerRow = hasHeader && rowIndex === 0;
    const totalRow = !headerRow && /^(?:合计|总计|小计|汇总|total)$/iu.test(cleanText(row[0]));
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => spreadsheetCellXml(
      rowIndex,
      columnIndex,
      row[columnIndex] ?? '',
      sheet.columnFormats[columnIndex] ?? 'text',
      headerRow,
      totalRow,
    )).join('');
    return `    <row r="${rowIndex + 1}" ht="${headerRow ? 24 : 20}" customHeight="1">${cells}</row>`;
  }).join('\n');
  const endRef = `${columnName(columnCount - 1)}${safeRows.length}`;
  const columns = Array.from({ length: columnCount }, (_, columnIndex) => {
    const width = sheet.columnWidths[columnIndex] ?? 12;
    return `    <col min="${columnIndex + 1}" max="${columnIndex + 1}" width="${width}" customWidth="1"/>`;
  }).join('\n');
  const frozenHeader = hasHeader
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '<selection activeCell="A1" sqref="A1"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${endRef}"/>
  <sheetViews><sheetView workbookViewId="0">${frozenHeader}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
${columns}
  </cols>
  <sheetData>
${rowXml}
  </sheetData>
  ${hasHeader ? `<autoFilter ref="A1:${endRef}"/>` : ''}
  <pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
}

function spreadsheetStylesXml(): string {
  const cellXf = (numFmtId: number, fontId: number, fillId: number, borderId: number, alignment: string): string => (
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"${numFmtId ? ' applyNumberFormat="1"' : ''}><alignment ${alignment}/></xf>`
  );
  const baseFormats: Array<[number, number, number, number, string]> = [
    [0, 0, 0, 0, 'vertical="center"'],
    [0, 1, 2, 1, 'horizontal="center" vertical="center" wrapText="1"'],
    [0, 0, 0, 1, 'vertical="center" wrapText="1"'],
    [3, 0, 0, 1, 'horizontal="right" vertical="center"'],
    [166, 0, 0, 1, 'horizontal="right" vertical="center"'],
    [164, 0, 0, 1, 'horizontal="right" vertical="center"'],
    [165, 0, 0, 1, 'horizontal="right" vertical="center"'],
    [167, 0, 0, 1, 'horizontal="center" vertical="center"'],
  ];
  const totalFormats = baseFormats.slice(2).map(([numFmtId, _fontId, _fillId, borderId, alignment]) => (
    [numFmtId, 2, 3, borderId, alignment] as [number, number, number, number, string]
  ));
  const xfs = [...baseFormats, ...totalFormats]
    .map(([numFmtId, fontId, fillId, borderId, alignment]) => cellXf(numFmtId, fontId, fillId, borderId, alignment))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="¥#,##0.00;[Red]-¥#,##0.00"/><numFmt numFmtId="166" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd"/></numFmts>
  <fonts count="3"><font><sz val="11"/><color rgb="FF172033"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FF172033"/><name val="Microsoft YaHei"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F4F1"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2EA"/></left><right style="thin"><color rgb="FFD9E2EA"/></right><top style="thin"><color rgb="FFD9E2EA"/></top><bottom style="thin"><color rgb="FFD9E2EA"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">${xfs}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

async function createXlsxBuffer(request: LocalArtifactCreateRequest): Promise<Buffer> {
  const sheets = normalizeSheets(request);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xlsxContentTypesXml(sheets.length));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'xl/workbook.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', target: 'docProps/app.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(cleanText(request.title) || 'UClaw Excel'));
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>UClaw</Application></Properties>`);
  zip.file('xl/workbook.xml', workbookXml(sheets));
  zip.file('xl/_rels/workbook.xml.rels', relsXml([
    ...sheets.map((_, index) => ({
      id: `rId${index + 1}`,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
      target: `worksheets/sheet${index + 1}.xml`,
    })),
    {
      id: `rId${sheets.length + 1}`,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      target: 'styles.xml',
    },
  ]));
  zip.file('xl/styles.xml', spreadsheetStylesXml());
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderText(request: LocalArtifactCreateRequest): string {
  const title = cleanText(request.title) || '产品宣传文案';
  const content = cleanText(request.content);
  const sections = (request.sections ?? []).filter((section) => (
    cleanText(section.title)
    || (section.paragraphs ?? []).some((paragraph) => Boolean(cleanText(paragraph)))
    || (section.bullets ?? []).some((bullet) => Boolean(cleanText(bullet)))
  ));
  const lines = [`# ${title}`, ''];
  if (content) {
    if (sections.length === 0) lines.push('## 正文', '');
    lines.push(content, '');
  } else if (sections.length === 0) {
    lines.push(
      '## 核心主张',
      '',
      `${title}，从一个清晰目标开始，把真正重要的信息讲明白。`,
      '',
      '## 表达要点',
      '',
      '- 明确受众正在面对的问题',
      '- 给出具体价值与行动理由',
      '- 用一致语气完成收束',
      '',
    );
  }
  for (const section of sections) {
    const sectionTitle = cleanText(section.title);
    if (sectionTitle) lines.push(`## ${sectionTitle}`, '');
    for (const paragraph of section.paragraphs ?? []) {
      const normalized = cleanText(paragraph);
      if (normalized) lines.push(normalized, '');
    }
    for (const bullet of section.bullets ?? []) {
      const normalized = cleanText(bullet);
      if (normalized) lines.push(`- ${normalized}`);
    }
    if ((section.bullets?.length ?? 0) > 0) lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n');
}

function renderHtml(request: LocalArtifactCreateRequest): string {
  const rawHtml = rawText(request.html);
  const rawIsFullDocument = /<!doctype html|<html[\s>]/iu.test(rawHtml);
  const hasStructuredParts = Boolean(rawText(request.body) || rawText(request.css) || rawText(request.js));
  const rawBody = rawIsFullDocument ? extractHtmlBody(rawHtml) : '';
  const rawBodyText = textFromMarkup(rawBody);
  const rawBodyElementCount = countBodyElements(rawBody);
  const rawFullDocumentHasBody = rawIsFullDocument
    && rawBody.trim().length > 0
    && (rawBodyText.length >= 4 || rawBodyElementCount >= 2);
  if (rawHtml && (!rawIsFullDocument || !hasStructuredParts || rawFullDocumentHasBody)) return rawHtml;
  const title = cleanText(request.title) || '灵感收集 Todo';
  const body = (rawIsFullDocument ? '' : rawHtml) || rawText(request.body) || '<main><section class="panel"><h1>灵感收集 Todo</h1><form id="form"><input id="input" placeholder="写下一条任务或灵感" autocomplete="off"><button>添加</button></form><ul id="list"></ul></section></main>';
  const css = rawText(request.css) || 'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7fb;color:#111827}main{min-height:100vh;display:grid;place-items:center;padding:24px}.panel{width:min(720px,100%);background:white;border:1px solid #e5e7eb;border-radius:8px;padding:24px;box-shadow:0 12px 32px rgba(15,23,42,.08)}h1{font-size:24px;margin:0 0 16px}form{display:flex;gap:8px}input{flex:1;border:1px solid #d1d5db;border-radius:6px;padding:10px 12px;font-size:15px}button{border:0;border-radius:6px;background:#2563eb;color:white;padding:10px 14px;font-size:15px}ul{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;align-items:center;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px}li.done span{text-decoration:line-through;color:#6b7280}.remove{background:#f3f4f6;color:#374151}';
  const js = rawText(request.js) || 'const form=document.querySelector("#form");const input=document.querySelector("#input");const list=document.querySelector("#list");const seed=["整理今天的三个灵感","给项目写一个开场文案","检查本周预算"];function add(text){const li=document.createElement("li");li.innerHTML=`<span>${text}</span><button class="remove" type="button">完成</button>`;li.querySelector(".remove").onclick=()=>li.classList.toggle("done");list.appendChild(li)}seed.forEach(add);form.onsubmit=e=>{e.preventDefault();const text=input.value.trim();if(!text)return;add(text);input.value=""};';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(title)}</title>
  <style>${BASE_HTML_APP_CSS}
${css}</style>
</head>
<body>
${body}
<script>${js}</script>
</body>
</html>
`;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function uniqueCount(values: string[]): number {
  return new Set(values.map((value) => value.trim()).filter(Boolean)).size;
}

function presentationShapesFromXml(xmlText: string): Array<{ name: string; texts: string[] }> {
  return [...xmlText.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/gu)].map((match) => {
    const shapeXml = match[0];
    const name = decodeXmlText(shapeXml.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/u)?.[1] ?? '');
    const texts = [...shapeXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gu)]
      .map((textMatch) => decodeXmlText(textMatch[1] ?? ''))
      .map(cleanText)
      .filter(Boolean);
    return { name, texts };
  });
}

function presentationRoleFromShapes(shapes: Array<{ name: string }>): PresentationSlideRole | undefined {
  const names = shapes.map((shape) => shape.name);
  if (names.some((name) => name === 'UClaw Cover Title')) return 'cover';
  if (names.some((name) => name.startsWith('UClaw Agenda Item'))) return 'agenda';
  if (names.some((name) => name === 'UClaw Section Accent')) return 'section';
  if (names.some((name) => name === 'UClaw Content Accent')) return 'content';
  return undefined;
}

async function validatePresentationBuffer(buffer: Buffer, request: LocalArtifactCreateRequest): Promise<LocalArtifactVerificationResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideEntries = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
      .sort((left, right) => {
        const leftIndex = Number.parseInt(left.match(/slide(\d+)\.xml/u)?.[1] ?? '0', 10);
        const rightIndex = Number.parseInt(right.match(/slide(\d+)\.xml/u)?.[1] ?? '0', 10);
        return leftIndex - rightIndex;
      });
    const slides = await Promise.all(slideEntries.map(async (entry) => {
      const xmlText = await zip.file(entry)?.async('string');
      const shapes = presentationShapesFromXml(xmlText ?? '');
      const role = presentationRoleFromShapes(shapes);
      const titleShape = shapes.find((shape) => shape.name === 'UClaw Cover Title' || shape.name === 'UClaw Title');
      const contentShapes = shapes.filter((shape) => (
        shape.name === 'UClaw Cover Subtitle'
        || shape.name === 'UClaw Cover Summary'
        || shape.name === 'UClaw Section Summary'
        || shape.name === 'UClaw Content Lead'
        || /^UClaw Content \d+$/u.test(shape.name)
        || shape.name.startsWith('UClaw Agenda Item')
      ));
      return {
        role,
        title: titleShape?.texts.join(' ') ?? '',
        contentLines: contentShapes.flatMap((shape) => shape.texts).filter((text) => !/^\d{2}$/u.test(text)),
      };
    }));
    const titles = slides.map((slide) => slide.title);
    const contentLines = slides.flatMap((slide) => slide.contentLines);
    const emptySlides = slides.filter((slide) => !slide.title || (slide.role !== 'cover' && slide.role !== 'section' && slide.contentLines.join('').length < 16)).length;
    const placeholderLines = [...titles, ...contentLines].filter(isPlaceholderLine);
    const overfullSlides = slides.filter((slide) => (
      slide.contentLines.join('').length > 1800 || slide.contentLines.some((line) => line.length > 500)
    )).length;
    const substantiveLines = contentLines.filter((line) => line.length >= 8 && !isPlaceholderLine(line));
    const repeatedContent = substantiveLines.length > 2 && uniqueCount(substantiveLines) / substantiveLines.length < 0.6;
    const expectedSlides = parseRequestedCount(sourcePrompt(request), '页');
    const countMatches = expectedSlides === undefined || expectedSlides === slideEntries.length;
    const hasMeaningfulTitles = titles.length > 0 && uniqueCount(titles) >= Math.min(titles.length, 3);
    const coverCount = slides.filter((slide) => slide.role === 'cover').length;
    const agendaCount = slides.filter((slide) => slide.role === 'agenda').length;
    const sectionCount = slides.filter((slide) => slide.role === 'section').length;
    const contentCount = slides.filter((slide) => slide.role === 'content').length;
    const allSlidesHaveLayout = slides.every((slide) => Boolean(slide.role));
    const hasHierarchy = slideEntries.length === 1
      ? slides[0]?.contentLines.join('').length >= 16
      : coverCount === 1 && contentCount + agendaCount > 0;
    const passed = hasTaskContext(request)
      && slideEntries.length > 0
      && emptySlides === 0
      && placeholderLines.length === 0
      && overfullSlides === 0
      && !repeatedContent
      && hasMeaningfulTitles
      && countMatches
      && coverCount === 1
      && allSlidesHaveLayout
      && hasHierarchy;
    return {
      status: passed ? 'passed' : 'blocked',
      kind: 'artifact.content',
      required: true,
      severity: passed ? 'info' : 'blocking',
      detail: passed
        ? `PPT 成品验证通过：已读回 ${slideEntries.length} 页，封面、章节层次、内容密度和版式标记完整。`
        : 'PPT 成品验证未通过：存在缺失版式、空泛内容、重复正文、文字过载或页数不匹配。',
      evidence: [
        `slides=${slideEntries.length}`,
        expectedSlides ? `expectedSlides=${expectedSlides}` : undefined,
        `emptySlides=${emptySlides}`,
        `roles=cover:${coverCount},agenda:${agendaCount},section:${sectionCount},content:${contentCount}`,
        `layoutComplete=${allSlidesHaveLayout}`,
        `hierarchy=${hasHierarchy}`,
        `placeholderLines=${placeholderLines.slice(0, 5).join(' / ') || 'none'}`,
        `overfullSlides=${overfullSlides}`,
        `repeatedContent=${repeatedContent}`,
        `taskContext=${hasTaskContext(request)}`,
        `titles=${titles.slice(0, 8).join(' / ')}`,
      ].filter(Boolean).join('; '),
    };
  } catch (error) {
    return {
      status: 'failed',
      kind: 'artifact.content',
      required: true,
      severity: 'blocking',
      detail: 'PPT 文件无法按 OpenXML 包读回。',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateSpreadsheetBuffer(buffer: Buffer, request: LocalArtifactCreateRequest): Promise<LocalArtifactVerificationResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const workbookXmlText = await zip.file('xl/workbook.xml')?.async('string');
    const workbookRelsText = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    const stylesText = await zip.file('xl/styles.xml')?.async('string');
    const sheetNames = [...(workbookXmlText ?? '').matchAll(/<sheet[^>]*name="([^"]+)"/gu)]
      .map((match) => decodeXmlText(match[1] ?? ''))
      .filter(Boolean);
    const worksheetEntries = Object.keys(zip.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
      .sort((left, right) => Number.parseInt(left.match(/sheet(\d+)/u)?.[1] ?? '0', 10) - Number.parseInt(right.match(/sheet(\d+)/u)?.[1] ?? '0', 10));
    let formulaCount = 0;
    let rowCount = 0;
    let dataRowCount = 0;
    let numericStyleCellCount = 0;
    let percentStyleCellCount = 0;
    let currencyStyleCellCount = 0;
    let dateStyleCellCount = 0;
    const formulaCells: string[] = [];
    const invalidFormulas: string[] = [];
    const placeholderCells: string[] = [];
    const headersBySheet: string[][] = [];
    let structuredSheetCount = 0;
    for (const entry of worksheetEntries) {
      const worksheetText = await zip.file(entry)?.async('string');
      const xmlText = worksheetText ?? '';
      const rows = [...xmlText.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)];
      const firstRowXml = rows[0]?.[1] ?? '';
      const headerCells = [...firstRowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)];
      const headers = headerCells.map((match) => {
        const cellText = match[2]?.match(/<t\b[^>]*>([\s\S]*?)<\/t>/u)?.[1] ?? '';
        return cleanText(decodeXmlText(cellText));
      });
      headersBySheet.push(headers);
      const uniqueHeaders = uniqueCount(headers);
      const headerStyled = headerCells.length > 0 && headerCells.every((match) => /(?:^|\s)s="1"(?:\s|$)/u.test(match[1] ?? ''));
      const hasFrozenHeader = /<pane\b[^>]*\bySplit="1"[^>]*\bstate="frozen"/u.test(xmlText);
      const columnWidthCount = [...xmlText.matchAll(/<col\b[^>]*\bcustomWidth="1"/gu)].length;
      const hasAutoFilter = /<autoFilter\b[^>]*\bref="A1:/u.test(xmlText);
      if (headers.length >= 2
        && headers.every(Boolean)
        && uniqueHeaders === headers.length
        && rows.length >= 2
        && headerStyled
        && hasFrozenHeader
        && columnWidthCount >= headers.length
        && hasAutoFilter) {
        structuredSheetCount += 1;
      }
      const formulas = [...xmlText.matchAll(/<c\b[^>]*\br="([^"]+)"[^>]*>[\s\S]*?<\/c>/gu)]
        .map((match) => {
          const formula = match[0].match(/<f>([\s\S]*?)<\/f>/u)?.[1];
          return formula ? { ref: match[1] ?? '', formula } : null;
        })
        .filter((item): item is { ref: string; formula: string } => Boolean(item));
      formulaCount += formulas.length;
      for (const item of formulas) {
        const formula = decodeXmlText(item.formula).trim();
        formulaCells.push(`${item.ref}=${formula}`);
        const references = formula.includes('!')
          ? []
          : [...formula.matchAll(/\$?([A-Z]{1,3})\$?(\d+)/gu)];
        const invalidReference = references.some((reference) => (
          Number.parseInt(reference[2] ?? '0', 10) < 1
        ));
        if (!formula || /^=/u.test(formula) || /#(?:REF|NAME|VALUE|DIV\/0)!?/iu.test(formula) || invalidReference) {
          invalidFormulas.push(`${item.ref}=${formula}`);
        }
      }
      const textCells = [...xmlText.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
        .map((match) => cleanText(decodeXmlText(match[1] ?? '')))
        .filter(Boolean);
      placeholderCells.push(...textCells.filter(isPlaceholderLine));
      numericStyleCellCount += [...xmlText.matchAll(/<c\b[^>]*\bs="(?:3|4|5|6|7|9|10|11|12|13)"/gu)].length;
      percentStyleCellCount += [...xmlText.matchAll(/<c\b[^>]*\bs="(?:5|11)"/gu)].length;
      currencyStyleCellCount += [...xmlText.matchAll(/<c\b[^>]*\bs="(?:6|12)"/gu)].length;
      dateStyleCellCount += [...xmlText.matchAll(/<c\b[^>]*\bs="(?:7|13)"/gu)].length;
      rowCount += rows.length;
      dataRowCount += Math.max(0, rows.length - 1);
    }
    const prompt = sourcePrompt(request);
    const requestHasFormula = (request.sheets ?? []).some((sheet) => (sheet.rows ?? []).some((row) => row.some((cell) => (
      Boolean(cell && typeof cell === 'object' && !Array.isArray(cell) && cleanText((cell as { formula?: unknown }).formula))
    ))));
    const requestHasNumericValue = (request.sheets ?? []).some((sheet) => (sheet.rows ?? []).some((row) => row.some((cell) => {
      const value = spreadsheetCellValue(cell);
      return typeof value === 'number' && Number.isFinite(value);
    })));
    const allHeaders = headersBySheet.flat();
    const expectsFormula = requestHasFormula || /公式|合计|差额|完成率|转化率|预计收入|预算|实际|率/u.test(prompt);
    const expectsPercent = allHeaders.some((header) => /率|比例|占比|进度|完成度|percent|rate/iu.test(header));
    const expectsCurrency = allHeaders.some((header) => /金额|收入|支出|预算|实际|差额|价格|单价|客单价|成本|费用|销售额|总价/iu.test(header));
    const expectsDate = allHeaders.some((header) => /日期|时间|开始|结束|date|time/iu.test(header));
    const expectsNumeric = requestHasNumericValue || requestHasFormula || expectsPercent || expectsCurrency;
    const expectedRows = parseRequestedCount(prompt, '条');
    const rowCountMatches = expectedRows === undefined || dataRowCount >= expectedRows;
    const hasStylesRelationship = /relationships\/styles/iu.test(workbookRelsText ?? '');
    const hasNumberFormats = /<numFmts\b[^>]*\bcount="4"/u.test(stylesText ?? '');
    const hasAutomaticCalculation = /<calcPr\b[^>]*\bcalcMode="auto"[^>]*\bfullCalcOnLoad="1"/u.test(workbookXmlText ?? '');
    const passed = hasTaskContext(request)
      && sheetNames.length > 0
      && worksheetEntries.length === sheetNames.length
      && structuredSheetCount === sheetNames.length
      && dataRowCount >= sheetNames.length
      && rowCountMatches
      && placeholderCells.length === 0
      && invalidFormulas.length === 0
      && (!expectsFormula || formulaCount > 0)
      && (formulaCount === 0 || hasAutomaticCalculation)
      && hasStylesRelationship
      && hasNumberFormats
      && (!expectsNumeric || numericStyleCellCount > 0)
      && (!expectsPercent || percentStyleCellCount > 0)
      && (!expectsCurrency || currencyStyleCellCount > 0)
      && (!expectsDate || dateStyleCellCount > 0);
    return {
      status: passed ? 'passed' : 'blocked',
      kind: 'artifact.content',
      required: true,
      severity: passed ? 'info' : 'blocking',
      detail: passed
        ? `Excel 成品验证通过：${sheetNames.length} 个 sheet 均具备有效表头、列宽、冻结窗格、数值格式和可重算公式。`
        : 'Excel 成品验证未通过：表头/数据、列宽冻结、数值格式、公式引用或任务内容不满足要求。',
      evidence: [
        `sheets=${sheetNames.join(' / ')}`,
        `rows=${rowCount}`,
        `dataRows=${dataRowCount}`,
        expectedRows ? `expectedRows>=${expectedRows}` : undefined,
        `structuredSheets=${structuredSheetCount}/${sheetNames.length}`,
        `formulas=${formulaCount}`,
        formulaCells.length ? `formulaCells=${formulaCells.slice(0, 12).join(', ')}` : undefined,
        `invalidFormulas=${invalidFormulas.slice(0, 6).join(', ') || 'none'}`,
        `expectsFormula=${expectsFormula}`,
        `expectsNumeric=${expectsNumeric}`,
        `numericStyles=${numericStyleCellCount}`,
        `percentStyles=${percentStyleCellCount}`,
        `currencyStyles=${currencyStyleCellCount}`,
        `dateStyles=${dateStyleCellCount}`,
        `stylesRelationship=${hasStylesRelationship}`,
        `automaticCalculation=${hasAutomaticCalculation}`,
        `placeholderCells=${placeholderCells.slice(0, 5).join(' / ') || 'none'}`,
        `taskContext=${hasTaskContext(request)}`,
      ].filter(Boolean).join('; '),
    };
  } catch (error) {
    return {
      status: 'failed',
      kind: 'artifact.content',
      required: true,
      severity: 'blocking',
      detail: 'Excel 文件无法按 OpenXML 包读回。',
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//gu, '');
}

function extractHtmlBody(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1] ?? '';
}

function countBodyElements(markup: string): number {
  return [...markup.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu)]
    .filter((match) => !['script', 'style', 'template'].includes((match[1] ?? '').toLowerCase()))
    .length;
}

function textFromMarkup(markup: string): string {
  return cleanText(markup
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '));
}

function extractInlineScriptText(html: string): string {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/giu)]
    .map((match) => rawText(match[1] ?? ''))
    .filter(Boolean)
    .join('\n');
}

function extractInlineCssText(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)]
    .map((match) => rawText(match[1] ?? ''))
    .filter(Boolean)
    .join('\n');
}

function inlineScriptSyntaxError(script: string): string | undefined {
  if (!script) return 'empty script';
  try {
    Function(script);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function missingScriptElementReferences(html: string, script: string): string[] {
  const elementIds = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/giu)].map((match) => match[1] ?? ''));
  const referencedIds = [
    ...[...script.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1] ?? ''),
    ...[...script.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)["']\s*\)/gu)].map((match) => match[1] ?? ''),
  ].filter(Boolean);
  return [...new Set(referencedIds.filter((id) => !elementIds.has(id)))];
}

function markupTextSegments(markup: string): string[] {
  return markup
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .split(/<[^>]+>/gu)
    .map((segment) => cleanText(decodeXmlText(segment)))
    .filter(Boolean);
}

function htmlAttributeValue(attrs: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu'));
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function hasHtmlAttribute(attrs: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)${escapedName}(?:\\s|=|$)`, 'iu').test(attrs);
}

function htmlClassList(attrs: string): string[] {
  return (htmlAttributeValue(attrs, 'class') ?? '')
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function visibleDisplayValue(value: string): string | undefined {
  const display = value
    .replace(/!important/giu, '')
    .trim()
    .toLowerCase()
    .split(/\s+/u)[0];
  if (!display || display === 'none') return undefined;
  if (/^(?:block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|table-row|table-cell|flow-root|contents|list-item)$/u.test(display)) {
    return display;
  }
  return undefined;
}

function visibleDisplayFromDeclarations(declarations: string): string | undefined {
  const match = declarations.match(/(?:^|;)\s*display\s*:\s*([^;}]+)/iu);
  return match?.[1] ? visibleDisplayValue(match[1]) : undefined;
}

function cssIdent(value: string): string {
  return value.replace(/\\/gu, '').trim();
}

function rightmostSimpleSelector(selector: string): string {
  const withoutPseudo = selector.replace(/::?[\w-]+(?:\([^)]*\))?/gu, '');
  const parts = withoutPseudo.split(/\s+|>|\+|~/u).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? withoutPseudo.trim();
}

function selectorTargetsElement(selector: string, element: { tag: string; id?: string; classes: string[] }): boolean {
  const simple = rightmostSimpleSelector(selector);
  if (!simple) return false;
  if (/\[hidden(?:\]|[~|^$*]?=)/iu.test(simple)) return true;
  const ids = [...simple.matchAll(/#((?:\\.|[\w-])+)/gu)].map((match) => cssIdent(match[1] ?? ''));
  if (ids.length > 0 && (!element.id || ids.some((id) => id !== element.id))) return false;
  const classes = [...simple.matchAll(/\.((?:\\.|[\w-])+)/gu)].map((match) => cssIdent(match[1] ?? ''));
  if (classes.length > 0 && classes.some((item) => !element.classes.includes(item))) return false;
  const tag = simple.match(/^([a-z][\w-]*)/iu)?.[1]?.toLowerCase();
  if (tag && tag !== element.tag) return false;
  return ids.length > 0 || classes.length > 0 || Boolean(tag) || simple === '*';
}

function hiddenElementLabel(element: { tag: string; id?: string; classes: string[] }): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = element.classes.length ? `.${element.classes.slice(0, 3).join('.')}` : '';
  return `${element.tag}${id}${classes}`;
}

function detectHiddenDisplayOverrides(html: string): string[] {
  const hiddenElements = [...html.matchAll(/<([a-z][\w:-]*)([^<>]*)>/giu)]
    .map((match) => {
      const tag = (match[1] ?? '').toLowerCase();
      const attrs = match[2] ?? '';
      if (!hasHtmlAttribute(attrs, 'hidden')) return null;
      return {
        tag,
        attrs,
        id: htmlAttributeValue(attrs, 'id'),
        classes: htmlClassList(attrs),
      };
    })
    .filter((item): item is { tag: string; attrs: string; id: string | undefined; classes: string[] } => item !== null);
  if (hiddenElements.length === 0) return [];

  const overrides: string[] = [];
  for (const element of hiddenElements) {
    const inlineDisplay = visibleDisplayFromDeclarations(htmlAttributeValue(element.attrs, 'style') ?? '');
    if (inlineDisplay) {
      overrides.push(`${hiddenElementLabel(element)} inline display:${inlineDisplay}`);
    }
  }

  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)]
    .map((match) => stripCssComments(match[1] ?? ''));
  for (const css of styleBlocks) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const display = visibleDisplayFromDeclarations(rule[2] ?? '');
      if (!display) continue;
      const selectors = (rule[1] ?? '').split(',').map((selector) => selector.trim()).filter(Boolean);
      for (const selector of selectors) {
        for (const element of hiddenElements) {
          if (selectorTargetsElement(selector, element)) {
            overrides.push(`${hiddenElementLabel(element)} ${selector} display:${display}`);
          }
        }
      }
    }
  }

  return [...new Set(overrides)].slice(0, 8);
}

function validateHtmlContent(html: string, request: LocalArtifactCreateRequest, fileSize: number): LocalArtifactVerificationResult {
  const prompt = sourcePrompt(request);
  const normalizedHtml = cleanText(html);
  const bodyMarkup = extractHtmlBody(html);
  const bodyText = textFromMarkup(bodyMarkup);
  const bodyTextSegments = markupTextSegments(bodyMarkup);
  const bodyElementCount = countBodyElements(bodyMarkup);
  const inlineScriptText = extractInlineScriptText(html);
  const inlineCssText = extractInlineCssText(html);
  const scriptSyntaxError = inlineScriptSyntaxError(inlineScriptText);
  const missingElementReferences = missingScriptElementReferences(html, inlineScriptText);
  const placeholderSegments = bodyTextSegments.filter(isPlaceholderLine);
  const hiddenDisplayOverrides = detectHiddenDisplayOverrides(html);
  const fileSizeOk = fileSize >= MIN_HTML_FILE_SIZE_BYTES;
  const hasDocument = /<!doctype html|<html[\s>]/iu.test(html);
  const hasViewport = /<meta\b[^>]*\bname=["']viewport["'][^>]*>/iu.test(html);
  const hasBody = /<body[\s>]/iu.test(html);
  const hasHeading = /<h1\b[^>]*>[\s\S]*?<\/h1>/iu.test(bodyMarkup);
  const hasMeaningfulBody = bodyMarkup.trim().length > 0 && bodyText.length >= 12 && bodyElementCount >= 5;
  const hasScript = /<script[\s>]/iu.test(html);
  const hasRunnableScript = inlineScriptText.length >= 80 && !scriptSyntaxError && missingElementReferences.length === 0;
  const hasInlineStyle = inlineCssText.length >= 120;
  const hasInput = /<input[\s>]/iu.test(html);
  const buttonCount = [...html.matchAll(/<button\b/giu)].length;
  const controlCount = [...html.matchAll(/<(?:button|input|select|textarea)\b/giu)].length;
  const hasInteractiveControl = hasInput || buttonCount > 0 || /<(?:select|textarea)\b/iu.test(html);
  const hasEventBinding = /addEventListener\s*\(|\.(?:onclick|onsubmit|oninput|onchange)\s*=|\son(?:click|submit|input|change)\s*=/iu.test(html);
  const hasDomMutation = /\.(?:textContent|innerHTML|className|value)\s*=|\.(?:appendChild|append|prepend|remove|classList\.)/u.test(inlineScriptText);
  const hasInteractiveBehavior = hasEventBinding && hasDomMutation;
  const hasPersistence = /localStorage|sessionStorage/iu.test(html);
  const expectsDelete = /删除|delete|移除|remove/iu.test(prompt);
  const expectsFilter = /筛选|filter|分类|全部|完成/iu.test(prompt);
  const expectsSearch = /搜索|search/u.test(prompt);
  const expectsTags = /标签|tag/u.test(prompt);
  const expectsPersistence = /本地保存|保存|localStorage|local storage/u.test(prompt);
  const expectsValidation = /校验|验证|表单/u.test(prompt);
  const expectsSuccess = /成功状态|报名成功|成功/u.test(prompt);
  const expectsCart = /购物车|总价|cart/u.test(prompt);
  const expectsKanban = /kanban|看板|拖动|切换状态/u.test(prompt);
  const expectsList = /列表|清单|list/u.test(prompt);
  const hasDelete = !expectsDelete || /删除|delete|remove/iu.test(html);
  const hasFilter = !expectsFilter || /data-filter|filter|筛选|全部|进行中|已完成/iu.test(html);
  const hasSearch = !expectsSearch || /searchInput|搜索|oninput|includes/iu.test(html);
  const hasTags = !expectsTags || /tagInput|tagBar|标签|activeTag|#\+/iu.test(html);
  const hasRequiredPersistence = !expectsPersistence || hasPersistence;
  const hasValidation = !expectsValidation || /role="alert"|error\.textContent|onsubmit|preventDefault/iu.test(html);
  const hasSuccess = !expectsSuccess || /role="status"|success\.textContent|报名成功/iu.test(html);
  const hasCart = !expectsCart || /cartTotal|cartList|购物车|price|total/iu.test(html);
  const hasKanban = !expectsKanban || /board|column|statuses|move\(|切换|跟进中/iu.test(html);
  const hasList = !expectsList || /<ul\b|List|列表|list/iu.test(html);
  const hiddenDisplaySafe = hiddenDisplayOverrides.length === 0;
  const missing = [
    hasTaskContext(request) ? undefined : 'task context',
    fileSizeOk ? undefined : `fileSize<${MIN_HTML_FILE_SIZE_BYTES}`,
    hasDocument ? undefined : 'document',
    hasViewport ? undefined : 'viewport',
    hasBody ? undefined : 'body',
    hasHeading ? undefined : 'h1',
    hasMeaningfulBody ? undefined : 'meaningful body',
    hasScript ? undefined : 'script tag',
    hasRunnableScript ? undefined : 'runnable script',
    hasInlineStyle ? undefined : 'inline style',
    hasInteractiveControl ? undefined : 'interactive control',
    hasInteractiveBehavior ? undefined : 'interactive behavior',
    hiddenDisplaySafe ? undefined : 'hidden display override',
    placeholderSegments.length === 0 ? undefined : 'placeholder content',
    hasDelete ? undefined : 'delete behavior',
    hasFilter ? undefined : 'filter behavior',
    hasSearch ? undefined : 'search behavior',
    hasTags ? undefined : 'tag behavior',
    hasRequiredPersistence ? undefined : 'persistence',
    hasValidation ? undefined : 'validation behavior',
    hasSuccess ? undefined : 'success state',
    hasCart ? undefined : 'cart behavior',
    hasKanban ? undefined : 'kanban behavior',
    hasList ? undefined : 'list behavior',
  ].filter(Boolean);
  const passed = hasTaskContext(request)
    && fileSizeOk
    && hasDocument
    && hasViewport
    && hasBody
    && hasHeading
    && hasMeaningfulBody
    && hasScript
    && hasRunnableScript
    && hasInlineStyle
    && hasInteractiveControl
    && hasInteractiveBehavior
    && hiddenDisplaySafe
    && placeholderSegments.length === 0
    && hasDelete
    && hasFilter
    && hasSearch
    && hasTags
    && hasRequiredPersistence
    && hasValidation
    && hasSuccess
    && hasCart
    && hasKanban
    && hasList;
  return {
    status: passed ? 'passed' : 'blocked',
    kind: 'artifact.content',
    required: true,
      severity: passed ? 'info' : 'blocking',
      detail: passed
      ? 'HTML 小程序成品验证通过：页面结构、初始内容、样式、脚本语法、DOM 引用和任务交互均通过。'
      : `HTML 小程序内容验证未通过：${missing.length ? missing.join('、') : '缺少指定交互能力'}。`,
    evidence: [
      `fileSize=${fileSize}`,
      `fileSizeOk=${fileSizeOk}`,
      `htmlChars=${normalizedHtml.length}`,
      `hasDocument=${hasDocument}`,
      `hasViewport=${hasViewport}`,
      `hasBody=${hasBody}`,
      `bodyChars=${bodyText.length}`,
      `bodySegments=${bodyTextSegments.length}`,
      `bodyElements=${bodyElementCount}`,
      `hasHeading=${hasHeading}`,
      `hasMeaningfulBody=${hasMeaningfulBody}`,
      `hasScript=${hasScript}`,
      `inlineScriptChars=${inlineScriptText.length}`,
      `scriptSyntax=${scriptSyntaxError ?? 'valid'}`,
      `missingElementRefs=${missingElementReferences.join(', ') || 'none'}`,
      `hasRunnableScript=${hasRunnableScript}`,
      `inlineCssChars=${inlineCssText.length}`,
      `hasInlineStyle=${hasInlineStyle}`,
      `hasInput=${hasInput}`,
      `hasInteractiveControl=${hasInteractiveControl}`,
      `controlCount=${controlCount}`,
      `hasEventBinding=${hasEventBinding}`,
      `hasDomMutation=${hasDomMutation}`,
      `hasInteractiveBehavior=${hasInteractiveBehavior}`,
      `buttonCount=${buttonCount}`,
      `hiddenDisplaySafe=${hiddenDisplaySafe}`,
      `hiddenDisplayOverride=${hiddenDisplayOverrides.length ? hiddenDisplayOverrides.join(', ') : 'none'}`,
      `hasPersistence=${hasPersistence}`,
      `hasDelete=${hasDelete}`,
      `hasFilter=${hasFilter}`,
      `hasSearch=${hasSearch}`,
      `hasTags=${hasTags}`,
      `hasValidation=${hasValidation}`,
      `hasSuccess=${hasSuccess}`,
      `hasCart=${hasCart}`,
      `hasKanban=${hasKanban}`,
      `hasList=${hasList}`,
      `placeholderSegments=${placeholderSegments.join(' / ') || 'none'}`,
      `taskContext=${hasTaskContext(request)}`,
    ].join('; '),
  };
}

function validateTextContent(text: string, request: LocalArtifactCreateRequest): LocalArtifactVerificationResult {
  const headingCount = [...text.matchAll(/^#{1,3}\s+/gmu)].length;
  const sectionHeadingCount = [...text.matchAll(/^##\s+/gmu)].length;
  const bulletCount = [...text.matchAll(/^- /gmu)].length;
  const contentLines = text.split(/\r?\n/u)
    .map((line) => cleanText(line.replace(/^#{1,3}\s+|^-\s+/u, '')))
    .filter(Boolean);
  const headingLines = text.split(/\r?\n/u)
    .filter((line) => /^#{1,3}\s+/u.test(line))
    .map((line) => cleanText(line.replace(/^#{1,3}\s+/u, '')));
  const bodyLines = contentLines.filter((line) => !headingLines.includes(line));
  const placeholderLines = contentLines.filter(isPlaceholderLine);
  const substantiveLines = bodyLines.filter((line) => line.length >= 10 && !isPlaceholderLine(line));
  const repeatedLines = substantiveLines.length > 2 && uniqueCount(substantiveLines) / substantiveLines.length < 0.65;
  const bodyChars = cleanText(bodyLines.join(' ')).length;
  const expectedItems = parseRequestedCount(sourcePrompt(request), '条');
  const itemCountMatches = expectedItems === undefined || Math.max(bulletCount, substantiveLines.length) >= expectedItems;
  const hasEnoughSubstance = substantiveLines.length >= 2 || bodyChars >= 160;
  const passed = hasTaskContext(request)
    && cleanText(text).length >= 80
    && headingCount >= 2
    && sectionHeadingCount >= 1
    && hasEnoughSubstance
    && placeholderLines.length === 0
    && !repeatedLines
    && itemCountMatches;
  return {
    status: passed ? 'passed' : 'blocked',
    kind: 'artifact.content',
    required: true,
    severity: passed ? 'info' : 'blocking',
    detail: passed
      ? '文案成品验证通过：标题层级、正文密度、条目数量和非模板化内容均满足要求。'
      : '文案成品验证未通过：结构不完整、正文过短、内容重复、条目不足或仍含占位模板。',
    evidence: [
      `chars=${cleanText(text).length}`,
      `bodyChars=${bodyChars}`,
      `headings=${headingCount}`,
      `sectionHeadings=${sectionHeadingCount}`,
      `bullets=${bulletCount}`,
      `substantiveLines=${substantiveLines.length}`,
      expectedItems ? `expectedItems=${expectedItems}` : undefined,
      `itemCountMatches=${itemCountMatches}`,
      `repeatedLines=${repeatedLines}`,
      `placeholderLines=${placeholderLines.join(' / ') || 'none'}`,
      `taskContext=${hasTaskContext(request)}`,
    ].filter(Boolean).join('; '),
  };
}

export async function createLocalArtifact(request: LocalArtifactCreateRequest): Promise<LocalArtifactCreateResult> {
  const planned = planLocalArtifactRequest(request);
  const effectiveRequest = planned.request;
  const kind = effectiveRequest.kind;
  const planning = {
    mode: planned.mode,
    prompt: sourcePrompt(request) || undefined,
    summary: planned.summary,
  };
  if (kind === 'presentation') {
    const title = cleanText(effectiveRequest.title) || 'AI 工作流效率提升';
    const filePath = await uniqueOutputPath(title, effectiveRequest.filename, 'pptx', 'UClaw_PPT');
    const buffer = await createPptxBuffer({ ...effectiveRequest, title });
    await writeFile(filePath, buffer);
    const fileSize = statSync(filePath).size;
    const verification = await validatePresentationBuffer(buffer, effectiveRequest);
    return { kind: 'presentation', title, fileName: filePath.split(/[\\/]/u).pop() || 'presentation.pptx', filePath, fileSize, mimeType: MIME.pptx, media: `MEDIA:${filePath}`, planning, verification };
  }
  if (kind === 'spreadsheet') {
    const title = cleanText(effectiveRequest.title) || '月度预算表';
    const filePath = await uniqueOutputPath(title, effectiveRequest.filename, 'xlsx', 'UClaw_XLSX');
    const buffer = await createXlsxBuffer({ ...effectiveRequest, title });
    await writeFile(filePath, buffer);
    const fileSize = statSync(filePath).size;
    const verification = await validateSpreadsheetBuffer(buffer, effectiveRequest);
    return { kind: 'spreadsheet', title, fileName: filePath.split(/[\\/]/u).pop() || 'spreadsheet.xlsx', filePath, fileSize, mimeType: MIME.xlsx, media: `MEDIA:${filePath}`, planning, verification };
  }
  if (kind === 'mini_program') {
    const title = cleanText(effectiveRequest.title) || '灵感收集 Todo 小工具';
    const filePath = await uniqueOutputPath(title, effectiveRequest.filename, 'html', 'UClaw_HTML_App');
    const html = renderHtml({ ...effectiveRequest, title });
    await writeFile(filePath, html, 'utf8');
    const fileSize = statSync(filePath).size;
    const verification = validateHtmlContent(html, effectiveRequest, fileSize);
    return { kind: 'webpage', title, fileName: filePath.split(/[\\/]/u).pop() || 'app.html', filePath, fileSize, mimeType: MIME.html, media: `MEDIA:${filePath}`, planning, verification };
  }
  const title = cleanText(effectiveRequest.title) || '产品宣传文案';
  const filePath = await uniqueOutputPath(title, effectiveRequest.filename, 'md', 'UClaw_Text');
  const text = renderText({ ...effectiveRequest, title });
  await writeFile(filePath, text, 'utf8');
  const fileSize = statSync(filePath).size;
  const verification = validateTextContent(text, effectiveRequest);
  return { kind: 'document', title, fileName: filePath.split(/[\\/]/u).pop() || 'copywriting.md', filePath, fileSize, mimeType: MIME.md, media: `MEDIA:${filePath}`, planning, verification };
}
