import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const PLUGIN_ID = 'uclaw-computer-use';
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const LOCAL_ACTION_REVISION_ID = `${PLUGIN_ID}:unfinished-local-action`;
const LOCAL_ACTION_REVISION_REASON = 'UClaw 本地动作最终回复仍像未执行的计划。';
const USER_FACING_CHINESE_RULE = '所有面向用户的进度、解释、问题和最终回复都必须使用简体中文；工具名、文件路径、命令和精确错误原文可以保留英文，但必须用中文解释。';
const LOCAL_ACTION_CONTEXT = [
  'UClaw 本地动作完成规则：',
  `- ${USER_FACING_CHINESE_RULE}`,
  '- 用户要求改变本地状态时，不要用承诺、计划或下一步打算结束回复。',
  '- “我现在下载并安装”“我先提取链接，再下载安装”“接下来我会处理”这类未来时回复都不算完成。',
  '- 用户要求 PPT、表格、文档、PDF、图片等具体产物时，只有在产物路径已经创建并验证，或遇到具体阻塞点时才能结束。',
  '- 用户要求生成 PPT/PPTX 时，优先调用 create_pptx_file 创建真实 .pptx 文件；不要只输出大纲或制作计划。',
  '- 用户要求生成 Word/DOCX/文档/报告时，优先调用 create_docx_file 创建真实 .docx 文件；不要只输出正文。',
  '- 用户要求生成 Excel/XLSX/表格时，优先调用 create_xlsx_file 创建真实 .xlsx 文件；不要只输出 Markdown 表格。',
  '- 用户要求“生成后打开/做完打开”时，在 create_pptx_file/create_docx_file/create_xlsx_file 中设置 openAfterCreate=true，不要再额外调用 exec/open。',
  '- 继续使用可用工具，直到请求的本地动作完成并验证、失败且有具体阻塞点，或需要用户明确确认。',
  '- 最终回复必须报告已验证的结果或具体阻塞点，不要只报告准备做什么。',
].join('\n');
const LOCAL_ACTION_PROMISE_RE = /(?:我(?:先|现在|会|将|要|再|继续)|(?:然后|接着|马上))(?:[^。！？\n]{0,80})(?:下载|安装|执行|继续|确认|检查|打开|复制|移动|写入|修改|启动|停止|重启|运行|处理|说明|完成)/u;
const LOCAL_ACTION_TASK_RE = /(?:下载|安装|\/Applications|本机|本地|文件|启动|停止|重启|运行|打开|复制|移动|写入|修改|设置|配置)/u;
const TERMINAL_STATE_RE = /(?:已(?:经)?(?:完成|安装|下载|启动|停止|重启|复制|移动|写入|修改|配置)|无法|失败|报错|需要(?:你|用户).{0,20}确认|请(?:你|用户).{0,20}确认|阻塞|权限|找不到|不存在|未找到)/u;
const CONTINUATION_STATE_RE = /(?:正在|我(?:会|将|要|再|继续|换|改用|准备|打算)|(?:先|再|然后|接着|下一步|马上).{0,40}(?:做|生成|创建|补|拉取|抓|写|导出|制作|运行|调用|下载|安装|验证|分析|处理))/u;
const DELIVERABLE_CONTRACTS = [
  {
    id: 'presentation',
    requestRe: /(?:(?:做|制作|生成|创建|输出|导出|整理成|做成).{0,24}(?:pptx?|PPT|演示文稿|幻灯片)|(?:pptx?|PPT|演示文稿|幻灯片).{0,24}(?:文件|下载|生成|创建|制作|导出|成稿|成品)|(?:create|make|generate|build|produce|export).{0,40}(?:pptx?|presentation|slide deck|slides?))/iu,
    evidenceRe: /(?:^|[\s`"'([{<（【“‘])(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>)\]}。！？；;，,]+\.pptx?\b|[^\s`"'<>)\]}。！？；;，,]+\.pptx\b/iu,
    instruction: '用户要求交付 PPT/演示文稿。继续使用工具，直到已经创建并验证 .ppt/.pptx 文件路径；如果无法继续，必须用简体中文报告具体阻塞点。',
    maxAttempts: 2,
  },
  {
    id: 'spreadsheet',
    requestRe: /(?:(?:做|制作|生成|创建|输出|导出|整理成|做成).{0,24}(?:xlsx?|Excel|表格|电子表格)|(?:xlsx?|Excel|表格|电子表格).{0,24}(?:文件|下载|生成|创建|制作|导出|成稿|成品)|(?:create|make|generate|build|produce|export).{0,40}(?:xlsx?|spreadsheet|excel))/iu,
    evidenceRe: /(?:^|[\s`"'([{<（【“‘])(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>)\]}。！？；;，,]+\.(?:xlsx?|csv|tsv)\b|[^\s`"'<>)\]}。！？；;，,]+\.(?:xlsx?|csv|tsv)\b/iu,
    instruction: '用户要求交付表格/电子表格。继续使用工具，直到已经创建并验证表格文件路径；如果无法继续，必须用简体中文报告具体阻塞点。',
    maxAttempts: 2,
  },
  {
    id: 'document',
    requestRe: /(?:(?:做|制作|生成|创建|输出|导出|整理成|做成).{0,24}(?:docx?|Word|文档|报告|PDF|pdf)|(?:docx?|Word|文档|报告|PDF|pdf).{0,24}(?:文件|下载|生成|创建|制作|导出|成稿|成品)|(?:create|make|generate|build|produce|export).{0,40}(?:docx?|document|report|pdf))/iu,
    evidenceRe: /(?:^|[\s`"'([{<（【“‘])(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>)\]}。！？；;，,]+\.(?:docx?|pdf|md)\b|[^\s`"'<>)\]}。！？；;，,]+\.(?:docx?|pdf|md)\b/iu,
    instruction: '用户要求交付文档/报告。继续使用工具，直到已经创建并验证文档文件路径；如果无法继续，必须用简体中文报告具体阻塞点。',
    maxAttempts: 2,
  },
  {
    id: 'image',
    requestRe: /(?:(?:画|绘制|制作|生成|创建|输出|导出|做成).{0,24}(?:图片|图像|海报|封面|插画|png|jpg|jpeg|webp)|(?:图片|图像|海报|封面|插画|png|jpg|jpeg|webp).{0,24}(?:文件|下载|生成|创建|制作|导出|成稿|成品)|(?:create|make|generate|draw|produce|export).{0,40}(?:image|picture|poster|cover|png|jpe?g|webp))/iu,
    evidenceRe: /(?:^|[\s`"'([{<（【“‘])(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>)\]}。！？；;，,]+\.(?:png|jpe?g|webp|gif|svg)\b|[^\s`"'<>)\]}。！？；;，,]+\.(?:png|jpe?g|webp|gif|svg)\b/iu,
    instruction: '用户要求交付图片产物。继续使用工具，直到已经创建并验证图片文件路径；如果无法继续，必须用简体中文报告具体阻塞点。',
    maxAttempts: 2,
  },
];
const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};
const MOUSE_BUTTON_SCHEMA = {
  type: 'string',
  enum: ['left', 'right', 'middle'],
  description: 'Mouse button to click.',
};
const KEY_SCHEMA = {
  type: 'string',
  description: 'Keyboard key name, such as enter, escape, tab, space, left, right, a, f5.',
};
const MODIFIERS_SCHEMA = {
  type: 'array',
  items: {
    type: 'string',
    enum: ['ctrl', 'control', 'shift', 'alt', 'win', 'meta'],
  },
  description: 'Modifier keys held while pressing the key.',
};
const WINDOW_ACTION_SCHEMA = {
  type: 'string',
  enum: ['focus', 'restore', 'minimize', 'maximize', 'close'],
  description: 'Window action to perform.',
};
const CONFIRMED_SCHEMA = {
  type: 'boolean',
  description: 'Set true only after user confirmation for mutating or risky actions. If omitted, the host returns requiresConfirmation without executing.',
};
const EXPECTED_FOREGROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Safety guard for global mouse/keyboard input. Pass the target foreground window from computer_system_window_list/computer_system_window_foreground; the host refuses input if another window is foreground.',
  properties: {
    hwnd: {
      type: 'number',
      description: 'Expected foreground window handle.',
    },
    titleIncludes: {
      type: 'string',
      description: 'Expected case-insensitive title substring when hwnd is unavailable.',
    },
    processName: {
      type: 'string',
      description: 'Expected process name, with or without .exe.',
    },
  },
};
const WINDOW_TARGET_PROPERTIES = {
  hwnd: {
    type: 'number',
    description: 'Window handle returned by computer_system_window_list.',
  },
  titleIncludes: {
    type: 'string',
    description: 'Fallback case-insensitive title substring to find a window.',
  },
};
const BROWSER_TARGET_PROPERTIES = {
  windowId: {
    type: 'integer',
    description: 'Optional Electron BrowserWindow id returned by computer_window_list. Defaults to the main UClaw window.',
  },
};
const ARTIFACT_OUTPUT_PATH_PROPERTY = {
  type: 'string',
  description: 'Optional absolute output file path. If omitted, UClaw writes a non-overwriting file under the user Downloads/UClaw folder.',
};
const ARTIFACT_OPEN_AFTER_CREATE_PROPERTY = {
  type: 'boolean',
  description: 'Open the created file with the system default application after it is written. Set true when the user asks to open the file after creation.',
};
const ARTIFACT_TITLE_PROPERTY = {
  type: 'string',
  description: 'Artifact title. Use the user requested title when available.',
};
const ARTIFACT_PARAGRAPH_ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description: 'Plain text paragraphs or bullet items.',
};
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const ARTIFACT_MIME_TYPES = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function compactTimestamp(date = new Date()) {
  return date.toISOString()
    .replace(/\.\d{3}Z$/u, 'Z')
    .replace(/[-:]/gu, '')
    .replace(/[TZ]/gu, '-')
    .replace(/-$/u, '');
}

function safeFileStem(value, fallback = 'uclaw-artifact') {
  const stem = cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
  return stem || fallback;
}

function expandHomePath(filePath) {
  const raw = cleanText(filePath);
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveArtifactOutputPath(kind, title, outputPath) {
  const ext = kind.startsWith('.') ? kind : `.${kind}`;
  let resolvedPath = expandHomePath(outputPath);
  if (resolvedPath) {
    if (!isAbsolute(resolvedPath)) {
      throw new Error(`outputPath must be absolute: ${outputPath}`);
    }
    if (extname(resolvedPath).toLowerCase() !== ext.toLowerCase()) {
      resolvedPath = `${resolvedPath}${ext}`;
    }
  } else {
    const dir = join(homedir(), 'Downloads', 'UClaw');
    const stem = safeFileStem(title, `uclaw-${kind}`);
    resolvedPath = join(dir, `${stem}-${compactTimestamp()}-${randomUUID().slice(0, 8)}${ext}`);
  }

  await mkdir(dirname(resolvedPath), { recursive: true });
  if (await exists(resolvedPath)) {
    const base = resolvedPath.slice(0, -ext.length);
    resolvedPath = `${base}-${randomUUID().slice(0, 8)}${ext}`;
  }
  return resolvedPath;
}

async function artifactResult(kind, filePath, extra = {}) {
  const info = await stat(filePath);
  const extension = kind.replace(/^\./u, '').toLowerCase();
  return {
    ok: true,
    kind: extension,
    filePath,
    media: `MEDIA:${filePath}`,
    mimeType: ARTIFACT_MIME_TYPES[extension] || 'application/octet-stream',
    fileSize: info.size,
    ...extra,
  };
}

function openArtifactFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    let command;
    let args;
    if (process.platform === 'darwin') {
      command = 'open';
      args = [filePath];
    } else if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', filePath];
    } else {
      command = 'xdg-open';
      args = [filePath];
    }

    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`Timed out opening ${filePath}`));
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Open command exited with code ${code}`));
      }
    });
    child.unref?.();
  });
}

async function maybeOpenArtifact(filePath, params = {}) {
  if (!params.openAfterCreate) return {};
  try {
    await openArtifactFile(filePath);
    return { opened: true };
  } catch (error) {
    return { opened: false, openError: error?.message || String(error) };
  }
}

function packageRelsXml(target) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="${xml(target)}"/>
  <Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${OFFICE_REL_NS}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function corePropertiesXml(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xml(title || 'UClaw Artifact')}</dc:title>
  <dc:creator>UClaw</dc:creator>
  <cp:lastModifiedBy>UClaw</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appPropertiesXml(application, extra = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>${xml(application)}</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
${extra}
  <AppVersion>1.0</AppVersion>
</Properties>`;
}

function normalizeDocSections(params) {
  const sections = Array.isArray(params?.sections) ? params.sections : [];
  if (sections.length > 0) {
    return sections.map((section, index) => ({
      heading: cleanText(section?.heading || section?.title || `第 ${index + 1} 节`),
      paragraphs: Array.isArray(section?.paragraphs)
        ? section.paragraphs.map(cleanText).filter(Boolean)
        : [],
      bullets: Array.isArray(section?.bullets)
        ? section.bullets.map(cleanText).filter(Boolean)
        : [],
    })).filter((section) => section.heading || section.paragraphs.length > 0 || section.bullets.length > 0);
  }

  const paragraphs = Array.isArray(params?.paragraphs)
    ? params.paragraphs.map(cleanText).filter(Boolean)
    : [];
  const bullets = Array.isArray(params?.bullets)
    ? params.bullets.map(cleanText).filter(Boolean)
    : [];
  return [{
    heading: cleanText(params?.heading || '正文'),
    paragraphs: paragraphs.length > 0 ? paragraphs : [cleanText(params?.body || '请根据需求补充文档内容。')],
    bullets,
  }];
}

function wordParagraph(text, style) {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${xml(style)}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function wordDocumentXml(title, sections) {
  const body = [
    wordParagraph(title || '文档', 'Title'),
    ...sections.flatMap((section) => [
      section.heading ? wordParagraph(section.heading, 'Heading1') : '',
      ...section.paragraphs.map((paragraph) => wordParagraph(paragraph)),
      ...section.bullets.map((bullet) => wordParagraph(`• ${bullet}`)),
    ]).filter(Boolean),
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NS}">
  <w:body>
${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function wordStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WORD_NS}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei" w:hAnsi="Arial"/></w:rPr>
    <w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:color w:val="0F172A"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
    <w:pPr><w:spacing w:after="420"/><w:jc w:val="center"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:color w:val="2563EB"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
    <w:pPr><w:spacing w:before="280" w:after="160"/></w:pPr>
  </w:style>
</w:styles>`;
}

async function createDocxArtifact(params = {}) {
  const title = cleanText(params.title) || 'UClaw 文档';
  const outputPath = await resolveArtifactOutputPath('docx', title, params.outputPath);
  const sections = normalizeDocSections(params);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CONTENT_TYPES_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', packageRelsXml('word/document.xml'));
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL_NS}"></Relationships>`);
  zip.file('word/document.xml', wordDocumentXml(title, sections));
  zip.file('word/styles.xml', wordStylesXml());
  zip.file('docProps/core.xml', corePropertiesXml(title));
  zip.file('docProps/app.xml', appPropertiesXml('UClaw Document Maker'));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, buffer);
  console.log(`[uclaw-artifact] create_docx_file wrote ${outputPath} (${buffer.length} bytes)`);
  const openState = await maybeOpenArtifact(outputPath, params);
  return artifactResult('docx', outputPath, { title, sections: sections.length, ...openState });
}

function sanitizeSheetName(name, index) {
  const cleaned = cleanText(name || `Sheet${index + 1}`)
    .replace(/[\[\]:*?/\\]/gu, ' ')
    .slice(0, 31)
    .trim();
  return cleaned || `Sheet${index + 1}`;
}

function normalizeSheets(params = {}) {
  const rawSheets = Array.isArray(params.sheets) && params.sheets.length > 0
    ? params.sheets
    : [{ name: cleanText(params.sheetName || 'Sheet1'), rows: params.rows }];
  return rawSheets.map((sheet, index) => {
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    return {
      name: sanitizeSheetName(sheet?.name, index),
      rows: rows.map((row) => (Array.isArray(row) ? row : [row])),
    };
  }).filter((sheet) => sheet.rows.length > 0);
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function worksheetXml(rows) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const columnWidths = Array.from({ length: columnCount }, (_, index) => {
    const maxLen = Math.max(8, ...rows.map((row) => cleanText(row[index] ?? '').length));
    return Math.min(36, Math.max(10, maxLen + 4));
  });
  const colsXml = `<cols>${columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`;
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((cell, cellIndex) => {
      const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : ' s="2"';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        return `<c r="${ref}"${style}><v>${cell}</v></c>`;
      }
      if (typeof cell === 'boolean') {
        return `<c r="${ref}" t="b"${style}><v>${cell ? 1 : 0}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(cell ?? '')}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ''}>${cells}</row>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${SPREADSHEET_NS}" xmlns:r="${OFFICE_REL_NS}">
${colsXml}
  <sheetData>
${rowXml}
  </sheetData>
</worksheet>`;
}

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${OFFICE_REL_NS}">
  <sheets>
${sheets.map((sheet, index) => `    <sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
  </sheets>
</workbook>`;
}

function workbookRelsXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PACKAGE_REL_NS}">
${sheets.map((_, index) => `  <Relationship Id="rId${index + 1}" Type="${OFFICE_REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n')}
  <Relationship Id="rId${sheets.length + 1}" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>
</Relationships>`;
}

async function createXlsxArtifact(params = {}) {
  const title = cleanText(params.title) || 'UClaw 表格';
  const sheets = normalizeSheets(params);
  if (sheets.length === 0) {
    throw new Error('create_xlsx_file requires at least one non-empty rows array');
  }
  const outputPath = await resolveArtifactOutputPath('xlsx', title, params.outputPath);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CONTENT_TYPES_NS}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, index) => `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file('_rels/.rels', packageRelsXml('xl/workbook.xml'));
  zip.file('xl/workbook.xml', workbookXml(sheets));
  zip.file('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets));
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${SPREADSHEET_NS}">
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border/>
    <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`);
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows));
  });
  zip.file('docProps/core.xml', corePropertiesXml(title));
  zip.file('docProps/app.xml', appPropertiesXml('UClaw Spreadsheet Maker', `  <Worksheets>${sheets.length}</Worksheets>\n`));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, buffer);
  console.log(`[uclaw-artifact] create_xlsx_file wrote ${outputPath} (${buffer.length} bytes, sheets=${sheets.length})`);
  const openState = await maybeOpenArtifact(outputPath, params);
  return artifactResult('xlsx', outputPath, { title, sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })), ...openState });
}

