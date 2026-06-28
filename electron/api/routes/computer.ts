import type { IncomingMessage, ServerResponse } from 'http';
import { BrowserWindow, clipboard, desktopCapturer, screen } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getOpenClawMediaDir } from '../../utils/paths';

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 8_000;
const MAX_TYPE_TEXT_LENGTH = 20_000;
const SYSTEM_WINDOW_ACTIONS = new Set(['focus', 'restore', 'minimize', 'maximize', 'close']);
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_SHOWWINDOW = 0x0040;

function getDesktopScreenshotsDir(): string {
  return join(getOpenClawMediaDir(), 'desktop-screenshots');
}

function buildScreenshotFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomUUID().slice(0, 8);
  return `desktop-screenshot-${stamp}-${suffix}.png`;
}

function buildWindowScreenshotFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomUUID().slice(0, 8);
  return `window-screenshot-${stamp}-${suffix}.png`;
}

export async function captureDesktopScreenshot(): Promise<{
  fileName: string;
  filePath: string;
  mimeType: 'image/png';
  fileSize: number;
  preview: string;
  sourceName?: string;
}> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });
  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No desktop screen is available for screenshot capture');
  }

  const png = source.thumbnail.toPNG();
  const outDir = getDesktopScreenshotsDir();
  await mkdir(outDir, { recursive: true });
  const fileName = buildScreenshotFileName();
  const filePath = join(outDir, fileName);
  await writeFile(filePath, png);

  return {
    fileName: basename(filePath),
    filePath,
    mimeType: 'image/png',
    fileSize: png.byteLength,
    preview: `data:image/png;base64,${png.toString('base64')}`,
    sourceName: source.name,
  };
}

async function listWindowSources(): Promise<Array<{
  id: string;
  name: string;
  thumbnailPreview: string | null;
}>> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: false,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailPreview: source.thumbnail.isEmpty()
      ? null
      : `data:image/png;base64,${source.thumbnail.toPNG().toString('base64')}`,
  }));
}

async function captureWindowScreenshot(input: {
  sourceId?: unknown;
  titleIncludes?: unknown;
}): Promise<{
  fileName: string;
  filePath: string;
  mimeType: 'image/png';
  fileSize: number;
  preview: string;
  sourceId: string;
  sourceName: string;
}> {
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : '';
  const titleIncludes = typeof input.titleIncludes === 'string' ? input.titleIncludes.trim().toLowerCase() : '';
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });

  const source = sources.find((candidate) => sourceId && candidate.id === sourceId)
    ?? sources.find((candidate) => titleIncludes && candidate.name.toLowerCase().includes(titleIncludes))
    ?? sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No application window is available for screenshot capture');
  }

  const png = source.thumbnail.toPNG();
  const outDir = getDesktopScreenshotsDir();
  await mkdir(outDir, { recursive: true });
  const fileName = buildWindowScreenshotFileName();
  const filePath = join(outDir, fileName);
  await writeFile(filePath, png);

  return {
    fileName: basename(filePath),
    filePath,
    mimeType: 'image/png',
    fileSize: png.byteLength,
    preview: `data:image/png;base64,${png.toString('base64')}`,
    sourceId: source.id,
    sourceName: source.name,
  };
}

function getWindowList(): Array<{
  id: number;
  title: string;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  bounds: Electron.Rectangle;
}> {
  return BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => ({
      id: window.id,
      title: window.getTitle(),
      focused: window.isFocused(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      bounds: window.getBounds(),
    }));
}

function getDisplayList(): Array<{
  id: number;
  label: string;
  scaleFactor: number;
  bounds: Electron.Rectangle;
  workArea: Electron.Rectangle;
}> {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    label: display.label,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    workArea: display.workArea,
  }));
}

function unsupportedOnThisPlatform(action: string): never {
  throw new Error(`${action} is currently supported on Windows only`);
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runWindowsPowerShellJson<T>(script: string): Promise<T> {
  if (process.platform !== 'win32') {
    unsupportedOnThisPlatform('Computer control');
  }

  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell([
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8',
        script,
      ].join('\n')),
    ],
    {
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );

  const raw = stdout.trim();
  if (!raw) {
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function powerShellJsonInput(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {}), 'utf8').toString('base64');
}

function powerShellJsonInputScript(value: unknown): string {
  const encoded = powerShellJsonInput(value);
  return `$InputJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encoded}")) | ConvertFrom-Json`;
}

