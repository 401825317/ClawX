import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const PATCH_MARKER = 'UCLAW_TOOL_DIRECTORY_CJK_INTENT_V1';
const FUNCTION_ANCHOR = `function readToolDirectoryIntent(query) {
	const tokens = new Set(tokenize(query));`;
const FUNCTION_PATCH = `function readToolDirectoryIntent(query) {
	const tokens = new Set(tokenize(query));
	const UCLAW_TOOL_DIRECTORY_CJK_INTENT_V1 = true;
	const hasCjkFileIntent = /(?:文件|目录|路径|代码|源码|项目|仓库|配置|日志|读取|查看|修改|编辑|写入|补丁)/u.test(query);
	const hasCjkEngineeringIntent = /(?:诊断|排查|分析|代码|源码|项目|仓库|配置|日志|命令|终端|运行|启动|构建|编译|测试|修复|实现|开发)/u.test(query);
	const hasCjkReadOnlyIntent = /(?:只读|不要(?:急着)?(?:改|写)|先(?:做)?(?:分析|诊断|排查|查看)|不要写文件)/u.test(query);
	const hasCjkWebIntent = /(?:联网|网上|网页|网址|链接|搜索|搜一下|查一下|最新|新闻|天气|价格)/u.test(query);
	const hasCjkArtifactIntent = /(?:PPT|PPTX|演示稿|幻灯片|Excel|XLSX|表格|Word|DOCX|文档|小程序|网页|文案)/iu.test(query);
	const hasCjkMediaIntent = /(?:生图|图片|图像|照片|修图|视频|截图|视觉)/u.test(query);
	const hasCjkMessageIntent = /(?:发送|发消息|回复|群发|发布|私信|微信|QQ|钉钉|飞书)/u.test(query);`;

const RETURN_ANCHOR = `		hasMemoryRecall: hasExplicitMemoryRecall || hasIdentityRecall && !hasCurrentFact
	};`;
const RETURN_PATCH = `		hasMemoryRecall: hasExplicitMemoryRecall || hasIdentityRecall && !hasCurrentFact,
		hasCjkFileIntent,
		hasCjkEngineeringIntent,
		hasCjkReadOnlyIntent,
		hasCjkWebIntent,
		hasCjkArtifactIntent,
		hasCjkMediaIntent,
		hasCjkMessageIntent
	};`;

const SCORE_ANCHOR = `	if (intent.hasMemoryRecall && /memory|memories|recall|remember|history|prior|knowledge|libravdb/iu.test(toolText)) score += 8;
	return score;`;
const SCORE_PATCH = `	if (intent.hasMemoryRecall && /memory|memories|recall|remember|history|prior|knowledge|libravdb/iu.test(toolText)) score += 8;
	if (intent.hasCjkFileIntent && /read|write|edit|grep|find|ls|file|patch/iu.test(toolText)) score += 10;
	if (intent.hasCjkEngineeringIntent && /read|exec|process|write|edit|patch|file|shell|command/iu.test(toolText)) score += 10;
	if (intent.hasCjkReadOnlyIntent) {
		if (/^(?:read|exec|process)$/iu.test(tool.name)) score += 18;
		if (/^(?:write|edit|apply_patch)$/iu.test(tool.name)) score -= 20;
	}
	if (intent.hasCjkWebIntent && /web|search|fetch|browser|internet|online/iu.test(toolText)) score += 12;
	if (intent.hasCjkArtifactIntent && /create_(?:pptx|docx|xlsx|text|html)|presentation|spreadsheet|document|file/iu.test(toolText)) score += 12;
	if (intent.hasCjkMediaIntent && /image|video|vision|browser/iu.test(toolText)) score += 10;
	if (intent.hasCjkMessageIntent && /message|session|send|channel/iu.test(toolText)) score += 10;
	return score;`;

function patchContent(content, filePath) {
  if (content.includes(PATCH_MARKER)) return { content, changed: false };
  for (const anchor of [FUNCTION_ANCHOR, RETURN_ANCHOR, SCORE_ANCHOR]) {
    if (!content.includes(anchor)) {
      throw new Error(`[openclaw-tool-directory-i18n-patch] Missing runtime anchor in ${filePath}`);
    }
  }
  return {
    content: content
      .replace(FUNCTION_ANCHOR, FUNCTION_PATCH)
      .replace(RETURN_ANCHOR, RETURN_PATCH)
      .replace(SCORE_ANCHOR, SCORE_PATCH),
    changed: true,
  };
}

export function patchOpenClawToolDirectoryI18nRuntime(distDir, options = {}) {
  const logger = options.logger ?? console;
  if (!existsSync(distDir)) return { patchedFiles: 0, distDir };
  const targets = readdirSync(distDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ file, filePath: join(distDir, file) }))
    .filter(({ filePath }) => readFileSync(filePath, 'utf8').includes('function readToolDirectoryIntent(query)'));
  if (targets.length !== 1) {
    throw new Error(`[openclaw-tool-directory-i18n-patch] Expected one tool directory runtime; found ${targets.length}`);
  }
  const target = targets[0];
  const original = readFileSync(target.filePath, 'utf8');
  const patched = patchContent(original, target.filePath);
  if (patched.changed) writeFileSync(target.filePath, patched.content, 'utf8');
  logger.log?.(`[openclaw-tool-directory-i18n-patch] ${patched.changed ? 'Patched' : 'Already patched'}: ${target.file}`);
  return { patchedFiles: patched.changed ? 1 : 0, distDir, targetFile: target.filePath };
}

export function patchInstalledOpenClawToolDirectoryI18nRuntime(cwd = process.cwd(), options = {}) {
  return patchOpenClawToolDirectoryI18nRuntime(join(cwd, 'node_modules', 'openclaw', 'dist'), options);
}