function normalizeDeck(params = {}) {
  const title = cleanText(params.title) || 'UClaw 演示文稿';
  const slides = Array.isArray(params.slides) ? params.slides : [];
  return {
    title,
    subtitle: cleanText(params.subtitle),
    footer: cleanText(params.footer || 'UClaw'),
    slides: slides.map((slide, index) => ({
      title: cleanText(slide?.title || `第 ${index + 1} 页`),
      subtitle: cleanText(slide?.subtitle),
      bullets: Array.isArray(slide?.bullets)
        ? slide.bullets.map(cleanText).filter(Boolean)
        : (cleanText(slide?.body) ? [cleanText(slide.body)] : []),
    })).filter((slide) => slide.title || slide.bullets.length > 0),
  };
}

async function findPptxGeneratorScript() {
  const candidates = [
    join(process.cwd(), 'skills', 'presentation-maker', 'scripts', 'make-pptx.mjs'),
    join(__dirname, '..', '..', 'openclaw-skill-shims', 'presentation-maker', 'scripts', 'make-pptx.mjs'),
    join(__dirname, 'scripts', 'make-pptx.mjs'),
  ].map((candidate) => resolve(candidate));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`presentation-maker generator not found. Checked: ${candidates.join(', ')}`);
}

function spawnNode(script, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd || dirname(script),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`Timed out running ${script}`));
    }, options.timeoutMs || 60_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`Generator exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function createPptxArtifact(params = {}) {
  const deck = normalizeDeck(params);
  if (deck.slides.length === 0) {
    deck.slides.push({ title: '核心内容', bullets: ['请根据需求补充要点。'] });
  }
  const outputPath = await resolveArtifactOutputPath('pptx', deck.title, params.outputPath);
  const script = await findPptxGeneratorScript();
  const tempDir = join(tmpdir(), 'uclaw-artifacts');
  await mkdir(tempDir, { recursive: true });
  const inputPath = join(tempDir, `deck-${compactTimestamp()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(inputPath, JSON.stringify(deck, null, 2), 'utf8');
  await spawnNode(script, ['--input', inputPath, '--out', outputPath], { timeoutMs: 60_000 });
  console.log(`[uclaw-artifact] create_pptx_file wrote ${outputPath} (slides=${deck.slides.length}, generator=${script})`);
  const openState = await maybeOpenArtifact(outputPath, params);
  return artifactResult('pptx', outputPath, { title: deck.title, slides: deck.slides.length, ...openState });
}

