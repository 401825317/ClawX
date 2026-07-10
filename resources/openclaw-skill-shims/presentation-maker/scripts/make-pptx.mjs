#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import JSZip from 'jszip';

const EMU_PER_INCH = 914400;
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function usage() {
  return [
    'Usage: node make-pptx.mjs --input deck.json --out deck.pptx',
    '',
    'Input JSON: { "title": "...", "subtitle": "...", "slides": [{ "title": "cover", "subtitle": "..." }, { "title": "...", "bullets": ["..."] }] }',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--input' || key === '-i') {
      args.input = value;
      i += 1;
    } else if (key === '--out' || key === '-o') {
      args.out = value;
      i += 1;
    } else if (key === '--help' || key === '-h') {
      args.help = true;
    }
  }
  return args;
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function inch(value) {
  return Math.round(value * EMU_PER_INCH);
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeSlide(raw, index) {
  if (typeof raw === 'string') {
    return { title: `第 ${index + 1} 页`, bullets: [cleanText(raw)] };
  }
  const title = cleanText(raw?.title) || `第 ${index + 1} 页`;
  const bullets = Array.isArray(raw?.bullets)
    ? raw.bullets.map(cleanText).filter(Boolean)
    : [];
  const body = cleanText(raw?.body);
  return {
    title,
    subtitle: cleanText(raw?.subtitle),
    bullets: bullets.length > 0 ? bullets : (body ? [body] : []),
  };
}

function normalizeDeck(spec) {
  const title = cleanText(spec?.title) || '演示文稿';
  const subtitle = cleanText(spec?.subtitle);
  const footer = cleanText(spec?.footer);
  const inputSlides = Array.isArray(spec?.slides) ? spec.slides : [];
  if (inputSlides.length === 0) throw new Error('presentation-maker requires slides with the first slide as the cover');
  const slides = inputSlides.map((slide, index) => ({
    kind: index === 0 ? 'title' : 'content',
    ...normalizeSlide(slide, index),
    ...(index === 0 && !cleanText(slide?.title) ? { title } : {}),
    ...(index === 0 && !cleanText(slide?.subtitle) && subtitle ? { subtitle } : {}),
  }));

  const themeFamily = presentationThemeFamily(spec);
  return { title, footer, slides, themeFamily, theme: PRESENTATION_THEMES[themeFamily] };
}

function relsXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
${relationships.map((rel) => `  <Relationship Id="${rel.id}" Type="${rel.type}" Target="${xml(rel.target)}"/>`).join('\n')}
</Relationships>`;
}

function contentTypesXml(slideCount) {
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

function appXml(slideCount) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>UClaw Presentation Maker</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <ScaleCrop>false</ScaleCrop>
  <DocSecurity>0</DocSecurity>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>`;
}

function presentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, idx) => (
    `    <p:sldId id="${256 + idx}" r:id="rId${idx + 2}"/>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="wide"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle>
    <a:defPPr>
      <a:defRPr lang="zh-CN"/>
    </a:defPPr>
  </p:defaultTextStyle>
</p:presentation>`;
}

function themeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="UClaw ${xml(ACTIVE_THEME.name)}">
  <a:themeElements>
    <a:clrScheme name="UClaw ${xml(ACTIVE_THEME.name)}">
      <a:dk1><a:srgbClr val="${PALETTE.slate}"/></a:dk1>
      <a:lt1><a:srgbClr val="${PALETTE.white}"/></a:lt1>
      <a:dk2><a:srgbClr val="${PALETTE.navy2}"/></a:dk2>
      <a:lt2><a:srgbClr val="${PALETTE.bg}"/></a:lt2>
      <a:accent1><a:srgbClr val="${PALETTE.blue}"/></a:accent1>
      <a:accent2><a:srgbClr val="${PALETTE.green}"/></a:accent2>
      <a:accent3><a:srgbClr val="${PALETTE.amber}"/></a:accent3>
      <a:accent4><a:srgbClr val="${PALETTE.red}"/></a:accent4>
      <a:accent5><a:srgbClr val="${PALETTE.purple}"/></a:accent5>
      <a:accent6><a:srgbClr val="${PALETTE.cyan}"/></a:accent6>
      <a:hlink><a:srgbClr val="${PALETTE.blue}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${PALETTE.purple}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="UClaw">
      <a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont>
      <a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="UClaw">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function emptyGroupShapeXml() {
  return `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>${emptyGroupShapeXml()}</p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr marL="342900" indent="-228600"><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree>${emptyGroupShapeXml()}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

const PRESENTATION_THEMES = {
  'product-launch': { name: 'Product Launch', coverStyle: 'stage', contentStyle: 'rail', navy: '09090B', navy2: '111827', blue: '00A7C4', cyan: '22D3EE', green: '00A7C4', amber: '7C3AED', red: 'E11D48', purple: '7C3AED', slate: '171923', body: '333849', muted: '5A6475', line: 'CBD5E1', bg: 'F7F8FA', white: 'FFFFFF' },
  'travel-editorial': { name: 'Travel Editorial', coverStyle: 'editorial', contentStyle: 'band', navy: 'E7EFE8', navy2: '2F6B4F', blue: '2F6B4F', cyan: '8FB8A0', green: '2F6B4F', amber: 'D96C4C', red: 'B44D3B', purple: '7B6F9B', slate: '173B2C', body: '304D3D', muted: '65766B', line: 'B7CDBE', bg: 'FFFDF7', white: 'FFFFFF' },
  'executive-report': { name: 'Executive Report', coverStyle: 'report', contentStyle: 'grid', navy: 'F1F1ED', navy2: '1F4E5F', blue: 'B8423A', cyan: '5B8190', green: '1F4E5F', amber: 'B8423A', red: '9F2F2A', purple: '6D5B7B', slate: '191919', body: '303236', muted: '62666C', line: 'D4D6D8', bg: 'FFFFFF', white: 'FFFFFF' },
  'training-workshop': { name: 'Training Workshop', coverStyle: 'workshop', contentStyle: 'notebook', navy: 'FFF4C7', navy2: '315C8C', blue: '315C8C', cyan: '6B9AC4', green: '4C8B6B', amber: 'E79C13', red: 'C75146', purple: '765D9E', slate: '25314C', body: '3E4A63', muted: '667085', line: 'C8D6E3', bg: 'FFFDF6', white: 'FFFFFF' },
  'creative-editorial': { name: 'Creative Editorial', coverStyle: 'minimal', contentStyle: 'minimal', navy: 'F1EEFA', navy2: '4C3F6D', blue: '6D5BD0', cyan: '719FB0', green: '4D8B72', amber: 'D59A3A', red: 'C84B5A', purple: '6D5BD0', slate: '2A2040', body: '40394C', muted: '6B6575', line: 'D8D1E6', bg: 'FBFAFF', white: 'FFFFFF' },
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

let ACTIVE_THEME = PRESENTATION_THEMES['creative-editorial'];
let ACTIVE_THEME_FAMILY = 'creative-editorial';
let PALETTE = ACTIVE_THEME;
let ACCENTS = [PALETTE.blue, PALETTE.green, PALETTE.amber, PALETTE.purple, PALETTE.cyan, PALETTE.red];

function activateTheme(theme, themeFamily) {
  ACTIVE_THEME = theme;
  ACTIVE_THEME_FAMILY = themeFamily;
  PALETTE = theme;
  ACCENTS = [theme.blue, theme.green, theme.amber, theme.purple, theme.cyan, theme.red];
}

function rectShape(id, x, y, w, h, color, options = {}) {
  const prst = options.prst || 'rect';
  const line = options.lineColor
    ? `<a:ln w="${options.lineWidth || 9525}"><a:solidFill><a:srgbClr val="${options.lineColor}"/></a:solidFill><a:prstDash val="solid"/></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="Accent ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${line}</p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>`;
}

function paragraphXml(text, options = {}) {
  const size = Math.round((options.size ?? 24) * 100);
  const color = options.color ?? PALETTE.body;
  const bold = options.bold ? ' b="1"' : '';
  const bullet = options.bullet ? '<a:buChar char="•"/>' : '';
  const align = options.align ? ` algn="${options.align}"` : '';
  const pPr = options.bullet
    ? `<a:pPr marL="342900" indent="-228600"${align}>${bullet}<a:defRPr sz="${size}"/></a:pPr>`
    : `<a:pPr${align}><a:defRPr sz="${size}"/></a:pPr>`;
  return `<a:p>${pPr}<a:r><a:rPr lang="zh-CN" sz="${size}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xml(text)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`;
}

