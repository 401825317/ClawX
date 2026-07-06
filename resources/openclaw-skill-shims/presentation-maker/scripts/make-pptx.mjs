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
    'Input JSON: { "title": "...", "subtitle": "...", "slides": [{ "title": "...", "bullets": ["..."] }] }',
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
  const slides = [];

  slides.push({ kind: 'title', title, subtitle, bullets: [] });
  for (let i = 0; i < inputSlides.length; i += 1) {
    slides.push({ kind: 'content', ...normalizeSlide(inputSlides[i], i) });
  }
  if (slides.length === 1) {
    slides.push({ kind: 'content', title: '核心内容', bullets: ['请根据需求补充要点。'] });
  }

  return { title, footer, slides };
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
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="UClaw">
  <a:themeElements>
    <a:clrScheme name="UClaw">
      <a:dk1><a:srgbClr val="111827"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="10B981"/></a:accent2>
      <a:accent3><a:srgbClr val="F59E0B"/></a:accent3>
      <a:accent4><a:srgbClr val="EF4444"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
      <a:accent6><a:srgbClr val="06B6D4"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
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

function rectShape(id, x, y, w, h, color) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="Accent ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>`;
}

function paragraphXml(text, options = {}) {
  const size = Math.round((options.size ?? 24) * 100);
  const color = options.color ?? '1F2937';
  const bold = options.bold ? ' b="1"' : '';
  const bullet = options.bullet ? '<a:buChar char="•"/>' : '';
  const pPr = options.bullet
    ? `<a:pPr marL="342900" indent="-228600">${bullet}<a:defRPr sz="${size}"/></a:pPr>`
    : `<a:pPr><a:defRPr sz="${size}"/></a:pPr>`;
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
  return textShape(id, 'Footer', inch(0.65), inch(6.95), inch(12.0), inch(0.25), [
    { text, size: 9, color: '64748B' },
  ]);
}

function slideXml(slide, index, footer) {
  const shapes = [emptyGroupShapeXml()];
  let nextId = 2;

  if (slide.kind === 'title') {
    shapes.push(rectShape(nextId++, inch(0), inch(0), inch(0.16), SLIDE_H, '2563EB'));
    shapes.push(textShape(nextId++, 'Title', inch(0.75), inch(2.05), inch(11.8), inch(0.9), [
      { text: slide.title, size: 38, bold: true, color: '0F172A' },
    ], { anchor: 'mid' }));
    if (slide.subtitle) {
      shapes.push(textShape(nextId++, 'Subtitle', inch(0.78), inch(3.05), inch(11.4), inch(0.6), [
        { text: slide.subtitle, size: 18, color: '475569' },
      ]));
    }
    shapes.push(rectShape(nextId++, inch(0.78), inch(3.9), inch(2.2), inch(0.06), '10B981'));
  } else {
    shapes.push(rectShape(nextId++, inch(0), inch(0), SLIDE_W, inch(0.12), '2563EB'));
    shapes.push(textShape(nextId++, 'Slide Title', inch(0.65), inch(0.42), inch(12.0), inch(0.65), [
      { text: slide.title, size: 27, bold: true, color: '0F172A' },
    ]));
    if (slide.subtitle) {
      shapes.push(textShape(nextId++, 'Subtitle', inch(0.67), inch(1.1), inch(12.0), inch(0.35), [
        { text: slide.subtitle, size: 12, color: '64748B' },
      ]));
    }
    const bullets = (slide.bullets.length > 0 ? slide.bullets : [' ']).slice(0, 9);
    shapes.push(textShape(nextId++, 'Bullets', inch(0.9), inch(slide.subtitle ? 1.58 : 1.35), inch(11.55), inch(5.2), bullets.map((text) => ({
      text,
      bullet: true,
      size: bullets.length > 6 ? 17 : 20,
      color: '1F2937',
    }))));
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