function resolveHostApiOrigin() {
  return (process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function resolveHostApiToken() {
  const token = process.env.CLAWX_HOST_API_TOKEN || '';
  if (!token.trim()) {
    throw new Error('UClaw Host API token is not available for computer-use tools');
  }
  return token;
}

function messageContainsToolActivity(message) {
  if (!message || typeof message !== 'object') return false;
  if (typeof message.toolName === 'string' && message.toolName.trim()) return true;
  if (typeof message.tool_call_id === 'string' && message.tool_call_id.trim()) return true;
  if (typeof message.toolCallId === 'string' && message.toolCallId.trim()) return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return true;
  if (message.role === 'tool' || message.role === 'toolResult' || message.role === 'tool_result' || message.role === 'toolresult') return true;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && typeof part === 'object' && (
    part.type === 'toolCall'
    || part.type === 'toolResult'
    || part.type === 'tool_use'
    || part.type === 'tool_result'
    || typeof part.toolCallId === 'string'
    || typeof part.tool_call_id === 'string'
    || typeof part.name === 'string'
  ));
}

function hasToolActivity(messages) {
  return Array.isArray(messages) && messages.some(messageContainsToolActivity);
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return typeof part.text === 'string' ? part.text : '';
  }).join('\n').trim();
}

function extractFinalAssistantText(event) {
  const directCandidates = [
    event?.lastAssistantMessage,
    event?.assistantText,
    event?.assistantMessage,
    event?.finalAssistantMessage,
    event?.finalText,
    event?.reply,
    event?.message,
    event?.response,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const text = extractTextFromContent(candidate.content);
      if (text) return text;
    }
  }

  const messageLists = [
    event?.messages,
    event?.messagesSnapshot,
    event?.finalMessages,
    event?.transcript,
    event?.conversation,
  ];
  for (const messages of messageLists) {
    if (!Array.isArray(messages)) continue;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
      const text = extractTextFromContent(message.content);
      if (text) return text;
    }
  }
  return '';
}