function toFiniteNumber(value: unknown, field: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${field} must be a finite number`);
  }
  return numberValue;
}

function toInteger(value: unknown, field: string): number {
  const numberValue = Math.trunc(toFiniteNumber(value, field));
  return numberValue;
}

function normalizeMouseButton(value: unknown): 'left' | 'right' | 'middle' {
  const button = typeof value === 'string' ? value.toLowerCase().trim() : 'left';
  if (button === 'left' || button === 'right' || button === 'middle') {
    return button;
  }
  throw new Error('button must be one of: left, right, middle');
}

function mouseButtonFlags(button: 'left' | 'right' | 'middle'): { down: number; up: number } {
  if (button === 'right') return { down: 0x0008, up: 0x0010 };
  if (button === 'middle') return { down: 0x0020, up: 0x0040 };
  return { down: 0x0002, up: 0x0004 };
}

const VK_CODES: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  pause: 0x13,
  capslock: 0x14,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  win: 0x5b,
  meta: 0x5b,
  command: 0x5b,
  numlock: 0x90,
  scrolllock: 0x91,
};

for (let code = 0x30; code <= 0x39; code += 1) {
  VK_CODES[String.fromCharCode(code).toLowerCase()] = code;
}
for (let code = 0x41; code <= 0x5a; code += 1) {
  VK_CODES[String.fromCharCode(code).toLowerCase()] = code;
}
for (let index = 1; index <= 24; index += 1) {
  VK_CODES[`f${index}`] = 0x6f + index;
}

function normalizeKey(value: unknown): { label: string; vk: number } {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('key must be a non-empty string');
  }
  const label = value.trim().toLowerCase();
  const vk = VK_CODES[label];
  if (!vk) {
    throw new Error(`Unsupported key: ${value}`);
  }
  return { label, vk };
}

function normalizeModifiers(value: unknown): Array<{ label: string; vk: number }> {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeKey);
}

async function getCursorPosition(): Promise<{ x: number; y: number }> {
  return await runWindowsPowerShellJson<{ x: number; y: number }>(`
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress
`);
}

async function moveMouse(input: { x?: unknown; y?: unknown }): Promise<{ x: number; y: number }> {
  const x = toInteger(input.x, 'x');
  const y = toInteger(input.y, 'y');
  return await runWindowsPowerShellJson<{ x: number; y: number }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
}
"@
[void][UClawMouse]::SetCursorPos(${x}, ${y})
[pscustomobject]@{ x = ${x}; y = ${y} } | ConvertTo-Json -Compress
`);
}

async function clickMouse(input: {
  x?: unknown;
  y?: unknown;
  button?: unknown;
  clicks?: unknown;
}): Promise<{ x?: number; y?: number; button: string; clicks: number }> {
  const hasX = input.x !== undefined && input.x !== null;
  const hasY = input.y !== undefined && input.y !== null;
  if (hasX !== hasY) {
    throw new Error('x and y must be provided together');
  }
  const x = hasX ? toInteger(input.x, 'x') : null;
  const y = hasY ? toInteger(input.y, 'y') : null;
  const button = normalizeMouseButton(input.button);
  const clicks = Math.max(1, Math.min(3, input.clicks === undefined ? 1 : toInteger(input.clicks, 'clicks')));
  const flags = mouseButtonFlags(button);

  return await runWindowsPowerShellJson<{ x?: number; y?: number; button: string; clicks: number }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
${x !== null && y !== null ? `[void][UClawMouse]::SetCursorPos(${x}, ${y})` : ''}
for ($i = 0; $i -lt ${clicks}; $i++) {
  [UClawMouse]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [UClawMouse]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
}
[pscustomobject]@{ ${x !== null ? `x = ${x}; y = ${y};` : ''} button = "${button}"; clicks = ${clicks} } | ConvertTo-Json -Compress
`);
}

async function mouseButton(input: {
  button?: unknown;
  action?: unknown;
}): Promise<{ button: string; action: string }> {
  const button = normalizeMouseButton(input.button);
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
  if (action !== 'down' && action !== 'up') {
    throw new Error('action must be one of: down, up');
  }
  const flags = mouseButtonFlags(button);
  const selectedFlag = action === 'down' ? flags.down : flags.up;

  return await runWindowsPowerShellJson<{ button: string; action: string }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawMouse {
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[UClawMouse]::mouse_event(${selectedFlag}, 0, 0, 0, [UIntPtr]::Zero)
[pscustomobject]@{ button = "${button}"; action = "${action}" } | ConvertTo-Json -Compress
`);
}