function textShape(id, name, x, y, w, h, paragraphs, options = {}) {
  const body = paragraphs.map((paragraph) => paragraphXml(paragraph.text, { ...options, ...paragraph })).join('');
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square" anchor="${options.anchor ?? 't'}"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

function footerShape(id, footer, slideNo) {
  const text = footer ? `${footer} · ${slideNo}` : String(slideNo);
  return textShape(id, 'Footer', inch(0.65), inch(6.92), inch(12.0), inch(0.25), [
    { text, size: 9, color: PALETTE.muted },
  ]);
}

function buildTitleSlideShapes(slide, nextId) {
  const shapes = [];
  shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, SLIDE_H, PALETTE.navy));
  const darkCover = ACTIVE_THEME.coverStyle === 'stage';
  if (ACTIVE_THEME.coverStyle === 'stage') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), inch(0.18), SLIDE_H, PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(10.35), inch(0), inch(2.99), SLIDE_H, PALETTE.navy2));
    shapes.push(textShape(nextId++, 'Stage Number', inch(10.65), inch(2.0), inch(2.2), inch(1.8), [
      { text: '01', size: 66, bold: true, color: PALETTE.blue, align: 'ctr' },
    ], { anchor: 'mid' }));
  } else if (ACTIVE_THEME.coverStyle === 'editorial') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, inch(0.34), PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(10.05), inch(0.34), inch(3.29), inch(7.16), PALETTE.amber));
  } else if (ACTIVE_THEME.coverStyle === 'report') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, inch(0.16), PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(9.55), inch(0.16), inch(3.79), inch(7.34), PALETTE.navy2));
  } else if (ACTIVE_THEME.coverStyle === 'workshop') {
    shapes.push(rectShape(nextId++, inch(0), inch(6.65), SLIDE_W, inch(0.85), PALETTE.navy2));
    shapes.push(rectShape(nextId++, inch(10.75), inch(0), inch(2.59), inch(1.55), PALETTE.amber));
  } else {
    shapes.push(rectShape(nextId++, inch(0), inch(0), inch(0.24), SLIDE_H, PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(10.1), inch(0.85), inch(2.35), inch(2.35), PALETTE.red));
  }
  const titleWidth = ACTIVE_THEME.coverStyle === 'editorial' || ACTIVE_THEME.coverStyle === 'report' ? 8.1 : 8.9;
  const titleColor = darkCover ? PALETTE.white : PALETTE.slate;
  shapes.push(textShape(nextId++, 'Deck Label', inch(0.92), inch(0.82), inch(4.4), inch(0.3), [
    { text: ACTIVE_THEME.name.toUpperCase(), size: 10, bold: true, color: PALETTE.blue },
  ]));
  shapes.push(textShape(nextId++, 'Title', inch(0.92), inch(1.65), inch(titleWidth), inch(1.8), [
    { text: slide.title, size: slide.title.length > 22 ? 32 : 40, bold: true, color: titleColor },
  ], { anchor: 'mid' }));
  if (slide.subtitle) {
    shapes.push(textShape(nextId++, 'Subtitle', inch(0.98), inch(3.8), inch(Math.min(titleWidth, 8.4)), inch(0.9), [
      { text: slide.subtitle, size: 17, color: darkCover ? 'C4C7D1' : PALETTE.muted },
    ]));
  }
  shapes.push(textShape(nextId++, `UClaw Theme ${ACTIVE_THEME_FAMILY}`, inch(12.9), inch(7.35), inch(0.1), inch(0.1), [
    { text: ACTIVE_THEME_FAMILY, size: 1, color: PALETTE.navy },
  ]));
  return { shapes, nextId };
}

function bulletCardShapes(startId, bullets, options = {}) {
  const shapes = [];
  let nextId = startId;
  const count = Math.min(Math.max(bullets.length, 1), 8);
  const cols = ACTIVE_THEME.contentStyle === 'band' || ACTIVE_THEME.contentStyle === 'minimal'
    ? 1
    : count <= 3 ? 1 : 2;
  const rows = Math.ceil(count / cols);
  const x0 = inch(0.78);
  const y0 = inch(options.y ?? 1.55);
  const gapX = inch(0.28);
  const gapY = inch(0.22);
  const cardW = cols === 1 ? inch(ACTIVE_THEME.contentStyle === 'minimal' ? 10.8 : 11.78) : inch(5.75);
  const cardH = Math.min(inch(1.18), Math.floor((inch(5.1) - gapY * (rows - 1)) / rows));
  const textSize = rows >= 4 ? 13 : rows === 3 ? 15 : 17;

  bullets.slice(0, count).forEach((text, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = x0 + col * (cardW + gapX);
    const y = y0 + row * (cardH + gapY);
    const accent = ACCENTS[index % ACCENTS.length];
    shapes.push(rectShape(nextId++, x, y, cardW, cardH, index % 2 === 0 ? PALETTE.white : PALETTE.bg, { prst: 'roundRect', lineColor: PALETTE.line }));
    shapes.push(rectShape(nextId++, x, y, inch(0.10), cardH, accent, { prst: 'rect' }));
    shapes.push(rectShape(nextId++, x + inch(0.34), y + inch(0.28), inch(0.46), inch(0.46), accent, { prst: 'ellipse' }));
    shapes.push(textShape(nextId++, `No ${index + 1}`, x + inch(0.34), y + inch(0.35), inch(0.46), inch(0.20), [
      { text: String(index + 1).padStart(2, '0'), size: 8, bold: true, color: PALETTE.white, align: 'ctr' },
    ], { anchor: 'mid' }));
    shapes.push(textShape(nextId++, `Point ${index + 1}`, x + inch(0.98), y + inch(0.20), cardW - inch(1.22), cardH - inch(0.30), [
      { text, size: textSize, color: PALETTE.body },
    ], { anchor: 'mid' }));
  });
  return { shapes, nextId };
}