function extractUserRequestText(event) {
  const directCandidates = [
    event?.userMessage,
    event?.userPrompt,
    event?.prompt,
    event?.request,
    event?.input,
    event?.finalPromptText,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const text = extractTextFromContent(candidate.content);
      if (text) return text;
    }
  }

  for (const messages of extractMessageLists(event)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || message.role !== 'user') continue;
      const text = extractTextFromContent(message.content);
      if (text) return text;
    }
  }
  return '';
}

function extractMessageLists(event) {
  return [
    event?.messages,
    event?.messagesSnapshot,
    event?.finalMessages,
    event?.transcript,
    event?.conversation,
  ].filter(Array.isArray);
}

function isConcreteTerminalState(text) {
  return TERMINAL_STATE_RE.test(text) && !CONTINUATION_STATE_RE.test(text);
}

function isToolResultMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = typeof message.role === 'string' ? message.role : '';
  return role === 'tool'
    || role === 'toolResult'
    || role === 'tool_result'
    || role === 'toolresult'
    || typeof message.tool_call_id === 'string'
    || typeof message.toolCallId === 'string';
}

function extractSearchableMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [extractTextFromContent(message.content)];
  if (typeof message.text === 'string') parts.push(message.text);
  if (typeof message.output === 'string') parts.push(message.output);
  if (typeof message.result === 'string') parts.push(message.result);
  if (message.details && typeof message.details === 'object') {
    try {
      parts.push(JSON.stringify(message.details));
    } catch {
      // Ignore non-serializable tool details.
    }
  }
  return parts.filter(Boolean).join('\n');
}

function hasDeliverableEvidence(contract, event, finalText) {
  if (contract.evidenceRe.test(finalText)) return true;
  return extractMessageLists(event).some((messages) => messages.some((message) => {
    if (!isToolResultMessage(message)) return false;
    return contract.evidenceRe.test(extractSearchableMessageText(message));
  }));
}