async function scrollMouse(input: {
  delta?: unknown;
  x?: unknown;
  y?: unknown;
}): Promise<{ delta: number; x?: number; y?: number }> {
  const delta = Math.max(-10_000, Math.min(10_000, toInteger(input.delta ?? -120, 'delta')));
  const hasX = input.x !== undefined && input.x !== null;
  const hasY = input.y !== undefined && input.y !== null;
  if (hasX !== hasY) {
    throw new Error('x and y must be provided together');
  }
  const x = hasX ? toInteger(input.x, 'x') : null;
  const y = hasY ? toInteger(input.y, 'y') : null;

  return await runWindowsPowerShellJson<{ delta: number; x?: number; y?: number }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
"@
${x !== null && y !== null ? `[void][UClawMouse]::SetCursorPos(${x}, ${y})` : ''}
[UClawMouse]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)
[pscustomobject]@{ delta = ${delta}; ${x !== null ? `x = ${x}; y = ${y};` : ''} } | ConvertTo-Json -Compress
`);
}

async function dragMouse(input: {
  fromX?: unknown;
  fromY?: unknown;
  toX?: unknown;
  toY?: unknown;
  button?: unknown;
  durationMs?: unknown;
}): Promise<{ fromX: number; fromY: number; toX: number; toY: number; button: string; durationMs: number }> {
  const fromX = toInteger(input.fromX, 'fromX');
  const fromY = toInteger(input.fromY, 'fromY');
  const toX = toInteger(input.toX, 'toX');
  const toY = toInteger(input.toY, 'toY');
  const button = normalizeMouseButton(input.button);
  const durationMs = Math.max(0, Math.min(5_000, input.durationMs === undefined ? 350 : toInteger(input.durationMs, 'durationMs')));
  const flags = mouseButtonFlags(button);
  const steps = Math.max(1, Math.min(60, Math.ceil(durationMs / 25)));
  const sleepMs = Math.max(1, Math.floor(durationMs / steps));

  return await runWindowsPowerShellJson<{ fromX: number; fromY: number; toX: number; toY: number; button: string; durationMs: number }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
[void][UClawMouse]::SetCursorPos(${fromX}, ${fromY})
Start-Sleep -Milliseconds 35
[UClawMouse]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le ${steps}; $i++) {
  $x = [int](${fromX} + ((${toX} - ${fromX}) * $i / ${steps}))
  $y = [int](${fromY} + ((${toY} - ${fromY}) * $i / ${steps}))
  [void][UClawMouse]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds ${sleepMs}
}
[UClawMouse]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)
[pscustomobject]@{ fromX = ${fromX}; fromY = ${fromY}; toX = ${toX}; toY = ${toY}; button = "${button}"; durationMs = ${durationMs} } | ConvertTo-Json -Compress
`);
}

