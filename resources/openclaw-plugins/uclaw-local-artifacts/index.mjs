import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'uclaw-local-artifacts';
const DEFAULT_OUTPUT_DIR = 'outputs';
const EMU_PER_INCH = 914400;
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
};
const BASE_HTML_APP_CSS = '[hidden]{display:none!important}';

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(value) {
  return normalizeBrandText(value).replace(/\s+/gu, ' ').trim();
}

function normalizeBrandText(value) {
  return String(value ?? '').replace(/clawx/giu, 'UClaw');
}

function normalizeBrandValue(value) {
  if (typeof value === 'string') return normalizeBrandText(value);
  if (Array.isArray(value)) return value.map(normalizeBrandValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeBrandValue(item)]),
    );
  }
  return value;
}

function textList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean);
}

function compactTimestamp(date = new Date()) {
  return date.toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '')
    .replace(/[TZ]/gu, '-')
    .replace(/-$/u, '');
}

function sanitizeBaseName(value, fallback) {
  const normalized = cleanText(value)
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/gu, '');
  return normalized || fallback;
}

function withExtension(fileName, extension) {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return fileName.toLowerCase().endsWith(ext.toLowerCase()) ? fileName : `${fileName}${ext}`;
}

function resolveWorkspaceDir(ctx) {
  const cwd = typeof ctx?.cwd === 'string' && ctx.cwd.trim() ? ctx.cwd : '';
  if (cwd) return path.resolve(cwd);
  const openClawHome = process.env.OPENCLAW_HOME && process.env.OPENCLAW_HOME.trim()
    ? process.env.OPENCLAW_HOME.trim()
    : path.join(homedir(), '.openclaw');
  return path.join(openClawHome, 'workspace');
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function resolveOutputDir(ctx, requested) {
  const workspaceDir = resolveWorkspaceDir(ctx);
  const raw = cleanText(requested);
  if (!raw) return path.join(workspaceDir, DEFAULT_OUTPUT_DIR);
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspaceDir, expanded);
}

async function uniqueOutputPath(ctx, params, extension, fallbackName) {
  const outputDir = resolveOutputDir(ctx, params?.outputDir);
  await mkdir(outputDir, { recursive: true });
  const requested = cleanText(params?.filename);
  const base = requested
    ? sanitizeBaseName(path.basename(requested, path.extname(requested)), fallbackName)
    : `${sanitizeBaseName(params?.title, fallbackName)}_${compactTimestamp()}_${randomUUID().slice(0, 6)}`;
  let candidate = path.join(outputDir, withExtension(base, extension));
  if (!existsSync(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = path.join(outputDir, withExtension(`${base}_${index}`, extension));
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(outputDir, withExtension(`${base}_${randomUUID().slice(0, 8)}`, extension));
}

function maybeOpenFile(filePath, openAfterCreate) {
  if (!openAfterCreate) return;
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Opening is best-effort; artifact creation has already succeeded.
  }
}

function artifactResult(filePath, mimeType, kind, title, openAfterCreate = false) {
  const size = statSync(filePath).size;
  maybeOpenFile(filePath, openAfterCreate);
  const payload = {
    ok: true,
    kind,
    title: title || path.basename(filePath),
    filePath,
    fileSize: size,
    sizeBytes: size,
    mimeType,
    media: `MEDIA:${filePath}`,
  };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload),
    }],
    details: payload,
  };
}

function toolErrorResult(message, details = {}) {
  const payload = {
    ok: false,
    status: 'error',
    error: message,
    ...details,
  };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload),
    }],
    details: payload,
    isError: true,
  };
}

function relsXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
${relationships.map((rel) => `  <Relationship Id="${rel.id}" Type="${rel.type}" Target="${xml(rel.target)}"/>`).join('\n')}
</Relationships>`;
}

function inch(value) {
  return Math.round(value * EMU_PER_INCH);
}

function normalizeSlide(raw, index) {
  if (typeof raw === 'string') {
    return { title: `第 ${index + 1} 页`, bullets: [cleanText(raw)] };
  }
  const title = cleanText(raw?.title) || `第 ${index + 1} 页`;
  const bullets = textList(raw?.bullets);
  const body = cleanText(raw?.body);
  return {
    title,
    subtitle: cleanText(raw?.subtitle),
    bullets: bullets.length > 0 ? bullets : (body ? [body] : []),
  };
}

function normalizeDeck(spec) {
  const title = cleanText(spec?.title) || 'UClaw 演示文稿';
  const subtitle = cleanText(spec?.subtitle);
  const footer = cleanText(spec?.footer) || 'UClaw';
  const inputSlides = Array.isArray(spec?.slides) ? spec.slides : [];
  const slides = [{ kind: 'title', title, subtitle, bullets: [] }];
  if (inputSlides.length > 0) {
    for (let i = 0; i < inputSlides.length; i += 1) {
      slides.push({ kind: 'content', ...normalizeSlide(inputSlides[i], i) });
    }
  } else {
    slides.push({
      kind: 'content',
      title: '核心亮点',
      bullets: ['主题明确', '内容结构完整', '适合直接预览和继续编辑'],
    });
  }
  return { title, footer, slides };
}

function pptContentTypesXml(slideCount) {
  const slideOverrides = Array.from({ length: slideCount }, (_, idx) => (
    `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  )).join('\n');
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

function coreXml(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xml(title)}</dc:title>
  <dc:creator>UClaw</dc:creator>
  <cp:lastModifiedBy>UClaw</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function pptAppXml(slideCount) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>UClaw Local Artifacts</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <AppVersion>1.0</AppVersion>
</Properties>`;
}

function presentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, idx) => (
    `    <p:sldId id="${256 + idx}" r:id="rId${idx + 2}"/>`
  )).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function themeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="UClaw">
  <a:themeElements>
    <a:clrScheme name="UClaw">
      <a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1E293B"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="10B981"/></a:accent2>
      <a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="06B6D4"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="UClaw"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="UClaw"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function emptyGroupShapeXml() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyGroupShapeXml()}</p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-228600"><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>
</p:sldMaster>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree>${emptyGroupShapeXml()}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function txBodyXml(paragraphs, fontSize = 2400, color = '111827') {
  const lines = paragraphs.length > 0 ? paragraphs : [''];
  return `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${lines.map((line) => `<a:p><a:r><a:rPr lang="zh-CN" sz="${fontSize}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${fontSize}"/></a:p>`).join('')}</p:txBody>`;
}

function shapeXml(id, name, x, y, w, h, fill, lines, fontSize, color = '111827') {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:ln></p:spPr>
  ${txBodyXml(lines, fontSize, color)}
</p:sp>`;
}

function titleSlideXml(slide, footer) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyGroupShapeXml()}
    ${shapeXml(2, 'Accent', 0.45, 0.45, 1.1, 0.12, '10B981', [''], 100)}
    ${shapeXml(3, 'Title', 0.8, 1.65, 11.6, 1.35, 'FFFFFF', [slide.title], 4200, '0F172A')}
    ${shapeXml(4, 'Subtitle', 1.1, 3.25, 10.9, 0.9, 'E0F2FE', [slide.subtitle || '由 UClaw 自动生成的可编辑演示稿'], 2200, '155E75')}
    ${shapeXml(5, 'Footer', 9.7, 6.55, 2.7, 0.35, 'F1F5F9', [footer], 1100, '64748B')}
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function contentSlideXml(slide, index, footer) {
  const bullets = slide.bullets.length > 0 ? slide.bullets.map((item) => `• ${item}`) : ['• 可继续编辑补充内容'];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyGroupShapeXml()}
    ${shapeXml(2, 'Slide Number', 0.75, 0.55, 0.7, 0.45, 'DBEAFE', [String(index).padStart(2, '0')], 1300, '1D4ED8')}
    ${shapeXml(3, 'Title', 1.55, 0.5, 10.9, 0.75, 'FFFFFF', [slide.title], 3000, '0F172A')}
    ${slide.subtitle ? shapeXml(4, 'Subtitle', 1.65, 1.28, 10.3, 0.45, 'F8FAFC', [slide.subtitle], 1300, '475569') : ''}
    ${shapeXml(5, 'Body', 1.05, 1.95, 11.1, 4.1, 'F8FAFC', bullets, 1850, '1E293B')}
    ${shapeXml(6, 'Footer', 9.7, 6.55, 2.7, 0.35, 'FFFFFF', [footer], 1050, '94A3B8')}
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

