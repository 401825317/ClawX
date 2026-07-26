import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function readPeMachine(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error('truncated DOS header');
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) throw new Error('missing MZ header');
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error('truncated PE header');
    }
    if (peHeader.readUInt32LE(0) !== 0x00004550) throw new Error('missing PE signature');
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const root = path.resolve(readArg('--root') || process.cwd());
const shouldStart = process.argv.includes('--start-app') && !process.argv.includes('--static-only');
const requiredFiles = [
  'UClaw.exe',
  'portable.flag',
  'resources/app.asar',
  'resources/uclaw-build.json',
  'resources/bin/node.exe',
  'resources/bin/uv.exe',
  'resources/bin/agent-browser.exe',
  'resources/cli/openclaw.cmd',
  'resources/openclaw/openclaw.mjs',
  'resources/openclaw/package.json',
  'resources/openclaw/node_modules/sharp/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  'resources/resources/updater/win32-x64/uclaw-portable-updater.exe',
];
const missing = requiredFiles.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
const architecture = {};
for (const relativePath of ['UClaw.exe', 'resources/bin/node.exe', 'resources/bin/uv.exe', 'resources/bin/agent-browser.exe']) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) continue;
  try {
    architecture[relativePath] = `0x${readPeMachine(filePath).toString(16)}`;
  } catch (error) {
    architecture[relativePath] = error instanceof Error ? error.message : String(error);
  }
}
const wrongArchitecture = Object.entries(architecture)
  .filter(([, machine]) => machine !== '0x8664')
  .map(([relativePath, machine]) => `${relativePath}=${machine}`);
const identity = readJson(path.join(root, 'resources', 'uclaw-build.json'));
const usbIdentity = readJson(path.join(root, 'uclaw-usb-build.json'));
const blocking = [
  ...missing.map((entry) => `missing:${entry}`),
  ...wrongArchitecture.map((entry) => `architecture:${entry}`),
];
if (!fs.existsSync(path.join(root, 'UClawData'))) {
  blocking.push('missing:UClawData');
}

const report = {
  schema: 'uclaw.windows-usb-self-check/v1',
  checkedAt: new Date().toISOString(),
  root,
  ok: blocking.length === 0,
  blocking,
  architecture,
  identity,
  usbIdentity,
};
const diagnosticsDir = path.join(root, 'UClawData', 'diagnostics');
fs.mkdirSync(diagnosticsDir, { recursive: true });
const reportPath = path.join(diagnosticsDir, `self-check-${Date.now()}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const entry of blocking) console.error(`[FAIL] ${entry}`);
if (blocking.length === 0) {
  console.log('[PASS] Package identity, runtime files, and x64 executables are valid.');
}
console.log(`Report: ${reportPath}`);

if (blocking.length === 0 && shouldStart) {
  const child = spawn(path.join(root, 'UClaw.exe'), [], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}
process.exit(blocking.length === 0 ? 0 : 2);