function resolveUnfinishedDeliverable(event, finalText) {
  const userText = extractUserRequestText(event);
  if (!userText || isConcreteTerminalState(finalText)) return null;
  for (const contract of DELIVERABLE_CONTRACTS) {
    if (!contract.requestRe.test(userText)) continue;
    if (hasDeliverableEvidence(contract, event, finalText)) continue;
    return contract;
  }
  return null;
}

function resolveUnfinishedLocalActionRevision(event) {
  const text = extractFinalAssistantText(event);
  if (!text) return null;

  const unfinishedDeliverable = resolveUnfinishedDeliverable(event, text);
  if (unfinishedDeliverable) {
    return {
      instruction: unfinishedDeliverable.instruction,
      maxAttempts: unfinishedDeliverable.maxAttempts,
    };
  }

  if (isConcreteTerminalState(text)) return null;
  if (!extractMessageLists(event).some(hasToolActivity)) return null;
  if (!LOCAL_ACTION_TASK_RE.test(text) || !LOCAL_ACTION_PROMISE_RE.test(text)) return null;
  return {
    instruction: '上一条回复只是描述未来要做的本地动作，还没有完成用户请求。现在继续调用合适的工具；如果工具无法继续，必须用简体中文说明具体阻塞点。',
    maxAttempts: 1,
  };
}

function buildLocalActionRevision(revision) {
  return {
    action: 'revise',
    reason: [LOCAL_ACTION_REVISION_REASON, revision.instruction].join('\n'),
    retry: {
      idempotencyKey: LOCAL_ACTION_REVISION_ID,
      maxAttempts: revision.maxAttempts,
      instruction: [
        '上一条回复只是描述未来要做的本地动作，还没有完成用户请求。',
        '不要再发送计划、承诺或英文状态说明。',
        revision.instruction,
        '只有在本地动作已完成并验证、失败且有具体错误、或需要用户明确确认时，才能结束。',
        USER_FACING_CHINESE_RULE,
      ].join('\n'),
    },
  };
}

function registerLocalActionCompletionGuard(api) {
  if (typeof api.registerHook !== 'function') return;
  api.registerHook('before_prompt_build', () => ({
    appendSystemContext: LOCAL_ACTION_CONTEXT,
  }), {
    name: `${PLUGIN_ID}:local-action-context`,
    description: '为每轮 agent 添加 UClaw 本地动作完成规则。',
  });

  api.registerHook('before_agent_finalize', (event) => {
    const revision = resolveUnfinishedLocalActionRevision(event);
    if (!revision) return;
    return buildLocalActionRevision(revision);
  }, {
    name: LOCAL_ACTION_REVISION_ID,
    description: '避免 UClaw 用尚未执行的未来时承诺结束本地动作任务。',
  });
}

