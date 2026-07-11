import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { Type } from '@sinclair/typebox';
import PptxGenJS from 'pptxgenjs';
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
const STUDIO_SLIDE_WIDTH = 13.333;
const STUDIO_SLIDE_HEIGHT = 7.5;
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

function studioText(value) {
  return normalizeBrandText(value)
    .replace(/\\r\\n|\\n|\\r/gu, '\n')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .join('\n')
    .trim();
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

function normalizeStudioParams(params) {
  const normalized = normalizeBrandValue(params);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  normalized.filename = params?.filename;
  normalized.outputDir = params?.outputDir;
  normalized.slides = Array.isArray(normalized.slides)
    ? normalized.slides.map((slide, slideIndex) => ({
        ...slide,
        elements: Array.isArray(slide?.elements)
          ? slide.elements.map((element, elementIndex) => (
              element?.type === 'image'
                ? { ...element, path: params?.slides?.[slideIndex]?.elements?.[elementIndex]?.path }
                : element
            ))
          : slide?.elements,
      }))
    : normalized.slides;
  return normalized;
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

function artifactResult(filePath, mimeType, kind, title, openAfterCreate = false, extra = {}) {
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
    ...extra,
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

const PRESENTATION_THEMES = {
  'product-launch': { name: 'Product Launch', coverStyle: 'stage', contentStyle: 'rail', cover: '09090B', coverTitle: 'FAFAFA', coverMuted: 'C4C7D1', background: 'F7F8FA', primary: '00A7C4', secondary: '7C3AED', text: '171923', muted: '5A6475', surface: 'FFFFFF', surfaceAlt: 'E8F7FA', line: 'CBD5E1' },
  'travel-editorial': { name: 'Travel Editorial', coverStyle: 'editorial', contentStyle: 'band', cover: 'E7EFE8', coverTitle: '173B2C', coverMuted: '476252', background: 'FFFDF7', primary: '2F6B4F', secondary: 'D96C4C', text: '20362B', muted: '65766B', surface: 'FFFDF7', surfaceAlt: 'E4EFE7', line: 'B7CDBE' },
  'executive-report': { name: 'Executive Report', coverStyle: 'report', contentStyle: 'grid', cover: 'F1F1ED', coverTitle: '191919', coverMuted: '5B5B57', background: 'FFFFFF', primary: 'B8423A', secondary: '1F4E5F', text: '202124', muted: '62666C', surface: 'FFFFFF', surfaceAlt: 'F2F3F4', line: 'D4D6D8' },
  'training-workshop': { name: 'Training Workshop', coverStyle: 'workshop', contentStyle: 'notebook', cover: 'FFF4C7', coverTitle: '25314C', coverMuted: '59647A', background: 'FFFDF6', primary: 'E79C13', secondary: '315C8C', text: '25314C', muted: '667085', surface: 'FFFFFF', surfaceAlt: 'EAF2F8', line: 'C8D6E3' },
  'creative-editorial': { name: 'Creative Editorial', coverStyle: 'minimal', contentStyle: 'minimal', cover: 'F1EEFA', coverTitle: '2A2040', coverMuted: '665D76', background: 'FBFAFF', primary: '6D5BD0', secondary: 'C84B5A', text: '2A2633', muted: '6B6575', surface: 'FFFFFF', surfaceAlt: 'EEEAFB', line: 'D8D1E6' },
};

function presentationThemeFamily(spec) {
  const explicit = cleanText(spec?.presentationDesign?.themeFamily).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRESENTATION_THEMES, explicit)) return explicit;
  const prompt = [spec?.title, spec?.subtitle, spec?.presentationDesign?.audience, spec?.presentationDesign?.purpose, spec?.presentationDesign?.visualTone, ...(Array.isArray(spec?.slides) ? spec.slides.flatMap((slide) => [slide?.title, slide?.subtitle]) : [])]
    .map(cleanText).filter(Boolean).join('\n');
  if (/旅游|旅行|目的地|景区|景点|城市漫游|酒店|度假|民宿|线路|行程|张家界|山水|自然风光/u.test(prompt)) return 'travel-editorial';
  if (/培训|课程|教学|课堂|练习题|工作坊|学习|教案|学员|知识点/u.test(prompt)) return 'training-workshop';
  if (/老板|高管|管理层|经营|汇报|周报|月报|复盘|预算|ROI|指标|销售|财务|决策|战略/u.test(prompt)) return 'executive-report';
  if (/发布会|新品|产品|手机|电脑|汽车|科技|品牌|营销|宣传|概念|iPhone|Apple|体验升级/iu.test(prompt)) return 'product-launch';
  return 'creative-editorial';
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
  if (inputSlides.length === 0) throw new Error('create_pptx_file requires slides with the first slide as the cover');
  const slides = inputSlides.map((slide, index) => ({
    kind: index === 0 ? 'title' : 'content',
    ...normalizeSlide(slide, index),
    ...(index === 0 && !cleanText(slide?.title) ? { title } : {}),
    ...(index === 0 && !cleanText(slide?.subtitle) && subtitle ? { subtitle } : {}),
  }));
  const themeFamily = presentationThemeFamily(spec);
  return { title, footer, slides, themeFamily, theme: PRESENTATION_THEMES[themeFamily] };
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

function themeXml(theme) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="UClaw ${xml(theme.name)}">
  <a:themeElements>
    <a:clrScheme name="UClaw ${xml(theme.name)}">
      <a:dk1><a:srgbClr val="${theme.text}"/></a:dk1><a:lt1><a:srgbClr val="${theme.surface}"/></a:lt1>
      <a:dk2><a:srgbClr val="${theme.secondary}"/></a:dk2><a:lt2><a:srgbClr val="${theme.background}"/></a:lt2>
      <a:accent1><a:srgbClr val="${theme.primary}"/></a:accent1><a:accent2><a:srgbClr val="${theme.secondary}"/></a:accent2>
      <a:accent3><a:srgbClr val="${theme.coverMuted}"/></a:accent3><a:accent4><a:srgbClr val="${theme.cover}"/></a:accent4>
      <a:accent5><a:srgbClr val="${theme.surfaceAlt}"/></a:accent5><a:accent6><a:srgbClr val="${theme.muted}"/></a:accent6>
      <a:hlink><a:srgbClr val="${theme.primary}"/></a:hlink><a:folHlink><a:srgbClr val="${theme.secondary}"/></a:folHlink>
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

function titleSlideXml(slide, footer, theme, themeFamily) {
  const shapes = [emptyGroupShapeXml()];
  let id = 2;
  shapes.push(shapeXml(id++, 'Cover Background', 0, 0, 13.34, 7.5, theme.cover, [''], 100, theme.cover));
  if (theme.coverStyle === 'stage') {
    shapes.push(shapeXml(id++, 'Cover Accent', 0, 0, 0.18, 7.5, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Cover Stage', 10.45, 0, 2.89, 7.5, theme.secondary, ['01'], 5600, 'FFFFFF'));
    shapes.push(shapeXml(id++, 'Title', 0.9, 1.45, 8.95, 2.0, theme.cover, [slide.title], slide.title.length > 24 ? 3800 : 4700, theme.coverTitle));
    shapes.push(shapeXml(id++, 'Subtitle', 0.9, 3.8, 8.3, 1.0, theme.cover, [slide.subtitle || '产品、体验与价值主张'], 1750, theme.coverMuted));
  } else if (theme.coverStyle === 'editorial') {
    shapes.push(shapeXml(id++, 'Cover Accent', 0, 0, 13.34, 0.35, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Cover Editorial Panel', 10.0, 0.35, 3.34, 7.15, theme.secondary, slide.bullets.slice(0, 3).map((item, index) => `${String(index + 1).padStart(2, '0')}  ${item}`), 1450, 'FFFFFF'));
    shapes.push(shapeXml(id++, 'Title', 0.72, 1.4, 8.65, 2.15, theme.cover, [slide.title], slide.title.length > 24 ? 3600 : 4500, theme.coverTitle));
    shapes.push(shapeXml(id++, 'Subtitle', 0.72, 4.0, 8.5, 1.15, theme.cover, [slide.subtitle || '地方、风景与体验叙事'], 1750, theme.coverMuted));
  } else if (theme.coverStyle === 'report') {
    shapes.push(shapeXml(id++, 'Cover Accent', 0, 0, 13.34, 0.16, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Cover Report Panel', 9.55, 0.16, 3.79, 7.34, theme.secondary, (slide.bullets.length > 0 ? slide.bullets : ['关键结论', '经营判断', '决策建议']).slice(0, 3).map((item) => `• ${item}`), 1450, 'FFFFFF'));
    shapes.push(shapeXml(id++, 'Title', 0.88, 1.45, 7.95, 2.15, theme.cover, [slide.title], slide.title.length > 24 ? 3500 : 4400, theme.coverTitle));
    shapes.push(shapeXml(id++, 'Subtitle', 0.88, 4.05, 7.9, 1.15, theme.cover, [slide.subtitle || '面向决策者的核心事实与行动建议'], 1650, theme.coverMuted));
  } else if (theme.coverStyle === 'workshop') {
    shapes.push(shapeXml(id++, 'Cover Footer Block', 0, 6.65, 13.34, 0.85, theme.secondary, [''], 100));
    shapes.push(shapeXml(id++, 'Cover Workshop Block', 10.75, 0, 2.59, 1.55, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Title', 0.72, 1.4, 9.25, 2.1, theme.cover, [slide.title], slide.title.length > 24 ? 3600 : 4500, theme.coverTitle));
    shapes.push(shapeXml(id++, 'Subtitle', 0.72, 3.9, 8.9, 1.1, theme.cover, [slide.subtitle || '理解、练习、反馈与应用'], 1750, theme.coverMuted));
  } else {
    shapes.push(shapeXml(id++, 'Cover Accent', 0, 0, 0.24, 7.5, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Cover Minimal Block', 10.1, 0.85, 2.35, 2.35, theme.secondary, [''], 100));
    shapes.push(shapeXml(id++, 'Title', 0.95, 1.5, 8.45, 2.1, theme.cover, [slide.title], slide.title.length > 24 ? 3600 : 4500, theme.coverTitle));
    shapes.push(shapeXml(id++, 'Subtitle', 0.95, 4.0, 8.2, 1.1, theme.cover, [slide.subtitle || '清晰叙事与可编辑表达'], 1750, theme.coverMuted));
  }
  shapes.push(shapeXml(id++, 'Footer', 0.9, 6.75, 7.6, 0.28, theme.cover, [footer], 950, theme.coverMuted));
  shapes.push(shapeXml(id++, `UClaw Theme ${themeFamily}`, 13.32, 7.48, 0.01, 0.01, theme.cover, [''], 100));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.cover}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${shapes.join('\n')}
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function contentSlideXml(slide, index, footer, theme, themeFamily) {
  const bullets = slide.bullets.length > 0 ? slide.bullets.map((item) => `• ${item}`) : ['• 可继续编辑补充内容'];
  const shapes = [emptyGroupShapeXml()];
  let id = 2;
  if (theme.contentStyle === 'rail') {
    shapes.push(shapeXml(id++, 'Page Accent', 0, 0, 0.16, 7.5, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Slide Number', 0.72, 0.5, 0.72, 0.45, theme.secondary, [String(index).padStart(2, '0')], 1250, 'FFFFFF'));
    shapes.push(shapeXml(id++, 'Title', 1.55, 0.48, 10.9, 0.75, theme.background, [slide.title], 2900, theme.text));
    shapes.push(shapeXml(id++, 'Body', 0.82, 1.72, 11.55, 4.7, theme.surface, bullets, 1750, theme.text));
  } else if (theme.contentStyle === 'band') {
    shapes.push(shapeXml(id++, 'Page Accent', 0, 0, 13.34, 0.26, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Title', 0.68, 0.65, 11.3, 0.8, theme.background, [slide.title], 3000, theme.text));
    const split = Math.ceil(bullets.length / 2);
    shapes.push(shapeXml(id++, 'Body A', 0.68, 1.85, 6.0, 4.35, theme.surface, bullets.slice(0, split), 1650, theme.text));
    shapes.push(shapeXml(id++, 'Body B', 6.92, 1.85, 5.72, 4.35, theme.surfaceAlt, bullets.slice(split), 1650, theme.text));
  } else if (theme.contentStyle === 'grid') {
    shapes.push(shapeXml(id++, 'Page Accent', 0, 0, 13.34, 0.1, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Slide Number', 11.85, 0.45, 0.72, 0.58, theme.secondary, [String(index).padStart(2, '0')], 1350, 'FFFFFF'));
    shapes.push(shapeXml(id++, 'Title', 0.92, 0.62, 10.25, 0.75, theme.background, [slide.title], 2850, theme.text));
    shapes.push(shapeXml(id++, 'Body', 0.92, 1.82, 11.65, 4.45, theme.surfaceAlt, bullets, 1700, theme.text));
  } else if (theme.contentStyle === 'notebook') {
    shapes.push(shapeXml(id++, 'Page Accent', 0, 0, 0.3, 7.5, theme.secondary, [''], 100));
    shapes.push(shapeXml(id++, 'Title', 0.72, 0.7, 11.25, 0.78, theme.background, [slide.title], 2950, theme.text));
    shapes.push(shapeXml(id++, 'Title Marker', 0.72, 1.55, 2.4, 0.1, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Body', 0.72, 1.95, 11.7, 4.25, theme.surface, bullets, 1700, theme.text));
  } else {
    shapes.push(shapeXml(id++, 'Page Accent', 0.95, 0.32, 2.2, 0.1, theme.primary, [''], 100));
    shapes.push(shapeXml(id++, 'Title', 0.95, 0.82, 10.5, 0.8, theme.background, [slide.title], 3000, theme.text));
    shapes.push(shapeXml(id++, 'Body', 0.95, 2.0, 10.9, 4.1, theme.surfaceAlt, bullets, 1750, theme.text));
  }
  shapes.push(shapeXml(id++, 'Footer', 9.7, 6.65, 2.7, 0.3, theme.background, [footer], 950, theme.muted));
  shapes.push(shapeXml(id++, `UClaw Theme ${themeFamily}`, 13.32, 7.48, 0.01, 0.01, theme.background, [''], 100));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${shapes.join('\n')}
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
  zip.file('ppt/theme/theme1.xml', themeXml(deck.theme));
  deck.slides.forEach((slide, idx) => {
    zip.file(`ppt/slides/slide${idx + 1}.xml`, slide.kind === 'title'
      ? titleSlideXml(slide, deck.footer, deck.theme, deck.themeFamily)
      : contentSlideXml(slide, idx + 1, deck.footer, deck.theme, deck.themeFamily));
    zip.file(`ppt/slides/_rels/slide${idx + 1}.xml.rels`, relsXml([
      { id: 'rId1', type: `${OFFICE_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    ]));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function verifyPptxBuffer(buffer, spec) {
  const deck = normalizeDeck(spec);
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const themeText = await zip.file('ppt/theme/theme1.xml')?.async('string') ?? '';
  const marker = `UClaw Theme ${deck.themeFamily}`;
  const slideTexts = await Promise.all(slideNames.map((name) => zip.file(name)?.async('string') ?? ''));
  const themeMatches = themeText.includes(`name="UClaw ${deck.theme.name}"`);
  const markersComplete = slideTexts.every((text) => text.includes(marker));
  if (slideNames.length !== deck.slides.length || !themeMatches || !markersComplete) {
    throw new Error(`PPT verification failed: slides=${slideNames.length}/${deck.slides.length}, theme=${themeMatches}, markers=${markersComplete}`);
  }
  return {
    status: 'passed',
    themeFamily: deck.themeFamily,
    slideCount: slideNames.length,
    themeMatches,
    markersComplete,
  };
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

function studioNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function studioColor(value, fallback = '000000') {
  const normalized = String(value ?? '').replace(/^#/u, '').trim().toUpperCase();
  return /^[0-9A-F]{6}$/u.test(normalized) ? normalized : fallback;
}

function studioBox(element) {
  const xPercent = Math.max(0, Math.min(100, studioNumber(element?.x)));
  const yPercent = Math.max(0, Math.min(100, studioNumber(element?.y)));
  const widthPercent = Math.max(0.1, Math.min(100 - xPercent, studioNumber(element?.w, 10)));
  const heightPercent = Math.max(0.1, Math.min(100 - yPercent, studioNumber(element?.h, 10)));
  return {
    x: xPercent / 100 * STUDIO_SLIDE_WIDTH,
    y: yPercent / 100 * STUDIO_SLIDE_HEIGHT,
    w: widthPercent / 100 * STUDIO_SLIDE_WIDTH,
    h: heightPercent / 100 * STUDIO_SLIDE_HEIGHT,
  };
}

function studioFill(color, transparency = 0) {
  if (!color) return { color: 'FFFFFF', transparency: 100 };
  return {
    color: studioColor(color, 'FFFFFF'),
    transparency: Math.max(0, Math.min(100, studioNumber(transparency))),
  };
}

function studioLine(color, width = 1, transparency = 0) {
  if (!color || width === 0) return { color: 'FFFFFF', transparency: 100, width: 0 };
  return {
    color: studioColor(color, '000000'),
    width: Math.max(0.25, Math.min(12, studioNumber(width, 1))),
    transparency: Math.max(0, Math.min(100, studioNumber(transparency))),
  };
}

function studioShadow(enabled) {
  return enabled === true
    ? { type: 'outer', color: '000000', opacity: 0.2, blur: 3, angle: 45, distance: 2 }
    : undefined;
}

function studioAssetPath(ctx, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('Studio image element requires a local path');
  const expanded = expandHome(raw);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(resolveWorkspaceDir(ctx), expanded);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Studio image file does not exist: ${resolved}`);
  }
  return resolved;
}

function studioTextOptions(element) {
  const role = element?.role || 'body';
  const roleMinimums = { title: 28, subtitle: 20, body: 16, caption: 10, metric: 24 };
  const minimum = roleMinimums[role] ?? 16;
  return {
    ...studioBox(element),
    fontFace: cleanText(element?.fontFace) || 'Aptos',
    fontSize: Math.max(minimum, Math.min(96, studioNumber(element?.fontSize, minimum))),
    color: studioColor(element?.color, '171717'),
    bold: element?.bold === true,
    italic: element?.italic === true,
    breakLine: false,
    margin: Math.max(0, Math.min(20, studioNumber(element?.margin, 0))),
    align: ['left', 'center', 'right', 'justify'].includes(element?.align) ? element.align : 'left',
    valign: ['top', 'mid', 'bottom'].includes(element?.valign) ? element.valign : 'top',
    fit: 'shrink',
    rotate: Math.max(-360, Math.min(360, studioNumber(element?.rotate))),
    transparency: Math.max(0, Math.min(100, studioNumber(element?.transparency))),
    ...(element?.fill ? { fill: studioFill(element.fill, element.fillTransparency) } : {}),
    ...(element?.line ? { line: studioLine(element.line, element.lineWidth, element.lineTransparency) } : {}),
    ...(studioShadow(element?.shadow) ? { shadow: studioShadow(true) } : {}),
  };
}

function studioShapeType(pptx, value) {
  const key = cleanText(value);
  const allowed = new Set(['rect', 'roundRect', 'ellipse', 'line', 'chevron', 'hexagon', 'arc', 'triangle', 'diamond']);
  return allowed.has(key) && pptx.ShapeType[key] ? pptx.ShapeType[key] : pptx.ShapeType.rect;
}

function studioChartType(pptx, value) {
  if (value === 'line') return { type: pptx.ChartType.line, options: {} };
  if (value === 'pie') return { type: pptx.ChartType.pie, options: {} };
  if (value === 'doughnut') return { type: pptx.ChartType.doughnut, options: { holeSize: 58 } };
  if (value === 'area') return { type: pptx.ChartType.area, options: {} };
  if (value === 'bar') return { type: pptx.ChartType.bar, options: { barDir: 'bar' } };
  return { type: pptx.ChartType.bar, options: { barDir: 'col' } };
}

function studioLayoutSignature(slide) {
  return (slide?.elements ?? []).map((element) => {
    const x = Math.round(studioNumber(element?.x) / 20);
    const y = Math.round(studioNumber(element?.y) / 20);
    const w = Math.round(studioNumber(element?.w) / 20);
    const h = Math.round(studioNumber(element?.h) / 20);
    return `${element?.type}:${x},${y},${w},${h}`;
  }).sort().join('|');
}

function overlapRatio(left, right) {
  const x1 = Math.max(studioNumber(left.x), studioNumber(right.x));
  const y1 = Math.max(studioNumber(left.y), studioNumber(right.y));
  const x2 = Math.min(studioNumber(left.x) + studioNumber(left.w), studioNumber(right.x) + studioNumber(right.w));
  const y2 = Math.min(studioNumber(left.y) + studioNumber(left.h), studioNumber(right.y) + studioNumber(right.h));
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(
    Math.max(0.01, studioNumber(left.w) * studioNumber(left.h)),
    Math.max(0.01, studioNumber(right.w) * studioNumber(right.h)),
  );
  return intersection / smaller;
}

function studioRgb(value) {
  const color = studioColor(value, '000000');
  return [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function studioRelativeLuminance(value) {
  const channels = studioRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function studioContrastRatio(foreground, background) {
  const foregroundLuminance = studioRelativeLuminance(foreground);
  const backgroundLuminance = studioRelativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function studioSolidTextBackground(slide, elements, textElement) {
  if (textElement?.fill && studioNumber(textElement?.fillTransparency) <= 15) {
    return studioColor(textElement.fill, slide?.background || 'FFFFFF');
  }
  const elementIndex = Number.isInteger(textElement?.elementIndex)
    ? textElement.elementIndex
    : elements.indexOf(textElement);
  for (let index = elementIndex - 1; index >= 0; index -= 1) {
    const candidate = elements[index];
    if (!candidate || overlapRatio(textElement, candidate) < 0.8) continue;
    if (candidate.type === 'image') return null;
    if (candidate.type !== 'shape') continue;
    if (!candidate.fill || studioNumber(candidate.fillTransparency) > 15) return null;
    return studioColor(candidate.fill, slide?.background || 'FFFFFF');
  }
  return studioColor(slide?.background, 'FFFFFF');
}

function validateStudioDeck(params, ctx) {
  const slides = Array.isArray(params?.slides) ? params.slides : [];
  const issues = [];
  let imageCount = 0;
  let chartCount = 0;
  let tableCount = 0;
  let metricSlideCount = 0;
  let lowContrastTextCount = 0;
  let visualSlideCount = 0;
  let contentVisualSlideCount = 0;
  const signatures = new Set();
  const usedImagePaths = new Set();
  slides.forEach((slide, slideIndex) => {
    const elements = Array.isArray(slide?.elements) ? slide.elements : [];
    if (elements.length === 0) issues.push(`slide ${slideIndex + 1} has no elements`);
    let hasEvidenceVisual = false;
    let hasDataMetric = false;
    const textElements = [];
    elements.forEach((element, elementIndex) => {
      const x = studioNumber(element?.x, -1);
      const y = studioNumber(element?.y, -1);
      const w = studioNumber(element?.w, -1);
      const h = studioNumber(element?.h, -1);
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 100.001 || y + h > 100.001) {
        issues.push(`slide ${slideIndex + 1} element ${elementIndex + 1} is outside the canvas`);
      }
      if (element?.type === 'text') {
        const text = studioText(element.text);
        textElements.push({ ...element, elementIndex });
        if (!text) issues.push(`slide ${slideIndex + 1} text element ${elementIndex + 1} is empty`);
        if (/(?:lorem ipsum|placeholder|tbd|todo|待补充|可继续编辑)/iu.test(text)) {
          issues.push(`slide ${slideIndex + 1} text element ${elementIndex + 1} contains placeholder copy`);
        }
        const metricArea = studioNumber(element?.w) * studioNumber(element?.h);
        if (
          element?.role === 'metric'
          && studioNumber(element?.fontSize) >= 24
          && metricArea >= 100
          && /\d/u.test(text)
        ) {
          hasDataMetric = true;
        }
      }
      if (element?.type === 'image') {
        imageCount += 1;
        hasEvidenceVisual = true;
        try {
          const assetPath = studioAssetPath(ctx, element.path);
          if (usedImagePaths.has(assetPath) && element.allowReuse !== true) {
            issues.push(`slide ${slideIndex + 1} reuses image ${assetPath}; set allowReuse only for intentional brand assets`);
          }
          usedImagePaths.add(assetPath);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (element?.type === 'chart') {
        chartCount += 1;
        hasEvidenceVisual = true;
        const categoryCount = Array.isArray(element.categories) ? element.categories.length : 0;
        for (const series of element.series ?? []) {
          if (!Array.isArray(series?.values) || series.values.length !== categoryCount) {
            issues.push(`slide ${slideIndex + 1} chart series must match its ${categoryCount} categories`);
          }
        }
      }
      if (element?.type === 'table') {
        tableCount += 1;
        hasEvidenceVisual = true;
        const widths = (element.rows ?? []).map((row) => Array.isArray(row) ? row.length : 0);
        if (widths.length === 0 || widths.some((width) => width === 0 || width !== widths[0])) {
          issues.push(`slide ${slideIndex + 1} table rows must have the same non-zero column count`);
        }
      }
    });
    for (let leftIndex = 0; leftIndex < textElements.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < textElements.length; rightIndex += 1) {
        const left = textElements[leftIndex];
        const right = textElements[rightIndex];
        if (left.allowOverlap || right.allowOverlap) continue;
        if (overlapRatio(left, right) > 0.12) {
          issues.push(`slide ${slideIndex + 1} text elements ${left.elementIndex + 1} and ${right.elementIndex + 1} overlap`);
        }
      }
    }
    for (const textElement of textElements) {
      const background = studioSolidTextBackground(slide, elements, textElement);
      if (!background || studioNumber(textElement?.transparency) > 20) continue;
      const contrast = studioContrastRatio(textElement.color, background);
      if (contrast >= 2.2) continue;
      lowContrastTextCount += 1;
      issues.push(
        `slide ${slideIndex + 1} text element ${textElement.elementIndex + 1} has unreadable ${contrast.toFixed(2)}:1 contrast against its solid background`,
      );
    }
    if (hasDataMetric) {
      metricSlideCount += 1;
      hasEvidenceVisual = true;
    }
    if (hasEvidenceVisual) {
      visualSlideCount += 1;
      if (slideIndex > 0) contentVisualSlideCount += 1;
    }
    signatures.add(studioLayoutSignature(slide));
  });
  const contentSlideCount = Math.max(0, slides.length - 1);
  const minimumVisualSlides = slides.length >= 5 ? Math.max(2, Math.ceil(contentSlideCount * 0.4)) : 0;
  if (contentVisualSlideCount < minimumVisualSlides) {
    issues.push(`studio deck needs visuals on at least ${minimumVisualSlides} content slides; found ${contentVisualSlideCount}`);
  }
  const minimumSignatures = slides.length >= 5 ? 3 : Math.min(slides.length, 2);
  if (signatures.size < minimumSignatures) {
    issues.push(`studio deck repeats one composition too often; layoutSignatures=${signatures.size}, required=${minimumSignatures}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    evidence: {
      slideCount: slides.length,
      elementCount: slides.reduce((sum, slide) => sum + (slide?.elements?.length ?? 0), 0),
      imageCount,
      chartCount,
      tableCount,
      metricSlideCount,
      lowContrastTextCount,
      visualSlideCount,
      contentVisualSlideCount,
      layoutSignatureCount: signatures.size,
    },
  };
}

async function createStudioPptxBuffer(params, ctx) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = cleanText(params?.author) || 'UClaw';
  pptx.company = 'UClaw';
  pptx.subject = cleanText(params?.subject) || cleanText(params?.designIntent);
  pptx.title = cleanText(params?.title) || 'UClaw Presentation';
  pptx.lang = cleanText(params?.language) || 'zh-CN';
  pptx.theme = {
    headFontFace: cleanText(params?.fonts?.heading) || 'Aptos Display',
    bodyFontFace: cleanText(params?.fonts?.body) || 'Aptos',
    lang: cleanText(params?.language) || 'zh-CN',
  };
  for (const slideSpec of params.slides ?? []) {
    const slide = pptx.addSlide();
    slide.background = { color: studioColor(slideSpec?.background, 'FFFFFF') };
    for (const element of slideSpec?.elements ?? []) {
      const box = studioBox(element);
      if (element.type === 'text') {
        slide.addText(studioText(element.text), studioTextOptions(element));
      } else if (element.type === 'image') {
        const imagePath = studioAssetPath(ctx, element.path);
        slide.addImage({
          path: imagePath,
          ...box,
          sizing: { type: element.fit === 'contain' ? 'contain' : 'cover', w: box.w, h: box.h },
          transparency: Math.max(0, Math.min(100, studioNumber(element.transparency))),
          rounding: element.rounding === true,
          rotate: Math.max(-360, Math.min(360, studioNumber(element.rotate))),
          ...(studioShadow(element.shadow) ? { shadow: studioShadow(true) } : {}),
        });
      } else if (element.type === 'shape') {
        slide.addShape(studioShapeType(pptx, element.shape), {
          ...box,
          fill: studioFill(element.fill || 'FFFFFF', element.fillTransparency),
          line: studioLine(element.line || element.fill || 'FFFFFF', element.lineWidth, element.lineTransparency),
          rotate: Math.max(-360, Math.min(360, studioNumber(element.rotate))),
          ...(studioShadow(element.shadow) ? { shadow: studioShadow(true) } : {}),
        });
      } else if (element.type === 'chart') {
        const chart = studioChartType(pptx, element.chartType);
        const slideBackground = studioColor(slideSpec?.background, 'FFFFFF');
        const chartTextColor = studioContrastRatio('FFFFFF', slideBackground)
          >= studioContrastRatio('111827', slideBackground)
          ? 'F8FAFC'
          : '111827';
        const chartGridColor = chartTextColor === 'F8FAFC' ? '64748B' : 'CBD5E1';
        const series = (element.series ?? []).map((item) => ({
          name: cleanText(item.name) || 'Series',
          labels: (element.categories ?? []).map(cleanText),
          values: (item.values ?? []).map((value) => studioNumber(value)),
          ...(item.color ? { color: studioColor(item.color) } : {}),
        }));
        slide.addChart(chart.type, series, {
          ...box,
          ...chart.options,
          showTitle: Boolean(cleanText(element.title)),
          title: cleanText(element.title),
          showLegend: element.showLegend === true,
          legendPos: element.legendPosition === 'bottom' ? 'b' : element.legendPosition === 'left' ? 'l' : element.legendPosition === 'top' ? 't' : 'r',
          showValue: element.showValue === true,
          showCatName: element.showCategoryName === true,
          showPercent: element.showPercent === true,
          chartColors: series.map((item, index) => studioColor(item.color, ['2563EB', 'F97316', '16A34A', 'DC2626'][index % 4])),
          showBorder: false,
          showValAxisTitle: false,
          showCatAxisTitle: false,
          catAxisLabelFontFace: cleanText(params?.fonts?.body) || 'Aptos',
          valAxisLabelFontFace: cleanText(params?.fonts?.body) || 'Aptos',
          catAxisLabelColor: chartTextColor,
          valAxisLabelColor: chartTextColor,
          dataLabelColor: chartTextColor,
          legendColor: chartTextColor,
          titleColor: chartTextColor,
          catAxisLineColor: chartGridColor,
          valAxisLineColor: chartGridColor,
          catGridLine: { color: chartGridColor, size: 0.5, style: 'solid' },
          valGridLine: { color: chartGridColor, size: 0.5, style: 'solid' },
          showLegendKey: false,
        });
      } else if (element.type === 'table') {
        const rows = Array.isArray(element.rows) ? element.rows : [];
        const headerFill = studioColor(element.headerFill, '171717');
        const headerColor = studioColor(element.headerColor, 'FFFFFF');
        const bodyFill = studioColor(element.bodyFill, 'FFFFFF');
        const bodyColor = studioColor(element.bodyColor, '171717');
        const tableRows = rows.map((row, rowIndex) => (row ?? []).map((cell) => ({
          text: cleanText(cell),
          options: rowIndex === 0 && element.firstRowHeader !== false
            ? { fill: headerFill, color: headerColor, bold: true }
            : { fill: bodyFill, color: bodyColor },
        })));
        slide.addTable(tableRows, {
          ...box,
          border: { type: 'solid', color: studioColor(element.borderColor, 'D1D5DB'), pt: 0.75 },
          fontFace: cleanText(params?.fonts?.body) || 'Aptos',
          fontSize: Math.max(10, Math.min(24, studioNumber(element.fontSize, 14))),
          margin: Math.max(0, Math.min(12, studioNumber(element.margin, 5))),
          autoFit: false,
          valign: 'mid',
          ...(Array.isArray(element.columnWidths) ? { colW: element.columnWidths.map((value) => Math.max(0.2, studioNumber(value) / 100 * STUDIO_SLIDE_WIDTH)) } : {}),
        });
      }
    }
    if (studioText(slideSpec?.speakerNotes) && typeof slide.addNotes === 'function') {
      slide.addNotes(studioText(slideSpec.speakerNotes));
    }
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

async function verifyStudioPptxBuffer(buffer, params, validation) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const mediaNames = Object.keys(zip.files).filter((name) => /^ppt\/media\/[^/]+$/u.test(name));
  const chartNames = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name));
  const expectedSlides = Array.isArray(params?.slides) ? params.slides.length : 0;
  if (slideNames.length !== expectedSlides) {
    throw new Error(`Studio PPT verification failed: slides=${slideNames.length}/${expectedSlides}`);
  }
  return {
    status: 'passed',
    engine: 'pptxgenjs-free-canvas',
    slideCount: slideNames.length,
    mediaCount: mediaNames.length,
    chartPartCount: chartNames.length,
    ...validation.evidence,
  };
}

const slideSchema = Type.Object({
  title: Type.Optional(Type.String()),
  subtitle: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  bullets: Type.Optional(Type.Array(Type.String())),
});

const presentationDesignSchema = Type.Object({
  themeFamily: Type.Optional(Type.Union([
    Type.Literal('product-launch'),
    Type.Literal('travel-editorial'),
    Type.Literal('executive-report'),
    Type.Literal('training-workshop'),
    Type.Literal('creative-editorial'),
  ])),
  audience: Type.Optional(Type.String()),
  purpose: Type.Optional(Type.String()),
  visualTone: Type.Optional(Type.String()),
  density: Type.Optional(Type.Union([Type.Literal('airy'), Type.Literal('balanced'), Type.Literal('dense')])),
});

const studioCoordinateSchema = Type.Number({ minimum: 0, maximum: 100 });
const studioSizeSchema = Type.Number({ exclusiveMinimum: 0, maximum: 100 });
const studioColorSchema = Type.String({ pattern: '^[0-9A-Fa-f]{6}$' });
const studioBoxSchema = {
  x: studioCoordinateSchema,
  y: studioCoordinateSchema,
  w: studioSizeSchema,
  h: studioSizeSchema,
};
const studioTextElementSchema = Type.Object({
  type: Type.Literal('text'),
  ...studioBoxSchema,
  text: Type.String(),
  role: Type.Optional(Type.Union([
    Type.Literal('title'), Type.Literal('subtitle'), Type.Literal('body'), Type.Literal('caption'), Type.Literal('metric'),
  ])),
  fontFace: Type.Optional(Type.String()),
  fontSize: Type.Optional(Type.Number({ minimum: 10, maximum: 96 })),
  color: Type.Optional(studioColorSchema),
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
  align: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right'), Type.Literal('justify')])),
  valign: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('mid'), Type.Literal('bottom')])),
  margin: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  fill: Type.Optional(studioColorSchema),
  fillTransparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  line: Type.Optional(studioColorSchema),
  lineWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })),
  lineTransparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  transparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  rotate: Type.Optional(Type.Number({ minimum: -360, maximum: 360 })),
  shadow: Type.Optional(Type.Boolean()),
  allowOverlap: Type.Optional(Type.Boolean()),
});
const studioImageElementSchema = Type.Object({
  type: Type.Literal('image'),
  ...studioBoxSchema,
  path: Type.String({ description: 'Absolute path, or path relative to the OpenClaw workspace, for a local PNG/JPEG/WebP asset.' }),
  fit: Type.Optional(Type.Union([Type.Literal('cover'), Type.Literal('contain')])),
  transparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  rotate: Type.Optional(Type.Number({ minimum: -360, maximum: 360 })),
  rounding: Type.Optional(Type.Boolean()),
  shadow: Type.Optional(Type.Boolean()),
  allowReuse: Type.Optional(Type.Boolean({ description: 'Allow intentional reuse of a brand asset such as a logo.' })),
});
const studioShapeElementSchema = Type.Object({
  type: Type.Literal('shape'),
  ...studioBoxSchema,
  shape: Type.Optional(Type.Union([
    Type.Literal('rect'), Type.Literal('roundRect'), Type.Literal('ellipse'), Type.Literal('line'), Type.Literal('chevron'),
    Type.Literal('hexagon'), Type.Literal('arc'), Type.Literal('triangle'), Type.Literal('diamond'),
  ])),
  fill: Type.Optional(studioColorSchema),
  fillTransparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  line: Type.Optional(studioColorSchema),
  lineWidth: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })),
  lineTransparency: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  rotate: Type.Optional(Type.Number({ minimum: -360, maximum: 360 })),
  shadow: Type.Optional(Type.Boolean()),
});
const studioChartElementSchema = Type.Object({
  type: Type.Literal('chart'),
  ...studioBoxSchema,
  chartType: Type.Union([
    Type.Literal('column'), Type.Literal('bar'), Type.Literal('line'), Type.Literal('area'), Type.Literal('pie'), Type.Literal('doughnut'),
  ]),
  title: Type.Optional(Type.String()),
  categories: Type.Array(Type.String(), { minItems: 1 }),
  series: Type.Array(Type.Object({
    name: Type.String(),
    values: Type.Array(Type.Number(), { minItems: 1 }),
    color: Type.Optional(studioColorSchema),
  }), { minItems: 1 }),
  showLegend: Type.Optional(Type.Boolean()),
  legendPosition: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('bottom'), Type.Literal('left'), Type.Literal('right')])),
  showValue: Type.Optional(Type.Boolean()),
  showCategoryName: Type.Optional(Type.Boolean()),
  showPercent: Type.Optional(Type.Boolean()),
});
const studioTableElementSchema = Type.Object({
  type: Type.Literal('table'),
  ...studioBoxSchema,
  rows: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
  firstRowHeader: Type.Optional(Type.Boolean()),
  headerFill: Type.Optional(studioColorSchema),
  headerColor: Type.Optional(studioColorSchema),
  bodyFill: Type.Optional(studioColorSchema),
  bodyColor: Type.Optional(studioColorSchema),
  borderColor: Type.Optional(studioColorSchema),
  fontSize: Type.Optional(Type.Number({ minimum: 10, maximum: 24 })),
  margin: Type.Optional(Type.Number({ minimum: 0, maximum: 12 })),
  columnWidths: Type.Optional(Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 100 }), { minItems: 1 })),
});
const studioSlideSchema = Type.Object({
  background: Type.Optional(studioColorSchema),
  speakerNotes: Type.Optional(Type.String()),
  elements: Type.Array(Type.Union([
    studioTextElementSchema,
    studioImageElementSchema,
    studioShapeElementSchema,
    studioChartElementSchema,
    studioTableElementSchema,
  ]), { minItems: 1 }),
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
      name: 'create_designed_pptx_file',
      label: 'Create Designed PPTX',
      description: 'Primary PPTX renderer for professional, visual presentations. Render a model-authored free-canvas deck with local images, charts, tables, shapes, and varied per-slide composition. Use the presentation-maker skill to plan and source assets first.',
      promptSnippet: 'create_designed_pptx_file: primary high-design PPTX tool. Plan the story and visual direction, source local visual assets, then call this tool in the same turn instead of announcing a future render. Render each slide on a 0-100 free canvas, vary compositions, and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.String(),
        subject: Type.Optional(Type.String()),
        author: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),
        designIntent: Type.String({ description: 'One concise visual direction tied to the subject and audience.' }),
        fonts: Type.Optional(Type.Object({
          heading: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
        })),
        slides: Type.Array(studioSlideSchema, { minItems: 1, maxItems: 40 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeStudioParams(params);
        const validation = validateStudioDeck(safeParams, ctx);
        if (!validation.ok) {
          const detail = `PPT studio quality gate blocked: ${validation.issues.join('; ')}`;
          return toolErrorResult(detail, {
            kind: 'presentation',
            title: cleanText(safeParams?.title),
            verification: {
              status: 'blocked',
              kind: 'artifact.content',
              required: true,
              severity: 'blocking',
              detail,
              evidence: JSON.stringify(validation.evidence),
            },
          });
        }
        const filePath = await uniqueOutputPath(ctx, safeParams, 'pptx', 'UClaw_Studio_PPT');
        const output = await createStudioPptxBuffer(safeParams, ctx);
        const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
        const verification = await verifyStudioPptxBuffer(buffer, safeParams, validation);
        await writeFile(filePath, buffer);
        return artifactResult(
          filePath,
          MIME.pptx,
          'presentation',
          cleanText(safeParams?.title),
          safeParams?.openAfterCreate === true,
          { verification, designIntent: cleanText(safeParams?.designIntent) },
        );
      },
    },
    {
      name: 'create_pptx_file',
      label: 'Create Basic PPTX',
      description: 'Lightweight fallback PPTX renderer with built-in semantic themes. Use only when create_designed_pptx_file cannot be satisfied; it is not the primary route for visual or high-design presentations.',
      promptSnippet: 'create_pptx_file: fallback-only basic PPTX renderer. Prefer create_designed_pptx_file for professional or visual decks; if fallback is necessary, keep slides[0] as the cover and return MEDIA:<absolute-path>.',
      parameters: Type.Object({
        ...baseFileSchema,
        title: Type.Optional(Type.String()),
        subtitle: Type.Optional(Type.String()),
        footer: Type.Optional(Type.String()),
        presentationDesign: Type.Optional(presentationDesignSchema),
        slides: Type.Array(slideSchema, { minItems: 1 }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const safeParams = normalizeBrandValue(params);
        const filePath = await uniqueOutputPath(ctx, safeParams, 'pptx', 'UClaw_PPT');
        const buffer = await createPptxBuffer(safeParams);
        const verification = await verifyPptxBuffer(buffer, safeParams);
        await writeFile(filePath, buffer);
        return artifactResult(filePath, MIME.pptx, 'presentation', cleanText(safeParams?.title), safeParams?.openAfterCreate === true, { verification });
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
  createStudioPptxBuffer,
  validateStudioDeck,
  verifyStudioPptxBuffer,
  createDocxBuffer,
  createXlsxBuffer,
  renderTextContent,
  renderHtmlApp,
  validateHtmlAppContent,
  uniqueOutputPath,
};
