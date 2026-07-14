#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';

const SELF_CHECK_VERSION = '2';
const args = process.argv.slice(2);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.dirname(scriptPath);
const staticOnly = args.includes('--static-only');
const startApp = args.includes('--start-app') && !staticOnly;
const copyToDesktop = !args.includes('--no-desktop-copy');

function readArg(name) {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const rootDir = path.resolve(readArg('--root') || defaultRoot);
const portableDataDir = path.join(rootDir, 'UClawData');
const openClawHomeDir = path.join(portableDataDir, 'openclaw-home');
const openClawStateDir = path.join(openClawHomeDir, '.openclaw');
const openClawConfigPath = path.join(openClawStateDir, 'openclaw.json');
const localAppData = process.env.LOCALAPPDATA
  || process.env.APPDATA
  || path.join(os.homedir(), 'AppData', 'Local');
const runtimeRootDir = path.join(localAppData, 'UClawRuntime');
const portableDiagnosticsDir = path.join(portableDataDir, 'diagnostics');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const reportName = `UClaw-Windows-Diagnostic-${timestamp}.txt`;
let diagnosticsDir = portableDiagnosticsDir;
let reportPath = path.join(diagnosticsDir, reportName);
const records = [];
const SENSITIVE_KEY_PATTERN = /^(?:api[_-]?key|.*token|password|secret|authorization|cookie|credential|private[_-]?key|client[_-]?secret|signature)$/i;

function redactText(value) {
  let text = String(value ?? '');
  const userProfile = process.env.USERPROFILE || os.homedir();
  if (userProfile) text = text.split(userProfile).join('%USERPROFILE%');
  text = text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:"|')?(?:api[_-]?key|[a-z0-9_-]*token|password|secret|authorization|cookie|credential|private[_-]?key|client[_-]?secret|signature)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|signature|sig|key|code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  return text;
}

function redactStructured(value, key = '') {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactStructured(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactStructured(childValue, childKey),
    ]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function redactCommandOutput(value) {
  const text = String(value ?? '');
  try {
    return JSON.stringify(redactStructured(JSON.parse(text)), null, 2);
  } catch {
    return redactText(text);
  }
}

function runRedactionSelfTest() {
  const markers = ['uclaw-api-secret', 'uclaw-token-secret', 'uclaw-signature-secret', 'uclaw-bearer-secret'];
  const structured = redactCommandOutput(JSON.stringify({
    apiKey: markers[0],
    nested: { access_token: markers[1] },
    url: `https://example.invalid/file?signature=${markers[2]}`,
  }));
  const plain = redactText(`Authorization: Bearer ${markers[3]}`);
  const passed = markers.every((marker) => !structured.includes(marker) && !plain.includes(marker));
  record(passed ? 'PASS' : 'FAIL', '诊断脱敏自检', passed ? 'JSON 密钥、URL 签名和授权头均已遮蔽' : '脱敏器未覆盖全部测试密钥');
}

function record(level, check, detail) {
  const item = { level, check, detail: redactText(detail) };
  records.push(item);
  console.log(`[${level}] ${check}: ${item.detail}`);
}

async function prepareDiagnosticsDir() {
  const fallbackDir = path.join(os.tmpdir(), 'UClawDiagnostics');
  for (const candidate of [portableDiagnosticsDir, fallbackDir]) {
    const probePath = path.join(candidate, `.uclaw-report-${process.pid}-${Date.now()}.tmp`);
    try {
      await fsp.mkdir(candidate, { recursive: true });
      await fsp.writeFile(probePath, 'ok\n', 'utf8');
      await fsp.rm(probePath, { force: true });
      diagnosticsDir = candidate;
      reportPath = path.join(diagnosticsDir, reportName);
      return candidate === portableDiagnosticsDir;
    } catch {
      await fsp.rm(probePath, { force: true }).catch(() => {});
    }
  }
  return false;
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

async function exists(relativePath, kind = 'file') {
  const target = path.join(rootDir, relativePath);
  try {
    const stat = await fsp.stat(target);
    return kind === 'dir' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

async function checkRequiredPath(relativePath, kind = 'file') {
  const ok = await exists(relativePath, kind);
  record(ok ? 'PASS' : 'FAIL', `运行时文件 ${relativePath}`, ok ? '存在' : '缺失，当前 UClaw 分发内容不完整或被安全软件删除');
  return ok;
}

async function atomicRenameProbe(targetDir, label) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = path.join(targetDir, `.uclaw-write-${nonce}.tmp`);
  const destination = path.join(targetDir, `.uclaw-write-${nonce}.json`);
  try {
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(destination, '{"version":"old"}\n', 'utf8');
    await fsp.writeFile(source, '{"version":"new"}\n', 'utf8');
    await fsp.rename(source, destination);
    const replaced = await fsp.readFile(destination, 'utf8');
    if (!replaced.includes('"new"')) throw new Error('rename 后目标文件内容未被替换');
    await fsp.rm(destination, { force: true });
    record('PASS', label, '创建、写入、覆盖已有目标的原子 rename、删除均成功');
  } catch (error) {
    await fsp.rm(source, { force: true }).catch(() => {});
    await fsp.rm(destination, { force: true }).catch(() => {});
    record('FAIL', label, `原子写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function createOpenClawEnv() {
  const binDir = path.join(rootDir, 'resources', 'bin');
  return {
    ...process.env,
    CLAWX_PORTABLE: '1',
    CLAWX_PORTABLE_ROOT: rootDir,
    OPENCLAW_EMBEDDED_IN: 'UClaw',
    OPENCLAW_HOME: openClawHomeDir,
    OPENCLAW_STATE_DIR: openClawStateDir,
    OPENCLAW_CONFIG_PATH: openClawConfigPath,
    OPENCLAW_CONFIG: openClawConfigPath,
    OPENCLAW_NO_RESPAWN: '1',
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  };
}

async function checkPlugin(pluginId, requiresTypebox = true) {
  const pluginDir = path.join(rootDir, 'resources', 'openclaw-plugins', pluginId);
  const packageJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    record('FAIL', `插件 ${pluginId}`, '插件目录缺失，属于 USB 打包问题，不要让用户自行安装 npm 依赖');
    return;
  }
  if (!requiresTypebox) {
    record('PASS', `插件 ${pluginId}`, '插件包存在');
    return;
  }
  try {
    const requireFromPlugin = createRequire(packageJsonPath);
    const typebox = requireFromPlugin('@sinclair/typebox');
    if (typeof typebox?.Type?.Object !== 'function') throw new Error('Type.Object 不可用');
    record('PASS', `插件 ${pluginId}`, '@sinclair/typebox 已实际加载，Type.Object 可用');
  } catch (error) {
    record('FAIL', `插件 ${pluginId}`, `@sinclair/typebox 不可解析，USB 包不完整：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    record('INFO', label, '尚未生成；首次启动或登录后才会出现');
    return;
  }
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    JSON.parse(content);
    record('PASS', label, `JSON 有效，大小 ${Buffer.byteLength(content)} bytes（内容未输出）`);
  } catch (error) {
    record('FAIL', label, `JSON 无效或不可读：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkAuthProfiles() {
  const agentsDir = path.join(openClawStateDir, 'agents');
  if (!fs.existsSync(agentsDir)) {
    record('INFO', 'auth-profiles.json', '尚无 Agent 认证文件');
    return;
  }
  const matches = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(entryPath, depth + 1);
      else if (entry.isFile() && entry.name === 'auth-profiles.json') matches.push(entryPath);
    }
  }
  await walk(agentsDir, 0);
  if (matches.length === 0) {
    record('INFO', 'auth-profiles.json', '尚未找到认证文件；未登录或 Agent 尚未初始化');
    return;
  }
  let writable = 0;
  for (const filePath of matches) {
    try {
      await fsp.access(filePath, fs.constants.R_OK | fs.constants.W_OK);
      writable += 1;
    } catch {
      // Count only; never read or print credentials.
    }
  }
  const level = writable === matches.length ? 'PASS' : 'FAIL';
  record(level, 'auth-profiles.json', `发现 ${matches.length} 个，读写正常 ${writable} 个（内容未读取）`);
}

async function probePort(port, timeoutMs = 1200) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function probeHostApiAuthBoundary() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('http://127.0.0.1:13210/api/status', {
      signal: controller.signal,
      redirect: 'manual',
    });
    const valid = response.status === 401;
    record(valid ? 'PASS' : 'FAIL', 'Host API 身份确认', valid
      ? '未携带内部 token 时返回 HTTP 401，符合 UClaw Host API 行为'
      : `返回 HTTP ${response.status}，13210 端口可能不属于当前 UClaw`);
    return valid;
  } catch (error) {
    record('FAIL', 'Host API 身份确认', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function listUClawPids() {
  if (process.platform !== 'win32') return [];
  const result = runCommand('tasklist.exe', ['/FI', 'IMAGENAME eq UClaw.exe', '/FO', 'CSV', '/NH']);
  return [...result.stdout.matchAll(/^"UClaw\.exe","(\d+)"/gim)].map((match) => Number(match[1]));
}

function listeningPid(port) {
  if (process.platform !== 'win32') return undefined;
  const result = runCommand('netstat.exe', ['-ano', '-p', 'TCP']);
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:([0-9]+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && Number(match[1]) === port) return Number(match[2]);
  }
  return undefined;
}

async function checkNetwork() {
  const host = 'zz-cn.lingzhiwuxian.com';
  try {
    const result = await dns.lookup(host);
    record('PASS', 'zz-cn DNS', `${host} -> ${result.address}`);
  } catch (error) {
    record('FAIL', 'zz-cn DNS', error instanceof Error ? error.message : String(error));
  }

  const tcp443 = await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 443 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(5000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
  record(tcp443 ? 'PASS' : 'FAIL', 'zz-cn HTTPS 443', tcp443 ? 'TCP 连接成功' : 'TCP 连接失败');

  for (const [label, url] of [
    ['zz-cn 状态接口', `https://${host}/api/status`],
    ['UClaw bootstrap', `https://${host}/api/clawx/bootstrap`],
  ]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      const level = response.status === 200 ? 'PASS' : response.status === 429 ? 'FAIL' : 'WARN';
      const suffix = response.status === 429 ? '，服务端限流已触发' : '';
      record(level, label, `HTTP ${response.status}，${Date.now() - startedAt}ms${suffix}`);
    } catch (error) {
      record('FAIL', label, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function collectLogFiles(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectLogFiles(entryPath, depth + 1));
    else if (entry.isFile() && /\.(?:log|txt)$/i.test(entry.name)) files.push(entryPath);
  }
  return files;
}

async function scanRecentLogs() {
  const allFiles = [
    ...await collectLogFiles(path.join(runtimeRootDir, 'logs')),
    ...await collectLogFiles(path.join(portableDataDir, 'clawx', 'logs')),
    ...await collectLogFiles(path.join(openClawStateDir, 'logs')),
  ];
  const stats = [];
  for (const filePath of allFiles) {
    try {
      const stat = await fsp.stat(filePath);
      stats.push({ filePath, stat });
    } catch {
      // Ignore files that rotate during the scan.
    }
  }
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const recent = stats.slice(0, 20);
  const patterns = [
    ['EPERM rename', /EPERM[^\n]*rename/gi],
    ['429 Too Many Requests', /429 Too Many Requests/gi],
    ['ETIMEDOUT', /ETIMEDOUT/gi],
    ['TypeBox 缺失', /(?:Cannot find (?:package|module)[^\n]*@sinclair\/typebox|@sinclair\/typebox[^\n]*not found)/gi],
    ['Gateway 跳过自启', /Gateway auto-start skipped/gi],
    ['认证或 relay token 缺失', /(?:authToken=missing|relayToken=missing|auth=missing)/gi],
    ['端口占用', /EADDRINUSE/gi],
    ['Gateway token 不匹配', /token_mismatch/gi],
  ];
  const counts = new Map(patterns.map(([label]) => [label, 0]));
  for (const { filePath, stat } of recent) {
    try {
      const handle = await fsp.open(filePath, 'r');
      const length = Math.min(stat.size, 1024 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      await handle.close();
      const content = buffer.toString('utf8');
      for (const [label, pattern] of patterns) {
        pattern.lastIndex = 0;
        counts.set(label, (counts.get(label) || 0) + [...content.matchAll(pattern)].length);
      }
    } catch {
      // Ignore files that become unavailable during the scan.
    }
  }
  record(recent.length > 0 ? 'PASS' : 'INFO', '近期日志扫描', `扫描 ${recent.length} 个日志文件，仅统计错误类型，不输出原始日志`);
  for (const [label, count] of counts) {
    record(count > 0 ? 'WARN' : 'PASS', `日志：${label}`, `${count} 次`);
  }
}

async function writeCommandArtifact(fileName, result) {
  const target = path.join(diagnosticsDir, fileName);
  const content = [
    `exitCode=${result.exitCode ?? 'null'}`,
    result.error ? `error=${result.error}` : '',
    '',
    '[stdout]',
    redactCommandOutput(result.stdout),
    '',
    '[stderr]',
    redactCommandOutput(result.stderr),
  ].filter((line) => line !== '').join('\r\n');
  await fsp.writeFile(target, `\uFEFF${content}\r\n`, 'utf8');
  return target;
}

async function runOpenClawChecks(nodeExe, openClawEntry) {
  const env = createOpenClawEnv();
  const version = runCommand(nodeExe, [openClawEntry, '--version'], { env, timeout: 20_000 });
  record(version.exitCode === 0 ? 'PASS' : 'FAIL', 'OpenClaw CLI', version.exitCode === 0
    ? version.stdout.trim()
    : version.error || version.stderr.trim() || `退出码 ${version.exitCode}`);

  const doctor = runCommand(nodeExe, [openClawEntry, 'doctor', '--lint', '--json', '--non-interactive'], {
    env,
    timeout: 60_000,
  });
  const doctorPath = await writeCommandArtifact(`OpenClaw-Doctor-${timestamp}.txt`, doctor);
  record(doctor.exitCode === 0 ? 'PASS' : 'WARN', 'OpenClaw Doctor', `退出码 ${doctor.exitCode ?? 'null'}，脱敏输出：${doctorPath}`);

  const supportZip = path.join(diagnosticsDir, `OpenClaw-Support-${timestamp}.zip`);
  const support = runCommand(nodeExe, [
    openClawEntry,
    'gateway',
    'diagnostics',
    'export',
    '--output',
    supportZip,
    '--json',
    '--timeout',
    '3000',
  ], { env, timeout: 60_000 });
  const exported = support.exitCode === 0 && fs.existsSync(supportZip);
  record(exported ? 'PASS' : 'WARN', 'OpenClaw 支持包', exported
    ? `已生成脱敏 ZIP：${supportZip}`
    : support.error || support.stderr.trim() || `退出码 ${support.exitCode}`);
}

async function main() {
  record('INFO', '自查版本', `${SELF_CHECK_VERSION}，时间 ${new Date().toISOString()}`);
  runRedactionSelfTest();
  record('INFO', 'USB 根目录', rootDir);
  record(process.platform === 'win32' ? 'PASS' : staticOnly ? 'INFO' : 'FAIL', '操作系统', `${process.platform} ${os.release()} / ${process.arch}`);
  if (process.platform === 'win32') {
    const major = Number.parseInt(os.release().split('.')[0] || '0', 10);
    record(major >= 10 ? 'PASS' : 'FAIL', 'Windows 版本', major >= 10 ? 'Windows 10 或更高' : '需要 Windows 10 或更高');
    record(process.arch === 'x64' ? 'PASS' : 'FAIL', 'Windows 架构', process.arch === 'x64' ? 'x64' : `当前为 ${process.arch}，USB 包要求 x64`);
  }

  try {
    const stat = fs.statfsSync(rootDir);
    const freeGb = stat.bavail * stat.bsize / (1024 ** 3);
    record(freeGb >= 2 ? 'PASS' : 'WARN', '磁盘剩余空间', `${freeGb.toFixed(2)} GB`);
  } catch (error) {
    record('WARN', '磁盘剩余空间', error instanceof Error ? error.message : String(error));
  }
  if (process.platform === 'win32') {
    try {
      const stat = fs.statfsSync(localAppData);
      const freeGb = stat.bavail * stat.bsize / (1024 ** 3);
      record(freeGb >= 5 ? 'PASS' : 'WARN', '本机缓存盘剩余空间', `${freeGb.toFixed(2)} GB（Python、浏览器和运行时缓存使用）`);
    } catch (error) {
      record('WARN', '本机缓存盘剩余空间', error instanceof Error ? error.message : String(error));
    }
  }

  const required = [
    'UClaw.exe',
    'portable.flag',
    'resources/app.asar',
    'resources/bin/node.exe',
    'resources/bin/uv.exe',
    'resources/bin/agent-browser.exe',
    'resources/cli/openclaw.cmd',
    'resources/openclaw/openclaw.mjs',
    'resources/openclaw/package.json',
  ];
  const requiredResults = [];
  for (const relativePath of required) requiredResults.push(await checkRequiredPath(relativePath));
  await checkRequiredPath('UClawData', 'dir');

  const portableReportWritable = await prepareDiagnosticsDir();
  if (!portableReportWritable) {
    record(diagnosticsDir === portableDiagnosticsDir ? 'FAIL' : 'WARN', '诊断报告目录', diagnosticsDir === portableDiagnosticsDir
      ? 'USB 与本机临时目录均不可写，可能无法保存报告'
      : `USB 报告目录不可写，报告改存到本机临时目录：${diagnosticsDir}`);
  } else {
    record('PASS', '诊断报告目录', diagnosticsDir);
  }

  await atomicRenameProbe(portableDataDir, 'UClawData 写入与 rename');
  await atomicRenameProbe(openClawStateDir, 'OpenClaw 配置目录写入与 rename');
  if (process.platform === 'win32') await atomicRenameProbe(runtimeRootDir, 'UClawRuntime 写入与 rename');
  await validateJsonFile(openClawConfigPath, 'openclaw.json');
  await checkAuthProfiles();

  await checkPlugin('uclaw-local-artifacts');
  await checkPlugin('uclaw-desktop-control');
  await checkPlugin('uclaw-blender');
  await checkPlugin('uclaw-task-bridge');
  await checkPlugin('uclaw-artifact-guard', false);

  const nodeExe = path.join(rootDir, 'resources', 'bin', 'node.exe');
  const uvExe = path.join(rootDir, 'resources', 'bin', 'uv.exe');
  const browserExe = path.join(rootDir, 'resources', 'bin', 'agent-browser.exe');
  const openClawEntry = path.join(rootDir, 'resources', 'openclaw', 'openclaw.mjs');
  if (process.platform === 'win32' && requiredResults[3]) {
    for (const [label, command, commandArgs] of [
      ['内置 Node', nodeExe, ['--version']],
      ['内置 uv', uvExe, ['--version']],
      ['内置 agent-browser', browserExe, ['--version']],
    ]) {
      const result = runCommand(command, commandArgs);
      record(result.exitCode === 0 ? 'PASS' : 'FAIL', label, result.exitCode === 0
        ? result.stdout.trim() || result.stderr.trim()
        : result.error || result.stderr.trim() || `退出码 ${result.exitCode}`);
    }
  }

  if (!staticOnly && process.platform === 'win32') {
    const initialPids = listUClawPids();
    const hostPortInitiallyOpen = await probePort(13210);
    const gatewayPortInitiallyOpen = await probePort(18789);
    const foreignPortConflict = initialPids.length === 0 && (hostPortInitiallyOpen || gatewayPortInitiallyOpen);
    record(initialPids.length > 0 ? 'PASS' : 'INFO', 'UClaw 进程', initialPids.length > 0
      ? `发现 ${initialPids.length} 个 Electron 进程（正常的多进程架构）：${initialPids.join(', ')}`
      : '尚未运行');

    if (foreignPortConflict) {
      record('FAIL', '端口所有权', `UClaw 未运行，但端口已被占用：13210=${hostPortInitiallyOpen ? listeningPid(13210) ?? 'unknown' : 'free'}，18789=${gatewayPortInitiallyOpen ? listeningPid(18789) ?? 'unknown' : 'free'}；已跳过自动启动`);
    } else if (initialPids.length === 0 && startApp && requiredResults[0]) {
      try {
        const child = spawn(path.join(rootDir, 'UClaw.exe'), [], {
          cwd: rootDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();
        record('INFO', '启动 UClaw', `已启动 PID ${child.pid}，等待 Host API 与 Gateway`);
      } catch (error) {
        record('FAIL', '启动 UClaw', error instanceof Error ? error.message : String(error));
      }
    }

    const hostReady = foreignPortConflict ? hostPortInitiallyOpen : await waitForPort(13210, startApp ? 45_000 : 2_000);
    const gatewayReady = foreignPortConflict ? gatewayPortInitiallyOpen : await waitForPort(18789, startApp ? 45_000 : 2_000);
    record(hostReady ? 'PASS' : 'FAIL', 'Host API 端口 13210', hostReady
      ? `正在监听，PID ${listeningPid(13210) ?? 'unknown'}`
      : '未监听；应用主进程未完整启动或端口被系统保留');
    record(gatewayReady ? 'PASS' : 'WARN', 'Gateway 端口 18789', gatewayReady
      ? `正在监听，PID ${listeningPid(18789) ?? 'unknown'}`
      : '未监听；请检查登录状态、relay token、端口冲突及 Gateway 日志');
    if (hostReady) await probeHostApiAuthBoundary();

    const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
    const proxyState = proxyNames.map((name) => `${name}=${process.env[name] ? 'set' : 'unset'}`).join(', ');
    record('INFO', '代理环境变量', proxyState);
    const winHttp = runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & netsh.exe winhttp show proxy',
    ]);
    record(winHttp.exitCode === 0 ? 'INFO' : 'WARN', 'WinHTTP 代理', winHttp.exitCode === 0
      ? redactText(winHttp.stdout.trim()).replace(/\s+/g, ' ').slice(0, 600)
      : winHttp.error || winHttp.stderr.trim());

    await checkNetwork();
    if (requiredResults[3] && requiredResults[7]) await runOpenClawChecks(nodeExe, openClawEntry);
  } else {
    record('INFO', '动态运行检查', staticOnly ? '静态模式已跳过进程、端口、网络和 Doctor' : '仅在 Windows 上执行');
  }

  await scanRecentLogs();
}

async function finish() {
  const failures = records.filter((item) => item.level === 'FAIL').length;
  const warnings = records.filter((item) => item.level === 'WARN').length;
  const passes = records.filter((item) => item.level === 'PASS').length;
  const summary = `PASS=${passes} WARN=${warnings} FAIL=${failures}`;
  console.log(`\nSummary: ${summary}`);
  const lines = [
    'UClaw Windows USB Self-Check Report',
    `Version: ${SELF_CHECK_VERSION}`,
    `GeneratedAt: ${new Date().toISOString()}`,
    `Root: ${redactText(rootDir)}`,
    `Summary: ${summary}`,
    '',
    ...records.map((item) => `[${item.level}] ${item.check}: ${item.detail}`),
    '',
    'Privacy: configuration values, tokens, passwords, and raw logs are not included.',
  ];
  let reportWritten = false;
  try {
    await fsp.mkdir(diagnosticsDir, { recursive: true });
    await fsp.writeFile(reportPath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    reportWritten = true;
    console.log(`Report: ${reportPath}`);
  } catch (error) {
    console.error(`Report write failed: ${redactText(error instanceof Error ? error.message : String(error))}`);
  }

  const desktopDir = path.join(os.homedir(), 'Desktop');
  if (reportWritten && copyToDesktop && fs.existsSync(desktopDir)) {
    try {
      const desktopReport = path.join(desktopDir, reportName);
      await fsp.copyFile(reportPath, desktopReport);
      console.log(`Desktop copy: ${desktopReport}`);
    } catch {
      // The USB report remains authoritative when Desktop is unavailable.
    }
  }
  process.exitCode = failures > 0 ? 2 : warnings > 0 ? 1 : 0;
}

try {
  await main();
} catch (error) {
  record('FAIL', '自查程序', error instanceof Error ? error.stack || error.message : String(error));
}
await finish();