async function hostApiFetch(path, options = {}) {
  const response = await fetch(`${resolveHostApiOrigin()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${resolveHostApiToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.success === false) {
    const message = payload?.error || `Host API request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function summarizeScreenshot(payload) {
  const screenshot = payload?.screenshot || payload?.result;
  if (!screenshot?.filePath) {
    return payload;
  }
  return {
    filePath: screenshot.filePath,
    mimeType: screenshot.mimeType || 'image/png',
    fileSize: screenshot.fileSize,
    width: screenshot.width,
    height: screenshot.height,
    sourceName: screenshot.sourceName,
    sourceId: screenshot.sourceId,
    display: screenshot.display,
    windowBounds: screenshot.windowBounds,
    coordinateMapping: screenshot.coordinateMapping,
    note: 'Desktop screenshot captured with width/height and coordinateMapping metadata. Treat filePath as visual context for the current chat model. Do not run Python/PIL or shell scripts to read image dimensions; use width, height, and coordinateMapping. Do not call the standalone image tool without an explicit current-session vision model.',
  };
}

function summarizeInspection(payload) {
  const result = payload?.result || payload;
  const screenshot = result?.screenshot;
  return {
    screenshot: screenshot
      ? {
        filePath: screenshot.filePath,
        mimeType: screenshot.mimeType || 'image/png',
        fileSize: screenshot.fileSize,
        width: screenshot.width,
        height: screenshot.height,
        sourceName: screenshot.sourceName,
        sourceId: screenshot.sourceId,
        display: screenshot.display,
        windowBounds: screenshot.windowBounds,
        coordinateMapping: screenshot.coordinateMapping,
      }
      : null,
    ocr: result?.ocr || {
      supported: false,
      text: '',
      blocks: [],
      reason: 'No OCR result returned.',
    },
    note: 'If OCR text is insufficient, treat the screenshot filePath as visual context for the current chat model. Use screenshot width/height and coordinateMapping for coordinates; do not run Python/PIL or shell scripts to read image dimensions. Do not call the standalone image tool without an explicit current-session vision model.',
  };
}

function resultOrPayload(payload) {
  return payload?.result || payload;
}

export const pluginEntry = defineToolPlugin({
  id: PLUGIN_ID,
  name: 'UClaw Computer Use',
  description: 'Native UClaw computer-use tools for desktop observation and action: screenshots, OCR-ready inspection, Windows UI Automation, system window control, clipboard, mouse, keyboard, file dialogs, and UClaw window DOM inspection. Use these for desktop/Chrome/window/screenshot/click/type tasks when computer_* tools are available.',
  tools: (tool) => [
    tool({
      name: 'create_pptx_file',
      label: 'Create PowerPoint file',
      description: 'Create a real local .pptx presentation file from structured title/subtitle/slides. Use this whenever the user asks to make, generate, export, or deliver a PPT/PPTX/presentation/slide deck. Do not answer with only an outline when a PPT file is requested.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'slides'],
        properties: {
          title: ARTIFACT_TITLE_PROPERTY,
          subtitle: {
            type: 'string',
            description: 'Optional presentation subtitle.',
          },
          footer: {
            type: 'string',
            description: 'Optional footer text. Defaults to UClaw.',
          },
          slides: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title'],
              properties: {
                title: { type: 'string', description: 'Slide title.' },
                subtitle: { type: 'string', description: 'Optional slide subtitle.' },
                bullets: ARTIFACT_PARAGRAPH_ARRAY_SCHEMA,
                body: { type: 'string', description: 'Optional paragraph body when bullets are not suitable.' },
              },
            },
            description: 'Slides to create. Prefer concise Chinese slide titles and 3-7 bullet points per slide unless the user asks otherwise.',
          },
          outputPath: ARTIFACT_OUTPUT_PATH_PROPERTY,
          openAfterCreate: ARTIFACT_OPEN_AFTER_CREATE_PROPERTY,
        },
      },
      execute: async (params) => createPptxArtifact(params || {}),
    }),
    tool({
      name: 'create_docx_file',
      label: 'Create Word document',
      description: 'Create a real local .docx Word document from structured title, paragraphs, bullets, and sections. Use this whenever the user asks to make, generate, export, or deliver a Word/DOCX/document/report file. Do not answer with only text when a document file is requested.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: ARTIFACT_TITLE_PROPERTY,
          heading: {
            type: 'string',
            description: 'Optional first section heading when sections are not provided.',
          },
          body: {
            type: 'string',
            description: 'Optional body text when paragraphs are not provided.',
          },
          paragraphs: ARTIFACT_PARAGRAPH_ARRAY_SCHEMA,
          bullets: ARTIFACT_PARAGRAPH_ARRAY_SCHEMA,
          sections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                heading: { type: 'string', description: 'Section heading.' },
                title: { type: 'string', description: 'Alias for heading.' },
                paragraphs: ARTIFACT_PARAGRAPH_ARRAY_SCHEMA,
                bullets: ARTIFACT_PARAGRAPH_ARRAY_SCHEMA,
              },
            },
            description: 'Optional document sections. Prefer this for multi-section reports.',
          },
          outputPath: ARTIFACT_OUTPUT_PATH_PROPERTY,
          openAfterCreate: ARTIFACT_OPEN_AFTER_CREATE_PROPERTY,
        },
      },
      execute: async (params) => createDocxArtifact(params || {}),
    }),
    tool({
      name: 'create_xlsx_file',
      label: 'Create Excel spreadsheet',
      description: 'Create a real local .xlsx spreadsheet file from rows or multiple sheets. Use this whenever the user asks to make, generate, export, or deliver an Excel/XLSX/spreadsheet/table file. Do not answer with only a Markdown table when a spreadsheet file is requested.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: ARTIFACT_TITLE_PROPERTY,
          sheetName: {
            type: 'string',
            description: 'Sheet name when rows are provided directly.',
          },
          rows: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                ],
              },
            },
            description: 'Rows for a single-sheet spreadsheet. First row should usually be headers.',
          },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rows'],
              properties: {
                name: { type: 'string', description: 'Worksheet name.' },
                rows: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'number' },
                        { type: 'boolean' },
                        { type: 'null' },
                      ],
                    },
                  },
                },
              },
            },
            description: 'Optional multiple worksheets. Use this instead of rows for multi-sheet workbooks.',
          },
          outputPath: ARTIFACT_OUTPUT_PATH_PROPERTY,
          openAfterCreate: ARTIFACT_OPEN_AFTER_CREATE_PROPERTY,
        },
      },
      execute: async (params) => createXlsxArtifact(params || {}),
    }),
    tool({
      name: 'computer_screenshot',
      label: 'Capture desktop screenshot',
      description: 'Capture the current full desktop screen and return the saved PNG file path, width, height, display bounds, scale factor, and coordinateMapping. Use this when the user asks to see, inspect, or screenshot their current screen. The screenshot is visual context for the current chat model; avoid standalone image-tool fallbacks unless you pass the current session vision model explicitly. Never run Python/PIL just to read image dimensions.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => summarizeScreenshot(await hostApiFetch('/api/computer/screenshot', {
        method: 'POST',
        body: '{}',
      })),
    }),
    tool({
      name: 'computer_inspect_screen',
      label: 'Inspect screen',
      description: 'Capture the desktop or a window and return a screenshot artifact plus width, height, coordinateMapping, and OCR status. Use this as the first observation step for visual desktop tasks. If OCR is unsupported, use the returned screenshot file path as current-model visual context, not as a reason to call the standalone image tool without an explicit model. Never run Python/PIL just to read image dimensions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            enum: ['desktop', 'window'],
            description: 'Whether to inspect the full desktop or a specific application window. Defaults to desktop.',
          },
          sourceId: {
            type: 'string',
            description: 'Window source id returned by computer_window_sources when target is window.',
          },
          titleIncludes: {
            type: 'string',
            description: 'Fallback case-insensitive title substring for window inspection.',
          },
        },
      },
      execute: async (params) => summarizeInspection(await hostApiFetch('/api/computer/inspect', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_clipboard_read',
      label: 'Read clipboard text',
      description: 'Read plain text from the local system clipboard.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => {
        const payload = await hostApiFetch('/api/computer/clipboard/read', {
          method: 'POST',
          body: '{}',
        });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_clipboard_write',
      label: 'Write clipboard text',
      description: 'Write plain text to the local system clipboard.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Text to write to the clipboard.',
          },
        },
      },
      execute: async ({ text }) => {
        const payload = await hostApiFetch('/api/computer/clipboard/write', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_window_list',
      label: 'List app windows',
      description: 'List UClaw/Electron application windows known to the local host, including title, bounds, focus, visible, and minimized state.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => {
        const payload = await hostApiFetch('/api/computer/windows', { method: 'GET' });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_browser_open_url',
      label: 'Open URL in browser',
      description: 'Open an absolute http/https URL in the system default browser. Use this before window focusing when the task asks to open a website or no existing Chrome/Edge window is available. Prefer this over exec/explorer/start/chrome shell launches for desktop browser automation; exec remains appropriate for normal local commands, logs, tests, and scripts. Requires confirmed=true because it changes the desktop state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http or https URL to open.',
          },
          confirmed: CONFIRMED_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/open-url', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_list',
      label: 'List system windows',
      description: 'List normal Windows desktop application windows by title/process, including hwnd, title, process, visible/minimized state, and bounds. Use this before controlling an already-open Chrome/Edge/native desktop app window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titleIncludes: {
            type: 'string',
            description: 'Optional case-insensitive title substring filter.',
          },
          processName: {
            type: 'string',
            description: 'Optional process name filter, for example chrome or notepad.',
          },
          visibleOnly: {
            type: 'boolean',
            description: 'Whether to include only visible windows. Defaults to true.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of windows to return. Defaults to 80.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-windows', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_control',
      label: 'Control system window',
      description: 'Focus, restore, minimize, maximize, or close a Windows desktop application window. Prefer hwnd from computer_system_window_list; titleIncludes is a fallback. Focus/restore waits briefly and returns foregroundMatched/foreground when available; verify that match before mouse or keyboard actions against Chrome/desktop apps.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          action: WINDOW_ACTION_SCHEMA,
          confirmed: CONFIRMED_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/control', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_foreground',
      label: 'Get foreground window',
      description: 'Return the current foreground Windows desktop application window.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/system-window/foreground', { method: 'GET' })),
    }),
    tool({
      name: 'computer_system_window_set_bounds',
      label: 'Set system window bounds',
      description: 'Move and/or resize a Windows desktop application window. Provide hwnd from computer_system_window_list when possible.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          x: { type: 'number', description: 'New left coordinate. Must be provided with y.' },
          y: { type: 'number', description: 'New top coordinate. Must be provided with x.' },
          width: { type: 'number', description: 'New window width. Must be provided with height.' },
          height: { type: 'number', description: 'New window height. Must be provided with width.' },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/bounds', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_set_topmost',
      label: 'Set system window topmost',
      description: 'Set or clear always-on-top for a Windows desktop application window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          topmost: {
            type: 'boolean',
            description: 'true to keep window on top, false to clear topmost. Defaults to true.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/topmost', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_uia_tree',
      label: 'Get UI Automation tree',
      description: 'Read the Windows UI Automation control tree for the foreground or selected window, including control type, name, automation id, enabled/offscreen state, bounds, and children. Prefer this over blind coordinate clicks for native apps and external browser windows.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          maxDepth: {
            type: 'integer',
            minimum: 0,
            maximum: 6,
            description: 'Maximum UIA tree depth. Defaults to 4.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Maximum nodes to return. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/uia/tree', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_uia_find',
      label: 'Find UI Automation elements',
      description: 'Find controls in a Windows UI Automation tree by visible text/name, automation id, and/or control type. Returned bounds can be used with mouse tools for native apps and external browser windows.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          textIncludes: {
            type: 'string',
            description: 'Case-insensitive text/name/automation id substring to match.',
          },
          controlType: {
            type: 'string',
            description: 'Control type substring such as button, edit, list, menuitem, document.',
          },
          maxDepth: {
            type: 'integer',
            minimum: 0,
            maximum: 6,
            description: 'Maximum UIA tree depth. Defaults to 4.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Maximum nodes to scan. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/uia/find', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_web_observe',
      label: 'Observe external browser',
      description: 'Observe an already-open external browser window such as Chrome, Edge, Brave, Chromium, Firefox, Opera, or Vivaldi through a bounded Windows UI Automation summary plus an optional window screenshot. Returns window/foreground info, inferred URL/title when UIA exposes it, visible text, and clickable/editable candidates with bounds/centers. Screenshots are omitted by default to keep context small; request one only when text/candidates are insufficient. Use this before visual guessing, repeated full-screen screenshots, or image calls on the user\'s normal browser.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          processName: {
            type: 'string',
            description: 'Optional browser process name, for example chrome, msedge, brave, chromium, firefox, opera, or vivaldi. Defaults to the first visible supported browser.',
          },
          focus: {
            type: 'boolean',
            description: 'Whether to restore and focus the browser window before observing. Defaults to true.',
          },
          includeScreenshot: {
            type: 'boolean',
            description: 'Whether to include a window screenshot artifact and coordinateMapping. Defaults to false to keep context small; set true only when UIA text/candidates are insufficient.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 50,
            maximum: 500,
            description: 'Maximum UIA nodes to scan. Defaults to 120 for a light observation; increase only for targeted follow-up.',
          },
          maxCandidates: {
            type: 'integer',
            minimum: 5,
            maximum: 120,
            description: 'Maximum clickable/editable candidates to return. Defaults to 25 for a light observation; increase only for targeted follow-up.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/web/observe', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_snapshot',
      label: 'Inspect browser DOM',
      description: 'Inspect the DOM of the UClaw/Electron browser window and return visible interactive elements with selectors, text, roles, and bounds. This is for UClaw app windows, not arbitrary external Chrome tabs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'Optional CSS selector filter.',
          },
          textIncludes: {
            type: 'string',
            description: 'Optional case-insensitive text, label, id, role, placeholder, or href substring filter.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 800,
            description: 'Maximum DOM nodes to return. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/dom', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_find',
      label: 'Find browser DOM elements',
      description: 'Find DOM elements in the UClaw/Electron browser window by CSS selector or text/label substring. Use returned selector or index for DOM actions. For external Chrome/Edge windows, use system window plus UIA/mouse/keyboard tools instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'Optional CSS selector.',
          },
          textIncludes: {
            type: 'string',
            description: 'Optional case-insensitive text, label, id, role, placeholder, or href substring.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 800,
            description: 'Maximum DOM nodes to scan. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/find', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_action',
      label: 'Act on browser DOM',
      description: 'Focus, click, or type into a DOM element in the UClaw/Electron browser window. Mutating actions may return requiresConfirmation unless confirmed is true. For external Chrome/Edge windows, use UIA/mouse/keyboard tools instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'CSS selector for the target element.',
          },
          index: {
            type: 'integer',
            minimum: 0,
            description: 'Index from computer_browser_dom_find when selector is not provided.',
          },
          textIncludes: {
            type: 'string',
            description: 'Text filter used with index lookup when selector is not provided.',
          },
          action: {
            type: 'string',
            enum: ['focus', 'click', 'type'],
            description: 'DOM action to perform.',
          },
          text: {
            type: 'string',
            description: 'Text to set when action is type.',
          },
          confirmed: {
            type: 'boolean',
            description: 'Set true after user confirmation for mutating or risky actions.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/action', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_safety_evaluate',
      label: 'Evaluate computer action risk',
      description: 'Evaluate whether a computer-use action is read-only, mutating, or potentially destructive/transactional before executing it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            description: 'Action identifier such as browserClick, browserType, mouseClick, typeText, windowClose, observe.',
          },
          target: {
            type: 'string',
            description: 'Human-readable target text or selector for risk scanning.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/safety/evaluate', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_agent_run_steps',
      label: 'Run computer-use steps',
      description: 'Run a short deterministic observe/act loop for computer-use tasks. Supported step actions: observeDom, findDom, focusDom, clickDom, typeDom, screenshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['goal'],
        properties: {
          goal: {
            type: 'string',
            description: 'User goal for the computer-use loop.',
          },
          steps: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: true,
            },
            description: 'Deterministic steps to run. The model should inspect results and continue or finish.',
          },
          confirmed: {
            type: 'boolean',
            description: 'Set true only after user confirmation for mutating or risky steps.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/agent/run', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_window_sources',
      label: 'List capturable windows',
      description: 'List desktop windows that can be captured by UClaw, including source ids for window screenshots. By default this returns only ids/names to keep model context small; request previews only when visual disambiguation is necessary.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includePreviews: {
            type: 'boolean',
            description: 'Set true only when several windows have ambiguous names and thumbnail previews are needed.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of windows to return. Preview requests are capped by the client.',
          },
        },
      },
      execute: async (params = {}) => {
        const search = new URLSearchParams();
        if (params.includePreviews === true) search.set('includePreviews', 'true');
        if (Number.isFinite(params.limit)) search.set('limit', String(params.limit));
        const suffix = search.toString() ? `?${search.toString()}` : '';
        return resultOrPayload(await hostApiFetch(`/api/computer/window-sources${suffix}`, { method: 'GET' }));
      },
    }),
    tool({
      name: 'computer_window_screenshot',
      label: 'Capture window screenshot',
      description: 'Capture a screenshot of an application window and return width, height, optional windowBounds, and coordinateMapping. Provide sourceId from computer_window_sources or titleIncludes to choose a window. The screenshot should be interpreted by the current chat model when it supports images; do not use the standalone image tool without an explicit current-session vision model. Never run Python/PIL just to read image dimensions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: {
            type: 'string',
            description: 'Window source id returned by computer_window_sources.',
          },
          titleIncludes: {
            type: 'string',
            description: 'Fallback case-insensitive title substring to select a window.',
          },
        },
      },
      execute: async (params) => summarizeScreenshot(await hostApiFetch('/api/computer/window-screenshot', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_display_list',
      label: 'List displays',
      description: 'List local displays, bounds, work areas, and scale factors for coordinate-based computer control.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/displays', { method: 'GET' })),
    }),
    tool({
      name: 'computer_cursor_position',
      label: 'Get cursor position',
      description: 'Return the current global mouse cursor coordinates.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/cursor', { method: 'GET' })),
    }),
    tool({
      name: 'computer_mouse_move',
      label: 'Move mouse',
      description: 'Move the global mouse cursor to absolute screen coordinates. Use display bounds from computer_display_list when planning coordinates. For app-specific work, pass expectedForeground so the host refuses movement if the wrong window is foreground.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number', description: 'Absolute screen X coordinate.' },
          y: { type: 'number', description: 'Absolute screen Y coordinate.' },
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/move', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_click',
      label: 'Click mouse',
      description: 'Click the global mouse cursor. Optionally move to absolute x/y before clicking. For app-specific work, first verify the foreground window and pass expectedForeground; if focus failed, do not click.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', description: 'Optional absolute screen X coordinate.' },
          y: { type: 'number', description: 'Optional absolute screen Y coordinate.' },
          button: MOUSE_BUTTON_SCHEMA,
          clicks: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            description: 'Number of clicks, default 1.',
          },
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/click', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_button',
      label: 'Mouse button down/up',
      description: 'Press or release a mouse button without automatically releasing or pressing it. Useful for custom drag operations. Pass expectedForeground for app-specific actions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          button: MOUSE_BUTTON_SCHEMA,
          action: {
            type: 'string',
            enum: ['down', 'up'],
            description: 'Whether to press or release the button.',
          },
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/button', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_scroll',
      label: 'Scroll mouse wheel',
      description: 'Scroll the mouse wheel. Negative delta scrolls down; positive delta scrolls up. Optionally move to x/y first. Pass expectedForeground for app-specific scrolling.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delta: {
            type: 'number',
            description: 'Wheel delta. Typical one-notch values are -120 or 120. Defaults to -120.',
          },
          x: { type: 'number', description: 'Optional absolute screen X coordinate.' },
          y: { type: 'number', description: 'Optional absolute screen Y coordinate.' },
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/scroll', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_drag',
      label: 'Drag mouse',
      description: 'Drag from one absolute screen coordinate to another using a mouse button. Pass expectedForeground for app-specific dragging.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fromX', 'fromY', 'toX', 'toY'],
        properties: {
          fromX: { type: 'number', description: 'Start X coordinate.' },
          fromY: { type: 'number', description: 'Start Y coordinate.' },
          toX: { type: 'number', description: 'End X coordinate.' },
          toY: { type: 'number', description: 'End Y coordinate.' },
          button: MOUSE_BUTTON_SCHEMA,
          durationMs: {
            type: 'number',
            description: 'Drag duration in milliseconds. Defaults to 350.',
          },
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/drag', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_key_press',
      label: 'Press key',
      description: 'Press a keyboard key, optionally with modifiers such as ctrl, shift, alt, or win. For app-specific work, first verify the foreground window and pass expectedForeground; if focus failed, do not press keys.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: {
          key: KEY_SCHEMA,
          modifiers: MODIFIERS_SCHEMA,
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/keyboard/press', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_type_text',
      label: 'Type text',
      description: 'Paste plain text into the currently focused app using the system clipboard followed by Ctrl+V. For app-specific work, first verify the foreground window and pass expectedForeground; if focus failed, do not type. Never paste javascript: URLs into a browser address bar to inspect page text; use browser/DOM/UIA observation tools instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Plain text to paste into the currently focused app.',
          },
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/keyboard/type', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_file_dialog_set_path',
      label: 'Set file dialog path',
      description: 'Paste a file path into the currently focused system file picker and optionally press Enter. Use after opening a file upload/save dialog. When saving a new local artifact, choose a non-overwriting path with a timestamp and short random suffix or UUID before the extension unless the user explicitly asks to overwrite. Pass expectedForeground so the host refuses to paste into the wrong app.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['filePath'],
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute file path to paste into the focused file dialog.',
          },
          submit: {
            type: 'boolean',
            description: 'Whether to press Enter after pasting. Defaults to true.',
          },
          confirmed: CONFIRMED_SCHEMA,
          expectedForeground: EXPECTED_FOREGROUND_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/file-dialog/set-path', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
  ],
});

const registerTools = pluginEntry.register.bind(pluginEntry);
pluginEntry.register = (api) => {
  registerTools(api);
  registerLocalActionCompletionGuard(api);
};

export default pluginEntry;