async function createPptxBuffer(spec) {
  const deck = normalizeDeck(spec);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', pptContentTypesXml(deck.slides.length));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: `${PACKAGE_REL}/metadata/core-properties`, target: 'docProps/core.xml' },
    { id: 'rId2', type: `${OFFICE_REL}/extended-properties`, target: 'docProps/app.xml' },
    { id: 'rId3', type: `${OFFICE_REL}/officeDocument`, target: 'ppt/presentation.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(deck.title));
  zip.file('docProps/app.xml', pptAppXml(deck.slides.length));
  zip.file('ppt/presentation.xml', presentationXml(deck.slides.length));
  zip.file('ppt/_rels/presentation.xml.rels', relsXml([
    { id: 'rId1', type: `${OFFICE_REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    ...deck.slides.map((_, idx) => ({ id: `rId${idx + 2}`, type: `${OFFICE_REL}/slide`, target: `slides/slide${idx + 1}.xml` })),
  ]));
  zip.file('ppt/slideMasters/slideMaster1.xml', slideMasterXml());
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([
    { id: 'rId1', type: `${OFFICE_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${OFFICE_REL}/theme`, target: '../theme/theme1.xml' },
  ]));
  zip.file('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml());
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([
    { id: 'rId1', type: `${OFFICE_REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' },
  ]));
  zip.file('ppt/theme/theme1.xml', themeXml());
  deck.slides.forEach((slide, idx) => {
    zip.file(`ppt/slides/slide${idx + 1}.xml`, slide.kind === 'title'
      ? titleSlideXml(slide, deck.footer)
      : contentSlideXml(slide, idx + 1, deck.footer));
    zip.file(`ppt/slides/_rels/slide${idx + 1}.xml.rels`, relsXml([
      { id: 'rId1', type: `${OFFICE_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    ]));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function normalizeDoc(spec) {
  const title = cleanText(spec?.title) || 'UClaw 文档';
  const paragraphs = textList(spec?.paragraphs);
  const sections = Array.isArray(spec?.sections) ? spec.sections : [];
  return {
    title,
    subtitle: cleanText(spec?.subtitle),
    paragraphs,
    sections: sections.map((section, index) => ({
      title: cleanText(section?.title) || `第 ${index + 1} 节`,
      paragraphs: textList(section?.paragraphs).length > 0
        ? textList(section?.paragraphs)
        : textList(section?.bullets),
    })),
  };
}

function wordParagraph(text, style = '') {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function docxContentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function docxAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>UClaw Local Artifacts</Application>
  <AppVersion>1.0</AppVersion>
</Properties>`;
}

function docxStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WORD_NS}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
</w:styles>`;
}

function documentXml(spec) {
  const doc = normalizeDoc(spec);
  const blocks = [
    wordParagraph(doc.title, 'Title'),
    ...(doc.subtitle ? [wordParagraph(doc.subtitle)] : []),
    ...doc.paragraphs.map((item) => wordParagraph(item)),
  ];
  for (const section of doc.sections) {
    blocks.push(wordParagraph(section.title, 'Heading1'));
    if (section.paragraphs.length === 0) {
      blocks.push(wordParagraph('可继续编辑补充内容。'));
    } else {
      blocks.push(...section.paragraphs.map((item) => wordParagraph(item)));
    }
  }
  if (blocks.length <= 1) {
    blocks.push(wordParagraph('这是一份由 UClaw 自动生成的本地 DOCX 文档。'));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NS}" xmlns:r="${OFFICE_REL}">
  <w:body>
    ${blocks.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
}

async function createDocxBuffer(spec) {
  const doc = normalizeDoc(spec);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', docxContentTypesXml());
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: `${PACKAGE_REL}/metadata/core-properties`, target: 'docProps/core.xml' },
    { id: 'rId2', type: `${OFFICE_REL}/extended-properties`, target: 'docProps/app.xml' },
    { id: 'rId3', type: `${OFFICE_REL}/officeDocument`, target: 'word/document.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(doc.title));
  zip.file('docProps/app.xml', docxAppXml());
  zip.file('word/document.xml', documentXml(spec));
  zip.file('word/styles.xml', docxStylesXml());
  zip.file('word/_rels/document.xml.rels', relsXml([]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function normalizeRows(headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return headers.length > 0
      ? [headers, headers.map((header, index) => (index === 0 ? '示例' : 0))]
      : [['项目', '数值'], ['示例', 1]];
  }
  const objectRows = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  if (objectRows.length === rows.length) {
    const keys = headers.length > 0 ? headers : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return [keys, ...rows.map((row) => keys.map((key) => row[key] ?? ''))];
  }
  return [
    ...(headers.length > 0 ? [headers] : []),
    ...rows.map((row) => Array.isArray(row) ? row : [row]),
  ];
}

function normalizeSheets(params) {
  if (Array.isArray(params?.sheets) && params.sheets.length > 0) {
    return params.sheets.map((sheet, index) => ({
      name: sanitizeBaseName(sheet?.name, `Sheet${index + 1}`).slice(0, 31),
      data: normalizeRows(textList(sheet?.headers), Array.isArray(sheet?.rows) ? sheet.rows : []),
    }));
  }
  return [{
    name: sanitizeBaseName(params?.sheetName, 'Sheet1').slice(0, 31),
    data: normalizeRows(textList(params?.headers), Array.isArray(params?.rows) ? params.rows : []),
  }];
}

function createXlsxBuffer(params) {
  const workbook = XLSX.utils.book_new();
  const sheets = normalizeSheets(params);
  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.data);
    const colWidths = [];
    for (const row of sheet.data) {
      const cells = Array.isArray(row) ? row : [];
      for (let index = 0; index < cells.length; index += 1) {
        const padding = row === sheet.data[0] ? 4 : 2;
        const width = cleanText(cells[index]).length + padding;
        colWidths[index] = Math.max(colWidths[index] ?? 10, width, 10);
      }
    }
    worksheet['!cols'] = colWidths.map((width) => ({ wch: Math.min(width, 36) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name || 'Sheet1');
  }
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

function renderTextContent(params) {
  const title = cleanText(params?.title);
  const content = cleanText(params?.content);
  const sections = Array.isArray(params?.sections) ? params.sections : [];
  const lines = [];
  if (title) lines.push(`# ${title}`, '');
  if (content) lines.push(content, '');
  for (const section of sections) {
    const sectionTitle = cleanText(section?.title);
    if (sectionTitle) lines.push(`## ${sectionTitle}`, '');
    const paragraphs = textList(section?.paragraphs);
    const bullets = textList(section?.bullets);
    lines.push(...paragraphs, ...bullets.map((item) => `- ${item}`), '');
  }
  if (lines.length === 0) {
    lines.push('# UClaw 文案', '', '这是一份由 UClaw 自动生成的本地文本产物。');
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`;
}

function defaultHtmlApp(params) {
  const title = cleanText(params?.title) || 'UClaw 灵感收集小程序';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${xml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f8fafc; color: #0f172a; }
    main { max-width: 860px; margin: 0 auto; padding: 32px 20px; }
    h1 { margin: 0 0 16px; font-size: 30px; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin: 20px 0; }
    input, button { font: inherit; border-radius: 8px; border: 1px solid #cbd5e1; padding: 11px 12px; }
    button { background: #2563eb; color: white; border-color: #2563eb; cursor: pointer; }
    ul { list-style: none; padding: 0; display: grid; gap: 10px; }
    li { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; display: flex; justify-content: space-between; gap: 12px; }
    li.done span { color: #64748b; text-decoration: line-through; }
    .meta { color: #475569; line-height: 1.7; }
  </style>
</head>
<body>
  <main>
    <h1>${xml(title)}</h1>
    <p class="meta">一个可直接打开运行的轻量小程序示例：记录灵感、任务或素材点子，数据保存在当前浏览器本地。</p>
    <form id="form"><input id="item" placeholder="写下一个灵感或待办" autocomplete="off"><button>添加</button></form>
    <ul id="list"></ul>
  </main>
  <script>
    const key = 'uclaw-mini-app-items';
    const form = document.getElementById('form');
    const input = document.getElementById('item');
    const list = document.getElementById('list');
    let items = JSON.parse(localStorage.getItem(key) || '[]');
    function save() { localStorage.setItem(key, JSON.stringify(items)); }
    function render() {
      list.innerHTML = '';
      items.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = item.done ? 'done' : '';
        li.innerHTML = '<span></span><button type="button">切换</button>';
        li.querySelector('span').textContent = item.text;
        li.querySelector('button').onclick = () => { items[index].done = !items[index].done; save(); render(); };
        list.appendChild(li);
      });
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      items.unshift({ text, done: false });
      input.value = '';
      save();
      render();
    };
    render();
  </script>
</body>
</html>
`;
}

function renderHtmlApp(params) {
  const rawHtml = typeof params?.html === 'string' ? params.html.trim() : '';
  const rawIsFullDocument = /<!doctype html|<html[\s>]/iu.test(rawHtml);
  const hasStructuredParts = Boolean(cleanText(params?.body) || cleanText(params?.css) || cleanText(params?.js));
  if (rawIsFullDocument && (!hasStructuredParts || validateHtmlAppContent(rawHtml).ok)) {
    return rawHtml.endsWith('\n') ? rawHtml : `${rawHtml}\n`;
  }
  const title = cleanText(params?.title) || 'UClaw 小程序';
  const body = (rawIsFullDocument ? '' : rawHtml) || cleanText(params?.body) || '<main id="app"></main>';
  const css = typeof params?.css === 'string' ? params.css : '';
  const js = typeof params?.js === 'string' ? params.js : '';
  if (!rawHtml && !css && !js) return defaultHtmlApp(params);
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

function htmlBodyInner(html) {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1] ?? '';
}

function stripHtmlForText(html) {
  return cleanText(String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '));
}

function validateHtmlAppContent(html) {
  const source = String(html ?? '');
  const body = htmlBodyInner(source);
  const visibleBodyText = stripHtmlForText(body || source);
  const hasDocument = /<!doctype html|<html[\s>]/iu.test(source);
  const hasBody = /<body\b[\s\S]*<\/body>/iu.test(source);
  const hasScript = /<script\b[^>]*>[\s\S]{20,}<\/script>/iu.test(source);
  const hasInteractiveMarkup = /<(?:form|input|button|select|textarea|canvas|svg|ul|ol|main|section|article)\b/iu.test(body);
  const hasMountPoint = /<[^>]+\b(?:id|class)=["'][^"']{2,}["'][^>]*>/iu.test(body);
  const hasVisibleOrInteractiveBody = visibleBodyText.length >= 8 || hasInteractiveMarkup || (hasMountPoint && hasScript);
  const size = Buffer.byteLength(source, 'utf8');
  if (!hasDocument) {
    return { ok: false, reason: 'HTML 产物缺少完整文档结构。', evidence: `sizeBytes=${size}; hasDocument=false` };
  }
  if (!hasBody || !hasVisibleOrInteractiveBody) {
    return {
      ok: false,
      reason: 'HTML 产物 body 为空或缺少可交互内容。',
      evidence: `sizeBytes=${size}; hasBody=${hasBody}; visibleChars=${visibleBodyText.length}; hasInteractiveMarkup=${hasInteractiveMarkup}; hasScript=${hasScript}`,
    };
  }
  if (size < 400) {
    return { ok: false, reason: 'HTML 产物内容过短，疑似空壳页面。', evidence: `sizeBytes=${size}` };
  }
  return { ok: true, evidence: `sizeBytes=${size}; visibleChars=${visibleBodyText.length}; hasScript=${hasScript}` };
}

const slideSchema = Type.Object({
  title: Type.Optional(Type.String()),
  subtitle: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  bullets: Type.Optional(Type.Array(Type.String())),
});

const sectionSchema = Type.Object({
  title: Type.Optional(Type.String()),
  paragraphs: Type.Optional(Type.Array(Type.String())),
  bullets: Type.Optional(Type.Array(Type.String())),
});

const baseFileSchema = {
  filename: Type.Optional(Type.String({ description: 'Optional output filename. A non-overwriting filename is generated when omitted.' })),
  outputDir: Type.Optional(Type.String({ description: 'Optional output directory. Relative paths resolve under the OpenClaw workspace.' })),
  openAfterCreate: Type.Optional(Type.Boolean({ description: 'Open the generated file after creation. Default false.' })),
};

function createTools() {
  return [
    {
      name: 'create_pptx_file',
      label: 'Create PPTX',
      description: 'Create a real local .pptx presentation file. Use this for PPT, slides, deck, and presentation artifacts. Return the file path; do not substitute with an outline.',
      promptSnippet: 'create_pptx_file: create a real local PPTX presentation artifact and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        subtitle: Type.Optional(Type.String()),
        footer: Type.Optional(Type.String()),
        slides: Type.Optional(Type.Array(slideSchema)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const filePath = await uniqueOutputPath(ctx, safeParams, 'pptx', 'UClaw_PPT');
        await writeFile(filePath, await createPptxBuffer(safeParams));
        return artifactResult(filePath, MIME.pptx, 'presentation', cleanText(safeParams?.title), safeParams?.openAfterCreate === true);
      },
    },
    {
      name: 'create_docx_file',
      label: 'Create DOCX',
      description: 'Create a real local .docx document file. Use this for Word, document, report, proposal, and written document artifacts.',
      promptSnippet: 'create_docx_file: create a real local DOCX document artifact and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        subtitle: Type.Optional(Type.String()),
        paragraphs: Type.Optional(Type.Array(Type.String())),
        sections: Type.Optional(Type.Array(sectionSchema)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const filePath = await uniqueOutputPath(ctx, safeParams, 'docx', 'UClaw_DOCX');
        await writeFile(filePath, await createDocxBuffer(safeParams));
        return artifactResult(filePath, MIME.docx, 'document', cleanText(safeParams?.title), safeParams?.openAfterCreate === true);
      },
    },
    {
      name: 'create_xlsx_file',
      label: 'Create XLSX',
      description: 'Create a real local .xlsx spreadsheet file. Use this for Excel, spreadsheet, workbook, table, and budget/schedule artifacts.',
      promptSnippet: 'create_xlsx_file: create a real local XLSX spreadsheet artifact and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        sheetName: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Array(Type.String())),
        rows: Type.Optional(Type.Array(Type.Any())),
        sheets: Type.Optional(Type.Array(Type.Object({
          name: Type.Optional(Type.String()),
          headers: Type.Optional(Type.Array(Type.String())),
          rows: Type.Optional(Type.Array(Type.Any())),
        }))),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const filePath = await uniqueOutputPath(ctx, safeParams, 'xlsx', 'UClaw_XLSX');
        await writeFile(filePath, createXlsxBuffer(safeParams));
        return artifactResult(filePath, MIME.xlsx, 'spreadsheet', cleanText(safeParams?.title), safeParams?.openAfterCreate === true);
      },
    },
    {
      name: 'create_text_file',
      label: 'Create Text',
      description: 'Create a real local Markdown or plain-text file. Use this for copywriting, drafts, scripts, outlines, notes, and text deliverables that must be an artifact.',
      promptSnippet: 'create_text_file: create a local text/markdown artifact for copywriting or document text and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        extension: Type.Optional(Type.Union([Type.Literal('md'), Type.Literal('txt')])),
        sections: Type.Optional(Type.Array(sectionSchema)),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const extension = safeParams?.extension === 'txt' ? 'txt' : 'md';
        const filePath = await uniqueOutputPath(ctx, safeParams, extension, 'UClaw_Text');
        await writeFile(filePath, renderTextContent(safeParams), 'utf8');
        return artifactResult(filePath, MIME[extension], 'document', cleanText(safeParams?.title), safeParams?.openAfterCreate === true);
      },
    },
    {
      name: 'create_html_app_file',
      label: 'Create HTML App',
      description: 'Create a real local runnable single-file HTML app. Use this for small app, mini app, web toy, calculator, todo, dashboard, and prototype artifacts.',
      promptSnippet: 'create_html_app_file: create a runnable local HTML app artifact and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        css: Type.Optional(Type.String()),
        js: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const filePath = await uniqueOutputPath(ctx, safeParams, 'html', 'UClaw_HTML_App');
        const html = renderHtmlApp(safeParams);
        const validation = validateHtmlAppContent(html);
        if (!validation.ok) {
          return toolErrorResult(validation.reason, {
            kind: 'webpage',
            title: cleanText(safeParams?.title),
            verification: {
              status: 'blocked',
              kind: 'artifact.content',
              required: true,
              severity: 'blocking',
              detail: validation.reason,
              evidence: validation.evidence,
            },
          });
        }
        await writeFile(filePath, html, 'utf8');
        return artifactResult(filePath, MIME.html, 'webpage', cleanText(safeParams?.title), safeParams?.openAfterCreate === true);
      },
    },
  ];
}

export const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'UClaw Local Artifacts',
  description: 'Creates reliable local PPTX, DOCX, XLSX, text, and runnable HTML artifacts without desktop automation.',
  register(api) {
    for (const tool of createTools()) {
      api.registerTool(tool);
    }
  },
});

export default pluginEntry;

export const __test = {
  createTools,
  createPptxBuffer,
  createDocxBuffer,
  createXlsxBuffer,
  renderTextContent,
  renderHtmlApp,
  validateHtmlAppContent,
  uniqueOutputPath,
};
