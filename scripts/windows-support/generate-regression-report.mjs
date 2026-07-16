#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_MATRIX = path.join(ROOT, 'tests', 'packaged-e2e', 'capability-matrix.json');
const DEFAULT_SOURCE = path.join(ROOT, 'test-results', 'results.json');

const STATUS_LABELS = {
  passed: '通过',
  failed: '失败',
  skipped: '条件跳过',
  not_run: '未执行',
  not_covered: '未覆盖',
};

function parseArgs(argv) {
  const options = {
    matrix: DEFAULT_MATRIX,
    source: DEFAULT_SOURCE,
    packaged: '',
    live: '',
    output: '',
    resultsOutput: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--matrix': options.matrix = readValue(); break;
      case '--source': options.source = readValue(); break;
      case '--packaged': options.packaged = readValue(); break;
      case '--live': options.live = readValue(); break;
      case '--output': options.output = readValue(); break;
      case '--results-output': options.resultsOutput = readValue(); break;
      case '--help':
      case '-h':
        console.log('Usage: node generate-regression-report.mjs --packaged <summary.json> [--live <summary.json>] [--source <results.json>] [--output <report.md>]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  const anchor = options.packaged || options.live;
  if (!options.output) {
    options.output = anchor
      ? path.join(path.dirname(path.resolve(anchor)), 'UClaw-complete-regression-report.zh-CN.md')
      : path.join(ROOT, 'release', 'regression', 'UClaw-complete-regression-report.zh-CN.md');
  }
  if (!options.resultsOutput) {
    options.resultsOutput = options.output.replace(/\.md$/iu, '.json');
  }
  return options;
}

async function readJson(filePath, required = false) {
  if (!filePath || !existsSync(path.resolve(filePath))) {
    if (required) throw new Error(`Required JSON file not found: ${filePath}`);
    return null;
  }
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

function flattenSourceSpecs(suites, output = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const resultStatuses = (spec.tests ?? []).flatMap((test) => (test.results ?? []).map((result) => result.status));
      let status = spec.ok === false || resultStatuses.some((statusValue) => ['failed', 'timedOut', 'interrupted'].includes(statusValue))
        ? 'failed'
        : resultStatuses.length > 0 && resultStatuses.every((statusValue) => statusValue === 'skipped')
          ? 'skipped'
          : spec.ok === true || resultStatuses.some((statusValue) => statusValue === 'passed')
            ? 'passed'
            : 'not_run';
      if ((spec.tests ?? []).some((test) => test.expectedStatus === 'skipped') && !resultStatuses.includes('passed')) {
        status = 'skipped';
      }
      output.push({
        file: path.basename(spec.file || suite.file || ''),
        title: spec.title || '',
        status,
      });
    }
    flattenSourceSpecs(suite.suites, output);
  }
  return output;
}

function combineStatuses(statuses) {
  const filtered = statuses.filter(Boolean);
  if (filtered.length === 0) return 'not_run';
  if (filtered.includes('failed')) return 'failed';
  if (filtered.includes('not_run')) return 'not_run';
  if (filtered.every((status) => status === 'skipped')) return 'skipped';
  if (filtered.some((status) => status === 'passed')) return 'passed';
  return filtered[0] || 'not_run';
}

function scenarioMap(...summaries) {
  const map = new Map();
  for (const summary of summaries) {
    for (const scenario of summary?.scenarios ?? []) map.set(scenario.id, scenario);
  }
  return map;
}

function capabilityStatus(capability, context) {
  if (capability.classification === 'NOT_COVERED') return { status: 'not_covered', evidence: '矩阵明确标记为未覆盖' };
  if (capability.classification === 'SOURCE_E2E') {
    const files = new Set(capability.sourceTests ?? []);
    const specs = context.sourceSpecs.filter((spec) => files.has(spec.file));
    const missing = [...files].filter((file) => !specs.some((spec) => spec.file === file));
    const status = missing.length > 0 ? 'not_run' : combineStatuses(specs.map((spec) => spec.status));
    return {
      status,
      evidence: specs.length > 0
        ? `${specs.filter((spec) => spec.status === 'passed').length}/${specs.length} tests; ${[...files].join(', ')}`
        : [...files].join(', ') || '无源码测试映射',
    };
  }
  if (capability.summaryField === 'staticSelfCheck') {
    const result = context.packaged?.staticSelfCheck;
    const status = result && result.fail === 0 && result.warn === 0 ? 'passed' : result ? 'failed' : 'not_run';
    return { status, evidence: result ? `PASS=${result.pass} WARN=${result.warn} FAIL=${result.fail}` : '未找到静态自检结果' };
  }
  const scenarioIds = capability.scenarioIds ?? [];
  const scenarios = scenarioIds.map((id) => context.scenarios.get(id)).filter(Boolean);
  const status = scenarios.length !== scenarioIds.length
    ? 'not_run'
    : combineStatuses(scenarios.map((scenario) => scenario.status));
  return {
    status,
    evidence: scenarioIds.length > 0 ? scenarioIds.join(', ') : '无自动场景映射',
  };
}

function countBy(items, keySelector) {
  const counts = {};
  for (const item of items) {
    const key = keySelector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/gu, ' ');
}

function packageSummary(packaged, live) {
  return packaged?.package ?? live?.package ?? {};
}

function sourceCounts(specs) {
  return countBy(specs, (spec) => spec.status);
}

function scenarioRows(title, summary) {
  const lines = [`### ${title}`, '', '| 场景 | 状态 | 耗时 | 说明 |', '| --- | --- | ---: | --- |'];
  if (!summary?.scenarios?.length) {
    lines.push('| - | 未执行 | - | 没有对应报告 |');
    return lines;
  }
  for (const scenario of summary.scenarios) {
    const reason = scenario.status === 'skipped'
      ? scenario.details?.reason ?? ''
      : scenario.error
        ? String(scenario.error).split('\n')[0]
        : scenario.title ?? '';
    lines.push(`| ${markdownEscape(scenario.id)} | ${STATUS_LABELS[scenario.status] ?? scenario.status} | ${scenario.durationMs ?? 0} ms | ${markdownEscape(reason)} |`);
  }
  return lines;
}

export async function generateRegressionReport(options) {
  const matrix = await readJson(options.matrix ?? DEFAULT_MATRIX, true);
  const source = await readJson(options.source ?? DEFAULT_SOURCE);
  const packaged = await readJson(options.packaged);
  const live = await readJson(options.live);
  const sourceSpecs = flattenSourceSpecs(source?.suites ?? []);
  const scenarios = scenarioMap(packaged, live);
  const capabilities = (matrix.capabilities ?? []).map((capability) => ({
    ...capability,
    ...capabilityStatus(capability, { sourceSpecs, scenarios, packaged, live }),
  }));
  const requiredBlockers = capabilities.filter((capability) => (
    capability.required === true
    && ['failed', 'not_run', 'not_covered'].includes(capability.status)
  ));
  const packageInfo = packageSummary(packaged, live);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseGate: requiredBlockers.length === 0 ? 'passed' : 'failed',
    package: packageInfo,
    source: {
      report: options.source ? path.resolve(options.source) : null,
      tests: sourceSpecs.length,
      counts: sourceCounts(sourceSpecs),
    },
    packaged: packaged ? { report: path.resolve(options.packaged), status: packaged.status, runId: packaged.runId } : null,
    live: live ? { report: path.resolve(options.live), status: live.status, runId: live.runId } : null,
    countsByClassification: countBy(capabilities, (capability) => capability.classification),
    countsByStatus: countBy(capabilities, (capability) => capability.status),
    requiredBlockers: requiredBlockers.map((capability) => capability.id),
    capabilities,
  };

  const lines = [
    '# UClaw 完整自动化回归报告',
    '',
    `- 生成时间：${result.generatedAt}`,
    `- 发布门禁：${result.releaseGate === 'passed' ? '通过' : '失败'}`,
    `- 包版本：${packageInfo.version ?? '未知'}`,
    `- Git 提交：${packageInfo.gitCommit ?? '未知'}`,
    `- ZIP：${packageInfo.zipFileName ?? '未知'}`,
    `- 源码测试：${sourceSpecs.length} 项（通过 ${result.source.counts.passed ?? 0}，失败 ${result.source.counts.failed ?? 0}，跳过 ${result.source.counts.skipped ?? 0}）`,
    `- 成品回归：${packaged?.status ?? '未执行'}${packaged?.runId ? `（${packaged.runId}）` : ''}`,
    `- Live 回归：${live?.status ?? '未执行'}${live?.runId ? `（${live.runId}）` : ''}`,
    '',
    '## 证据等级',
    '',
    '| 等级 | 含义 |',
    '| --- | --- |',
    ...Object.entries(matrix.classifications ?? {}).map(([key, value]) => `| ${key} | ${markdownEscape(value)} |`),
    '',
    '## 门禁结论',
    '',
  ];
  if (requiredBlockers.length === 0) {
    lines.push('所有必测能力均有对应证据且通过。Live、外部副作用和明确未覆盖项不计入离线测试包门禁。');
  } else {
    lines.push(`存在 ${requiredBlockers.length} 个必测阻断项：${requiredBlockers.map((capability) => capability.id).join(', ')}`);
  }
  lines.push(
    '',
    '## 能力矩阵',
    '',
    '| 领域 | 能力 | 证据等级 | 状态 | 证据 |',
    '| --- | --- | --- | --- | --- |',
    ...capabilities.map((capability) => (
      `| ${markdownEscape(capability.area)} | ${markdownEscape(capability.title)} | ${capability.classification} | ${STATUS_LABELS[capability.status] ?? capability.status} | ${markdownEscape(capability.evidence)} |`
    )),
    '',
    '## 场景明细',
    '',
    ...scenarioRows('成品真实回归', packaged),
    '',
    ...scenarioRows('Live 回归', live),
    '',
    '## 判定边界',
    '',
    '- `SOURCE_E2E` 只证明源码模式行为，不证明分发包完整性。',
    '- 本地确定性 Provider 属于 `PACKAGED_REAL`：模型服务可控，但 Electron Main、Host API、Gateway、OpenClaw、工具和文件副作用均来自真实成品。',
    '- `LIVE_REQUIRED` 缺少专用账号、费用授权、隐私授权或外部目标时只能显示未执行或条件跳过。',
    '- `NOT_COVERED` 永远不能计入通过。真实支付在自动化中明确禁止。',
    '',
  );

  const outputPath = path.resolve(options.output);
  const resultsOutputPath = path.resolve(options.resultsOutput ?? outputPath.replace(/\.md$/iu, '.json'));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(resultsOutputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  await writeFile(resultsOutputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { outputPath, resultsOutputPath, result };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generated = await generateRegressionReport(options);
  console.log(`[regression-report] Markdown: ${generated.outputPath}`);
  console.log(`[regression-report] JSON: ${generated.resultsOutputPath}`);
  console.log(`[regression-report] Gate: ${generated.result.releaseGate}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[regression-report] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
