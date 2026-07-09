import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { getOpenClawConfigDir } from './paths';

export type LocalArtifactKind = 'presentation' | 'spreadsheet' | 'mini_program' | 'copywriting';

export type LocalArtifactCreateRequest = {
  kind: LocalArtifactKind;
  title?: string;
  filename?: string;
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
};

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  html: 'text/html',
} as const;

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

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string, size: number, bold = false): string {
  const runs = cleanText(text)
    .split(/\n+/u)
    .filter(Boolean)
    .map((line) => `<a:p><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${xml(line)}</a:t></a:r></a:p>`)
    .join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${runs || '<a:p/>'}</p:txBody></p:sp>`;
}

function normalizeSlides(request: LocalArtifactCreateRequest): Array<{ title: string; subtitle?: string; body?: string; bullets: string[] }> {
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
  const zip = new JSZip();
  zip.file('[Content_Types].xml', presentationContentTypesXml(slides.length));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', target: 'docProps/app.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(cleanText(request.title) || slides[0]?.title || 'UClaw PPT'));
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
    const body = slide.bullets.length > 0
      ? slide.bullets.map((item) => `• ${item}`).join('\n')
      : slide.body || slide.subtitle || '可继续编辑补充内容。';
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${textBox(2, 'Title', 685800, 520000, 10800000, 950000, slide.title, index === 0 ? 4200 : 3200, true)}
    ${textBox(3, 'Body', 914400, 1700000, 10300000, 4200000, body, 2100)}
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml);
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

function cellXml(rowIndex: number, columnIndex: number, value: unknown): string {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { formula?: unknown; value?: unknown };
    if (typeof record.formula === 'string' && record.formula.trim()) {
      const fallback = typeof record.value === 'number' && Number.isFinite(record.value) ? `<v>${record.value}</v>` : '';
      return `<c r="${ref}"><f>${xml(record.formula)}</f>${fallback}</c>`;
    }
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
}

function normalizeSheets(request: LocalArtifactCreateRequest): Array<{ name: string; rows: unknown[][] }> {
  if (Array.isArray(request.sheets) && request.sheets.length > 0) {
    return request.sheets.map((sheet, index) => ({
      name: sanitizeBaseName(sheet.name, `Sheet${index + 1}`).slice(0, 31),
      rows: [
        ...(Array.isArray(sheet.headers) && sheet.headers.length > 0 ? [sheet.headers] : []),
        ...(Array.isArray(sheet.rows) ? sheet.rows : []),
      ],
    }));
  }
  return [{
    name: '月度预算',
    rows: [
      ['分类', '预算', '实际', '差额'],
      ['房租', 4200, 4200, { formula: 'B2-C2', value: 0 }],
      ['餐饮', 2200, 1980, { formula: 'B3-C3', value: 220 }],
      ['交通', 600, 520, { formula: 'B4-C4', value: 80 }],
      ['学习', 800, 640, { formula: 'B5-C5', value: 160 }],
      ['合计', { formula: 'SUM(B2:B5)', value: 7800 }, { formula: 'SUM(C2:C5)', value: 7340 }, { formula: 'SUM(D2:D5)', value: 460 }],
    ],
  }];
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
  <sheets>
${sheets.map((sheet, index) => `    <sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
  </sheets>
</workbook>`;
}

function worksheetXml(rows: unknown[][]): string {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : [row]).map((cell, columnIndex) => cellXml(rowIndex, columnIndex, cell)).join('');
    return `    <row r="${rowIndex + 1}">${cells}</row>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${rowXml}
  </sheetData>
</worksheet>`;
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
  zip.file('xl/_rels/workbook.xml.rels', relsXml(sheets.map((_, index) => ({
    id: `rId${index + 1}`,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
    target: `worksheets/sheet${index + 1}.xml`,
  }))));
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows.length > 0 ? sheet.rows : [['项目', '数值'], ['示例', 1]]));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function renderText(request: LocalArtifactCreateRequest): string {
  const title = cleanText(request.title) || '产品宣传文案';
  const content = cleanText(request.content) || '未来城市里的个人效率工作台，把创意、数据和执行串成一条清晰工作流。它能自动拆解任务、生成多种产物，并在交付前完成基础验证，让灵感更快变成可以分享和使用的结果。';
  const lines = [`# ${title}`, '', content, ''];
  for (const section of request.sections ?? []) {
    const sectionTitle = cleanText(section.title);
    if (sectionTitle) lines.push(`## ${sectionTitle}`, '');
    for (const paragraph of section.paragraphs ?? []) lines.push(cleanText(paragraph), '');
    for (const bullet of section.bullets ?? []) lines.push(`- ${cleanText(bullet)}`);
    if ((section.bullets?.length ?? 0) > 0) lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n');
}

function renderHtml(request: LocalArtifactCreateRequest): string {
  if (cleanText(request.html)) return cleanText(request.html);
  const title = cleanText(request.title) || '灵感收集 Todo';
  const body = request.body || '<main><section class="panel"><h1>灵感收集 Todo</h1><form id="form"><input id="input" placeholder="写下一条任务或灵感" autocomplete="off"><button>添加</button></form><ul id="list"></ul></section></main>';
  const css = request.css || 'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7fb;color:#111827}main{min-height:100vh;display:grid;place-items:center;padding:24px}.panel{width:min(720px,100%);background:white;border:1px solid #e5e7eb;border-radius:8px;padding:24px;box-shadow:0 12px 32px rgba(15,23,42,.08)}h1{font-size:24px;margin:0 0 16px}form{display:flex;gap:8px}input{flex:1;border:1px solid #d1d5db;border-radius:6px;padding:10px 12px;font-size:15px}button{border:0;border-radius:6px;background:#2563eb;color:white;padding:10px 14px;font-size:15px}ul{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;align-items:center;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px}li.done span{text-decoration:line-through;color:#6b7280}.remove{background:#f3f4f6;color:#374151}';
  const js = request.js || 'const form=document.querySelector("#form");const input=document.querySelector("#input");const list=document.querySelector("#list");const seed=["整理今天的三个灵感","给项目写一个开场文案","检查本周预算"];function add(text){const li=document.createElement("li");li.innerHTML=`<span>${text}</span><button class="remove" type="button">完成</button>`;li.querySelector(".remove").onclick=()=>li.classList.toggle("done");list.appendChild(li)}seed.forEach(add);form.onsubmit=e=>{e.preventDefault();const text=input.value.trim();if(!text)return;add(text);input.value=""};';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(title)}</title>
  <style>${css}</style>
</head>
<body>
${body}
<script>${js}</script>
</body>
</html>
`;
}

export async function createLocalArtifact(request: LocalArtifactCreateRequest): Promise<LocalArtifactCreateResult> {
  const kind = request.kind;
  if (kind === 'presentation') {
    const title = cleanText(request.title) || 'AI 工作流效率提升';
    const filePath = await uniqueOutputPath(title, request.filename, 'pptx', 'UClaw_PPT');
    await writeFile(filePath, await createPptxBuffer({ ...request, title }));
    const fileSize = statSync(filePath).size;
    return { kind: 'presentation', title, fileName: filePath.split(/[\\/]/u).pop() || 'presentation.pptx', filePath, fileSize, mimeType: MIME.pptx, media: `MEDIA:${filePath}` };
  }
  if (kind === 'spreadsheet') {
    const title = cleanText(request.title) || '月度预算表';
    const filePath = await uniqueOutputPath(title, request.filename, 'xlsx', 'UClaw_XLSX');
    await writeFile(filePath, await createXlsxBuffer({ ...request, title }));
    const fileSize = statSync(filePath).size;
    return { kind: 'spreadsheet', title, fileName: filePath.split(/[\\/]/u).pop() || 'spreadsheet.xlsx', filePath, fileSize, mimeType: MIME.xlsx, media: `MEDIA:${filePath}` };
  }
  if (kind === 'mini_program') {
    const title = cleanText(request.title) || '灵感收集 Todo 小工具';
    const filePath = await uniqueOutputPath(title, request.filename, 'html', 'UClaw_HTML_App');
    await writeFile(filePath, renderHtml({ ...request, title }), 'utf8');
    const fileSize = statSync(filePath).size;
    return { kind: 'webpage', title, fileName: filePath.split(/[\\/]/u).pop() || 'app.html', filePath, fileSize, mimeType: MIME.html, media: `MEDIA:${filePath}` };
  }
  const title = cleanText(request.title) || '产品宣传文案';
  const filePath = await uniqueOutputPath(title, request.filename, 'md', 'UClaw_Text');
  await writeFile(filePath, renderText({ ...request, title }), 'utf8');
  const fileSize = statSync(filePath).size;
  return { kind: 'document', title, fileName: filePath.split(/[\\/]/u).pop() || 'copywriting.md', filePath, fileSize, mimeType: MIME.md, media: `MEDIA:${filePath}` };
}