function buildContentSlideShapes(slide, index, nextId) {
  const shapes = [];
  shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, SLIDE_H, PALETTE.bg));
  if (ACTIVE_THEME.contentStyle === 'rail') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), inch(0.16), SLIDE_H, PALETTE.blue));
  } else if (ACTIVE_THEME.contentStyle === 'band') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, inch(0.26), PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(11.2), inch(0.26), inch(2.14), inch(0.2), PALETTE.amber));
  } else if (ACTIVE_THEME.contentStyle === 'grid') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, inch(0.1), PALETTE.blue));
    shapes.push(rectShape(nextId++, inch(11.85), inch(0.42), inch(0.72), inch(0.58), PALETTE.navy2));
  } else if (ACTIVE_THEME.contentStyle === 'notebook') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), inch(0.3), SLIDE_H, PALETTE.navy2));
    shapes.push(rectShape(nextId++, inch(0.7), inch(1.45), inch(2.4), inch(0.1), PALETTE.amber));
  } else {
    shapes.push(rectShape(nextId++, inch(0.95), inch(0.32), inch(2.2), inch(0.1), PALETTE.blue));
  }
  shapes.push(textShape(nextId++, 'Section', inch(0.66), inch(0.34), inch(1.25), inch(0.25), [
    { text: `/${String(index).padStart(2, '0')}`, size: 11, bold: true, color: PALETTE.blue },
  ]));
  shapes.push(textShape(nextId++, 'Slide Title', inch(ACTIVE_THEME.contentStyle === 'minimal' ? 0.95 : 0.65), inch(0.66), inch(11.35), inch(0.52), [
    { text: slide.title, size: slide.title.length > 24 ? 22 : 25, bold: true, color: PALETTE.slate },
  ]));
  if (slide.subtitle) {
    shapes.push(textShape(nextId++, 'Subtitle', inch(0.67), inch(1.16), inch(10.9), inch(0.30), [
      { text: slide.subtitle, size: 11, color: PALETTE.muted },
    ]));
  }

  const bullets = (slide.bullets.length > 0 ? slide.bullets : [' ']).slice(0, 8);
  const cardResult = bulletCardShapes(nextId, bullets, { y: slide.subtitle ? 1.62 : 1.45 });
  shapes.push(...cardResult.shapes);
  nextId = cardResult.nextId;
  shapes.push(textShape(nextId++, `UClaw Theme ${ACTIVE_THEME_FAMILY}`, inch(12.9), inch(7.35), inch(0.1), inch(0.1), [
    { text: ACTIVE_THEME_FAMILY, size: 1, color: PALETTE.bg },
  ]));
  return { shapes, nextId };
}

function slideXml(slide, index, footer) {
  const shapes = [emptyGroupShapeXml()];
  let nextId = 2;

  if (slide.kind === 'title') {
    const result = buildTitleSlideShapes(slide, nextId);
    shapes.push(...result.shapes);
    nextId = result.nextId;
  } else {
    const result = buildContentSlideShapes(slide, index, nextId);
    shapes.push(...result.shapes);
    nextId = result.nextId;
  }

  shapes.push(footerShape(nextId++, footer, index + 1));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
${shapes.join('\n')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input || !args.out) {
    console.error(usage());
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = resolve(args.input);
  const outPath = resolve(args.out);
  const spec = JSON.parse((await readFile(inputPath, 'utf8')).replace(/^\uFEFF/, ''));
  const deck = normalizeDeck(spec);
  activateTheme(deck.theme, deck.themeFamily);
  const zip = new JSZip();

  zip.file('[Content_Types].xml', contentTypesXml(deck.slides.length));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', type: `${OFFICE_REL}/officeDocument`, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: `${PACKAGE_REL}/metadata/core-properties`, target: 'docProps/core.xml' },
    { id: 'rId3', type: `${OFFICE_REL}/extended-properties`, target: 'docProps/app.xml' },
  ]));
  zip.file('docProps/core.xml', coreXml(deck.title));
  zip.file('docProps/app.xml', appXml(deck.slides.length));
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
    const slideNo = idx + 1;
    zip.file(`ppt/slides/slide${slideNo}.xml`, slideXml(slide, idx, deck.footer));
    zip.file(`ppt/slides/_rels/slide${slideNo}.xml.rels`, relsXml([
      { id: 'rId1', type: `${OFFICE_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    ]));
  });

  await mkdir(dirname(outPath), { recursive: true });
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outPath, data);
  console.log(JSON.stringify({ ok: true, out: outPath, slides: deck.slides.length }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