async function pressKey(input: { key?: unknown; modifiers?: unknown }): Promise<{
  key: string;
  modifiers: string[];
}> {
  const key = normalizeKey(input.key);
  const modifiers = normalizeModifiers(input.modifiers);
  const downSequence = [...modifiers, key];
  const upSequence = [...downSequence].reverse();
  const downScript = downSequence.map((item) => `[UClawKeyboard]::keybd_event(${item.vk}, 0, 0, [UIntPtr]::Zero)`).join('\n');
  const upScript = upSequence.map((item) => `[UClawKeyboard]::keybd_event(${item.vk}, 0, 2, [UIntPtr]::Zero)`).join('\n');

  return await runWindowsPowerShellJson<{ key: string; modifiers: string[] }>(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UClawKeyboard {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
${downScript}
Start-Sleep -Milliseconds 35
${upScript}
[pscustomobject]@{ key = "${key.label}"; modifiers = @(${modifiers.map((item) => `"${item.label}"`).join(', ')}) } | ConvertTo-Json -Compress
`);
}

async function typeText(input: { text?: unknown }): Promise<{ length: number; method: 'clipboard-paste' }> {
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > MAX_TYPE_TEXT_LENGTH) {
    throw new Error(`text is too long; max ${MAX_TYPE_TEXT_LENGTH} characters`);
  }
  clipboard.writeText(text);
  await pressKey({ key: 'v', modifiers: ['ctrl'] });
  return { length: text.length, method: 'clipboard-paste' };
}

const WINDOWS_ENUM_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UClawWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
function Get-UClawWindowText([IntPtr]$Handle) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][UClawWindows]::GetWindowText($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}
function Get-UClawClassName([IntPtr]$Handle) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][UClawWindows]::GetClassName($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}
function Get-UClawSystemWindows {
  $items = New-Object System.Collections.Generic.List[object]
  $callback = [UClawWindows+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $title = Get-UClawWindowText $hWnd
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    $rect = New-Object UClawWindows+RECT
    [void][UClawWindows]::GetWindowRect($hWnd, [ref]$rect)
    $processIdValue = 0
    [void][UClawWindows]::GetWindowThreadProcessId($hWnd, [ref]$processIdValue)
    $processName = $null
    try { $processName = (Get-Process -Id $processIdValue -ErrorAction Stop).ProcessName } catch {}
    $items.Add([pscustomobject]@{
      hwnd = $hWnd.ToInt64()
      title = $title
      className = Get-UClawClassName $hWnd
      visible = [UClawWindows]::IsWindowVisible($hWnd)
      enabled = [UClawWindows]::IsWindowEnabled($hWnd)
      minimized = [UClawWindows]::IsIconic($hWnd)
      processId = [int]$processIdValue
      processName = $processName
      bounds = [pscustomobject]@{
        x = $rect.Left
        y = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
      }
    })
    return $true
  }
  [void][UClawWindows]::EnumWindows($callback, [IntPtr]::Zero)
  $items
}
function Convert-UClawWindow([IntPtr]$hWnd) {
  if ($hWnd -eq [IntPtr]::Zero) { return $null }
  $title = Get-UClawWindowText $hWnd
  $rect = New-Object UClawWindows+RECT
  [void][UClawWindows]::GetWindowRect($hWnd, [ref]$rect)
  $processIdValue = 0
  [void][UClawWindows]::GetWindowThreadProcessId($hWnd, [ref]$processIdValue)
  $processName = $null
  try { $processName = (Get-Process -Id $processIdValue -ErrorAction Stop).ProcessName } catch {}
  [pscustomobject]@{
    hwnd = $hWnd.ToInt64()
    title = $title
    className = Get-UClawClassName $hWnd
    visible = [UClawWindows]::IsWindowVisible($hWnd)
    enabled = [UClawWindows]::IsWindowEnabled($hWnd)
    minimized = [UClawWindows]::IsIconic($hWnd)
    processId = [int]$processIdValue
    processName = $processName
    bounds = [pscustomobject]@{
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    }
  }
}
`;

async function listSystemWindows(input: {
  titleIncludes?: unknown;
  processName?: unknown;
  visibleOnly?: unknown;
  limit?: unknown;
}): Promise<{ windows: unknown[] }> {
  const titleIncludes = typeof input.titleIncludes === 'string' ? input.titleIncludes.trim() : '';
  const processName = typeof input.processName === 'string' ? input.processName.trim() : '';
  const visibleOnly = input.visibleOnly !== false;
  const limit = Math.max(1, Math.min(200, input.limit === undefined ? 80 : toInteger(input.limit, 'limit')));
  return await runWindowsPowerShellJson<{ windows: unknown[] }>(`
${powerShellJsonInputScript({ titleIncludes, processName, visibleOnly, limit })}
${WINDOWS_ENUM_SCRIPT}
$windows = Get-UClawSystemWindows
if ($InputJson.visibleOnly) {
  $windows = $windows | Where-Object { $_.visible -eq $true }
}
if ($InputJson.titleIncludes) {
  $needle = [string]$InputJson.titleIncludes
  $windows = $windows | Where-Object { $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
}
if ($InputJson.processName) {
  $proc = [string]$InputJson.processName
  $windows = $windows | Where-Object { $_.processName -and $_.processName.Equals($proc, [System.StringComparison]::OrdinalIgnoreCase) }
}
$selected = @($windows | Select-Object -First ([int]$InputJson.limit))
[pscustomobject]@{ windows = $selected } | ConvertTo-Json -Compress -Depth 6
`);
}

async function controlSystemWindow(input: {
  hwnd?: unknown;
  titleIncludes?: unknown;
  action?: unknown;
}): Promise<{
  hwnd: number;
  title: string;
  action: string;
  success: boolean;
}> {
  const hwnd = input.hwnd === undefined || input.hwnd === null ? null : toInteger(input.hwnd, 'hwnd');
  const titleIncludes = typeof input.titleIncludes === 'string' ? input.titleIncludes.trim() : '';
  const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : 'focus';
  if (!SYSTEM_WINDOW_ACTIONS.has(action)) {
    throw new Error(`action must be one of: ${Array.from(SYSTEM_WINDOW_ACTIONS).join(', ')}`);
  }
  if (!hwnd && !titleIncludes) {
    throw new Error('hwnd or titleIncludes is required');
  }

  return await runWindowsPowerShellJson<{
    hwnd: number;
    title: string;
    action: string;
    success: boolean;
  }>(`
${powerShellJsonInputScript({ hwnd, titleIncludes, action })}
${WINDOWS_ENUM_SCRIPT}
$target = $null
if ($InputJson.hwnd) {
  $target = Get-UClawSystemWindows | Where-Object { $_.hwnd -eq [int64]$InputJson.hwnd } | Select-Object -First 1
} elseif ($InputJson.titleIncludes) {
  $needle = [string]$InputJson.titleIncludes
  $target = Get-UClawSystemWindows | Where-Object { $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
}
if (-not $target) { throw "No matching system window found" }
$handle = [IntPtr]::new([int64]$target.hwnd)
$ok = $false
switch ([string]$InputJson.action) {
  "focus" {
    [void][UClawWindows]::ShowWindow($handle, 9)
    $ok = [UClawWindows]::SetForegroundWindow($handle)
  }
  "restore" { $ok = [UClawWindows]::ShowWindow($handle, 9) }
  "minimize" { $ok = [UClawWindows]::ShowWindow($handle, 6) }
  "maximize" { $ok = [UClawWindows]::ShowWindow($handle, 3) }
  "close" { $ok = [UClawWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
}
[pscustomobject]@{ hwnd = $target.hwnd; title = $target.title; action = [string]$InputJson.action; success = [bool]$ok } | ConvertTo-Json -Compress
`);
}

async function getForegroundSystemWindow(): Promise<{ window: unknown | null }> {
  return await runWindowsPowerShellJson<{ window: unknown | null }>(`
${WINDOWS_ENUM_SCRIPT}
$window = Convert-UClawWindow ([UClawWindows]::GetForegroundWindow())
[pscustomobject]@{ window = $window } | ConvertTo-Json -Compress -Depth 6
`);
}

async function setSystemWindowBounds(input: {
  hwnd?: unknown;
  titleIncludes?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}): Promise<{ hwnd: number; title: string; bounds: unknown; success: boolean }> {
  const hwnd = input.hwnd === undefined || input.hwnd === null ? null : toInteger(input.hwnd, 'hwnd');
  const titleIncludes = typeof input.titleIncludes === 'string' ? input.titleIncludes.trim() : '';
  if (!hwnd && !titleIncludes) {
    throw new Error('hwnd or titleIncludes is required');
  }
  const hasMove = input.x !== undefined || input.y !== undefined;
  const hasSize = input.width !== undefined || input.height !== undefined;
  if ((input.x === undefined) !== (input.y === undefined)) {
    throw new Error('x and y must be provided together');
  }
  if ((input.width === undefined) !== (input.height === undefined)) {
    throw new Error('width and height must be provided together');
  }
  if (!hasMove && !hasSize) {
    throw new Error('At least one of x/y or width/height is required');
  }
  const x = hasMove ? toInteger(input.x, 'x') : 0;
  const y = hasMove ? toInteger(input.y, 'y') : 0;
  const width = hasSize ? Math.max(1, toInteger(input.width, 'width')) : 0;
  const height = hasSize ? Math.max(1, toInteger(input.height, 'height')) : 0;
  const flags = SWP_SHOWWINDOW
    | (hasMove ? 0 : SWP_NOMOVE)
    | (hasSize ? 0 : SWP_NOSIZE);

  return await runWindowsPowerShellJson<{ hwnd: number; title: string; bounds: unknown; success: boolean }>(`
${powerShellJsonInputScript({ hwnd, titleIncludes, x, y, width, height, flags })}
${WINDOWS_ENUM_SCRIPT}
$target = $null
if ($InputJson.hwnd) {
  $target = Get-UClawSystemWindows | Where-Object { $_.hwnd -eq [int64]$InputJson.hwnd } | Select-Object -First 1
} elseif ($InputJson.titleIncludes) {
  $needle = [string]$InputJson.titleIncludes
  $target = Get-UClawSystemWindows | Where-Object { $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
}
if (-not $target) { throw "No matching system window found" }
$handle = [IntPtr]::new([int64]$target.hwnd)
$ok = [UClawWindows]::SetWindowPos($handle, [IntPtr]::Zero, [int]$InputJson.x, [int]$InputJson.y, [int]$InputJson.width, [int]$InputJson.height, [uint32]$InputJson.flags)
$next = Convert-UClawWindow $handle
[pscustomobject]@{ hwnd = $next.hwnd; title = $next.title; bounds = $next.bounds; success = [bool]$ok } | ConvertTo-Json -Compress -Depth 6
`);
}

async function setSystemWindowTopmost(input: {
  hwnd?: unknown;
  titleIncludes?: unknown;
  topmost?: unknown;
}): Promise<{ hwnd: number; title: string; topmost: boolean; success: boolean }> {
  const hwnd = input.hwnd === undefined || input.hwnd === null ? null : toInteger(input.hwnd, 'hwnd');
  const titleIncludes = typeof input.titleIncludes === 'string' ? input.titleIncludes.trim() : '';
  const topmost = input.topmost !== false;
  if (!hwnd && !titleIncludes) {
    throw new Error('hwnd or titleIncludes is required');
  }
  const insertAfter = topmost ? -1 : -2;
  const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;

  return await runWindowsPowerShellJson<{ hwnd: number; title: string; topmost: boolean; success: boolean }>(`
${powerShellJsonInputScript({ hwnd, titleIncludes, topmost, insertAfter, flags })}
${WINDOWS_ENUM_SCRIPT}
$target = $null
if ($InputJson.hwnd) {
  $target = Get-UClawSystemWindows | Where-Object { $_.hwnd -eq [int64]$InputJson.hwnd } | Select-Object -First 1
} elseif ($InputJson.titleIncludes) {
  $needle = [string]$InputJson.titleIncludes
  $target = Get-UClawSystemWindows | Where-Object { $_.title.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
}
if (-not $target) { throw "No matching system window found" }
$handle = [IntPtr]::new([int64]$target.hwnd)
$ok = [UClawWindows]::SetWindowPos($handle, [IntPtr]::new([int64]$InputJson.insertAfter), 0, 0, 0, 0, [uint32]$InputJson.flags)
[pscustomobject]@{ hwnd = $target.hwnd; title = $target.title; topmost = [bool]$InputJson.topmost; success = [bool]$ok } | ConvertTo-Json -Compress
`);
}

async function setFileDialogPath(input: { filePath?: unknown; submit?: unknown }): Promise<{
  length: number;
  submitted: boolean;
  method: 'clipboard-paste';
}> {
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  if (!filePath.trim()) {
    throw new Error('filePath is required');
  }
  if (filePath.length > 32_000) {
    throw new Error('filePath is too long');
  }
  clipboard.writeText(filePath);
  await pressKey({ key: 'v', modifiers: ['ctrl'] });
  const submit = input.submit !== false;
  if (submit) {
    await pressKey({ key: 'enter' });
  }
  return { length: filePath.length, submitted: submit, method: 'clipboard-paste' };
}

async function inspectScreen(input: {
  target?: unknown;
  sourceId?: unknown;
  titleIncludes?: unknown;
}): Promise<{
  screenshot: Awaited<ReturnType<typeof captureDesktopScreenshot>> | Awaited<ReturnType<typeof captureWindowScreenshot>>;
  ocr: {
    supported: false;
    text: '';
    blocks: [];
    reason: string;
  };
}> {
  const target = typeof input.target === 'string' ? input.target.trim().toLowerCase() : 'desktop';
  const screenshot = target === 'window'
    ? await captureWindowScreenshot(input)
    : await captureDesktopScreenshot();

  return {
    screenshot,
    ocr: {
      supported: false,
      text: '',
      blocks: [],
      reason: 'Local OCR runtime is not bundled yet. Use the screenshot artifact with a vision-capable model, or enable a future OCR provider.',
    },
  };
}

export async function handleComputerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (
    (url.pathname === '/api/computer/desktop-screenshot' || url.pathname === '/api/computer/screenshot')
    && req.method === 'POST'
  ) {
    const screenshot = await captureDesktopScreenshot();
    sendJson(res, 200, {
      success: true,
      screenshot,
      result: screenshot,
    });
    return true;
  }

  if (url.pathname === '/api/computer/clipboard/read' && req.method === 'POST') {
    const text = clipboard.readText();
    sendJson(res, 200, {
      success: true,
      result: {
        text,
        length: text.length,
      },
    });
    return true;
  }

  if (url.pathname === '/api/computer/clipboard/write' && req.method === 'POST') {
    const body = await parseJsonBody<{ text?: unknown }>(req);
    const text = typeof body.text === 'string' ? body.text : '';
    clipboard.writeText(text);
    sendJson(res, 200, {
      success: true,
      result: {
        length: text.length,
      },
    });
    return true;
  }

  if (url.pathname === '/api/computer/windows' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      result: {
        windows: getWindowList(),
      },
    });
    return true;
  }

  if (url.pathname === '/api/computer/system-windows' && req.method === 'POST') {
    const body = await parseJsonBody<{
      titleIncludes?: unknown;
      processName?: unknown;
      visibleOnly?: unknown;
      limit?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await listSystemWindows(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/system-window/control' && req.method === 'POST') {
    const body = await parseJsonBody<{
      hwnd?: unknown;
      titleIncludes?: unknown;
      action?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await controlSystemWindow(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/system-window/foreground' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      result: await getForegroundSystemWindow(),
    });
    return true;
  }

  if (url.pathname === '/api/computer/system-window/bounds' && req.method === 'POST') {
    const body = await parseJsonBody<{
      hwnd?: unknown;
      titleIncludes?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await setSystemWindowBounds(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/system-window/topmost' && req.method === 'POST') {
    const body = await parseJsonBody<{
      hwnd?: unknown;
      titleIncludes?: unknown;
      topmost?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await setSystemWindowTopmost(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/window-sources' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      result: {
        windows: await listWindowSources(),
      },
    });
    return true;
  }

  if (url.pathname === '/api/computer/window-screenshot' && req.method === 'POST') {
    const body = await parseJsonBody<{ sourceId?: unknown; titleIncludes?: unknown }>(req);
    const screenshot = await captureWindowScreenshot(body);
    sendJson(res, 200, {
      success: true,
      screenshot,
      result: screenshot,
    });
    return true;
  }

  if (url.pathname === '/api/computer/inspect' && req.method === 'POST') {
    const body = await parseJsonBody<{
      target?: unknown;
      sourceId?: unknown;
      titleIncludes?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await inspectScreen(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/displays' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      result: {
        displays: getDisplayList(),
      },
    });
    return true;
  }

  if (url.pathname === '/api/computer/cursor' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      result: await getCursorPosition(),
    });
    return true;
  }

  if (url.pathname === '/api/computer/mouse/move' && req.method === 'POST') {
    const body = await parseJsonBody<{ x?: unknown; y?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await moveMouse(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/mouse/click' && req.method === 'POST') {
    const body = await parseJsonBody<{ x?: unknown; y?: unknown; button?: unknown; clicks?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await clickMouse(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/mouse/button' && req.method === 'POST') {
    const body = await parseJsonBody<{ button?: unknown; action?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await mouseButton(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/mouse/scroll' && req.method === 'POST') {
    const body = await parseJsonBody<{ delta?: unknown; x?: unknown; y?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await scrollMouse(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/mouse/drag' && req.method === 'POST') {
    const body = await parseJsonBody<{
      fromX?: unknown;
      fromY?: unknown;
      toX?: unknown;
      toY?: unknown;
      button?: unknown;
      durationMs?: unknown;
    }>(req);
    sendJson(res, 200, {
      success: true,
      result: await dragMouse(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/keyboard/press' && req.method === 'POST') {
    const body = await parseJsonBody<{ key?: unknown; modifiers?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await pressKey(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/keyboard/type' && req.method === 'POST') {
    const body = await parseJsonBody<{ text?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await typeText(body),
    });
    return true;
  }

  if (url.pathname === '/api/computer/file-dialog/set-path' && req.method === 'POST') {
    const body = await parseJsonBody<{ filePath?: unknown; submit?: unknown }>(req);
    sendJson(res, 200, {
      success: true,
      result: await setFileDialogPath(body),
    });
    return true;
  }

  return false;
}
