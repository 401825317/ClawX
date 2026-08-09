import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import type { BlenderJobSnapshot } from './types';

const MAX_LOG_BYTES = 128 * 1024;

export type BlenderProcessEvent = {
  stage?: BlenderJobSnapshot['stage'];
  completed?: number;
  total?: number;
  message?: string;
};

export type BlenderProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function appendBounded(current: string, chunk: Buffer | string): string {
  const remaining = MAX_LOG_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  return current + Buffer.from(chunk).subarray(0, remaining).toString('utf8');
}

export function resolveTrustedBlenderRunner(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'resources', 'blender', 'runtime', 'uclaw_scene_runner.py');
  if (packaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'blender', 'runtime', 'uclaw_scene_runner.py');
}

export function terminateBlenderProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref();
      return;
    } catch {
      // Fall through to a direct signal.
    }
  }
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The child can exit before its process group is signalled.
    }
  }
  try { child.kill('SIGKILL'); } catch { /* best effort */ }
}

export function runTrustedBlender(
  executable: string,
  snapshot: BlenderJobSnapshot,
  onEvent: (event: BlenderProcessEvent) => void,
  onChild: (child: ChildProcess) => void,
): Promise<BlenderProcessResult> {
  const runner = resolveTrustedBlenderRunner();
  if (!existsSync(runner)) return Promise.reject(new Error(`Trusted Blender runner is missing: ${runner}`));
  const specPath = path.join(snapshot.jobDir, 'scene.json');
  const args = [
    '--background', '--factory-startup', '--disable-autoexec',
    '--python', runner, '--',
    '--spec', specPath,
    '--job-dir', snapshot.jobDir,
  ];
  const runtimeHome = path.join(snapshot.jobDir, 'blender-runtime-home');
  const runtimeConfig = path.join(runtimeHome, 'config');
  const runtimeData = path.join(runtimeHome, 'data');
  const runtimeScripts = path.join(runtimeHome, 'scripts');
  mkdirSync(runtimeConfig, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeData, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeScripts, { recursive: true, mode: 0o700 });
  const timeoutMs = Math.max(10, snapshot.sceneSpec.budgets?.maxRenderSeconds ?? 300) * 1000 + 30_000;
  const child = spawn(executable, args, {
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: runtimeHome,
      CFFIXED_USER_HOME: runtimeHome,
      XDG_CONFIG_HOME: runtimeConfig,
      BLENDER_USER_CONFIG: runtimeConfig,
      BLENDER_USER_DATAFILES: runtimeData,
      BLENDER_USER_SCRIPTS: runtimeScripts,
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '',
    },
  });
  onChild(child);
  return new Promise<BlenderProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lineBuffer = '';
    const timer = setTimeout(() => {
      timedOut = true;
      terminateBlenderProcess(child);
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'uclaw.blender.progress') {
            onEvent({
              stage: typeof parsed.stage === 'string' ? parsed.stage as BlenderJobSnapshot['stage'] : undefined,
              completed: typeof parsed.completed === 'number' ? parsed.completed : undefined,
              total: typeof parsed.total === 'number' ? parsed.total : undefined,
              message: typeof parsed.message === 'string' ? parsed.message.slice(0, 300) : undefined,
            });
          }
        } catch {
          // Blender writes normal diagnostics to stdout too; journal remains bounded.
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}
