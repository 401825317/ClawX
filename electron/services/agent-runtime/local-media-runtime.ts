import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EdgeTTS } from 'node-edge-tts';
import { getGeneratedMediaRootDir } from '../../utils/generated-media-store';
import { getOpenClawConfigDir, resolveOpenClawHomeDir } from '../../utils/paths';

export const DEFAULT_NARRATION_VOICE = 'zh-CN-XiaoxiaoNeural';

export type NarrationSynthesisResult = {
  path: string;
  engine: 'microsoft-neural' | 'system';
  voice: string;
};

export type LocalMediaTools = {
  ffmpeg: string;
  ffprobe: string;
  source: 'explicit' | 'packaged' | 'development';
};

export type ProbedMediaMetadata = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
};

export type ProcessRunner = (
  executable: string,
  args: string[],
  stdin?: string,
) => Promise<{ stdout: string; stderr: string }>;

export async function resolveManagedLocalMediaFile(filePath: string, label: string): Promise<string> {
  const actual = await fs.realpath(filePath);
  const candidateRoots = [...new Set([
    getOpenClawConfigDir(),
    getGeneratedMediaRootDir(),
    path.join(resolveOpenClawHomeDir(), '.openclaw'),
  ])];
  const managedRoots = (await Promise.all(candidateRoots.map(async (root) => {
    try {
      return await fs.realpath(root);
    } catch {
      return undefined;
    }
  }))).filter((root): root is string => Boolean(root));
  const isManaged = managedRoots.some((root) => {
    const relative = path.relative(root, actual);
    return relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (!isManaged) throw new Error(`${label} is outside the managed UClaw media directories: ${filePath}`);
  const fileStat = await fs.stat(actual);
  if (!fileStat.isFile() || fileStat.size <= 0) throw new Error(`${label} is not a readable file: ${filePath}`);
  return actual;
}

function executableName(name: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function executableFile(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    await fs.access(filePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    const fileStat = await fs.stat(filePath);
    return fileStat.isFile() && fileStat.size > 0 ? filePath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveToolPair(root: string, source: LocalMediaTools['source']): Promise<LocalMediaTools | undefined> {
  const ffmpeg = await executableFile(path.join(root, executableName('ffmpeg')));
  const ffprobe = await executableFile(path.join(root, executableName('ffprobe')));
  return ffmpeg && ffprobe ? { ffmpeg, ffprobe, source } : undefined;
}

export async function resolveLocalMediaTools(): Promise<LocalMediaTools | undefined> {
  const explicitFfmpeg = await executableFile(process.env.UCLAW_FFMPEG_PATH?.trim());
  const explicitFfprobe = await executableFile(process.env.UCLAW_FFPROBE_PATH?.trim());
  if (explicitFfmpeg && explicitFfprobe) {
    return { ffmpeg: explicitFfmpeg, ffprobe: explicitFfprobe, source: 'explicit' };
  }

  const packagedRoot = process.resourcesPath?.trim();
  if (packagedRoot) {
    const packaged = await resolveToolPair(path.join(packagedRoot, 'bin'), 'packaged');
    if (packaged) return packaged;
  }

  const target = `${process.platform}-${process.arch}`;
  return await resolveToolPair(path.join(process.cwd(), 'resources', 'bin', target), 'development');
}

async function runCapturedProcess(
  executable: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'pipe', windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(executable)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(signal ? `${path.basename(executable)} stopped by ${signal}` : (stderr.trim() || `${path.basename(executable)} exited with code ${code}`)));
    });
  });
}

export async function assessLocalMediaRuntime(): Promise<{ availability: 'available' | 'unavailable'; reason?: string; tools?: LocalMediaTools }> {
  const tools = await resolveLocalMediaTools();
  if (!tools) {
    return {
      availability: 'unavailable',
      reason: `Packaged FFmpeg/ffprobe runtime is missing for ${process.platform}-${process.arch}.`,
    };
  }
  try {
    await Promise.all([
      runCapturedProcess(tools.ffmpeg, ['-hide_banner', '-version']),
      runCapturedProcess(tools.ffprobe, ['-hide_banner', '-version']),
    ]);
    return { availability: 'available', tools };
  } catch (error) {
    return {
      availability: 'unavailable',
      reason: `Packaged media runtime cannot execute: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function probeMediaFile(ffprobe: string, filePath: string): Promise<ProbedMediaMetadata> {
  const { stdout } = await runCapturedProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], 60_000);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string | number };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const duration = Number(parsed.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : undefined,
    width: typeof video?.width === 'number' ? video.width : undefined,
    height: typeof video?.height === 'number' ? video.height : undefined,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') === true,
    hasVideo: Boolean(video),
  };
}

async function findPathExecutable(names: string[]): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const entry of pathEntries) {
      const candidate = await executableFile(path.join(entry, name));
      if (candidate) return candidate;
    }
  }
  return undefined;
}

export async function synthesizeNarration(params: {
  outputDir: string;
  text: string;
  voice: string;
  run: ProcessRunner;
}): Promise<NarrationSynthesisResult> {
  const textPath = path.join(params.outputDir, 'narration.txt');
  await fs.writeFile(textPath, params.text, 'utf8');

  if (/Neural$/iu.test(params.voice)) {
    const outputPath = path.join(params.outputDir, 'narration.mp3');
    try {
      await fs.rm(outputPath, { force: true });
      const tts = new EdgeTTS({
        voice: params.voice,
        lang: params.voice.split('-').slice(0, 2).join('-') || 'zh-CN',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        rate: '-2%',
        timeout: 60_000,
      });
      await tts.ttsPromise(params.text, outputPath);
      const outputStat = await fs.stat(outputPath);
      if (outputStat.size <= 0) throw new Error('Microsoft neural TTS returned an empty audio file.');
      return { path: outputPath, engine: 'microsoft-neural', voice: params.voice };
    } catch {
      await fs.rm(outputPath, { force: true });
      // Public neural TTS is best-effort. Keep video delivery available when
      // the network is unavailable by falling back to the OS speech adapter.
    }
  }

  if (process.platform === 'darwin') {
    const outputPath = path.join(params.outputDir, 'narration.aiff');
    const voice = /Neural$/iu.test(params.voice) ? 'Tingting' : params.voice;
    await params.run('/usr/bin/say', ['-v', voice, '-o', outputPath, '-f', textPath]);
    return { path: outputPath, engine: 'system', voice };
  }

  if (process.platform === 'win32') {
    const outputPath = path.join(params.outputDir, 'narration.wav');
    const voice = /Neural$/iu.test(params.voice) ? '' : params.voice;
    const scriptPath = path.join(params.outputDir, 'synthesize-narration.ps1');
    await fs.writeFile(scriptPath, [
      'param([string]$TextPath, [string]$OutputPath, [string]$Voice)',
      'Add-Type -AssemblyName System.Speech',
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'if ($Voice) { try { $synth.SelectVoice($Voice) } catch { } }',
      '$synth.SetOutputToWaveFile($OutputPath)',
      '$synth.Speak([System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8))',
      '$synth.Dispose()',
    ].join('\r\n'), 'utf8');
    await params.run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-TextPath', textPath,
      '-OutputPath', outputPath,
      '-Voice', voice,
    ]);
    return { path: outputPath, engine: 'system', voice: voice || 'system-default' };
  }

  const espeak = await findPathExecutable(['espeak-ng', 'espeak']);
  if (!espeak) {
    throw new Error(`Narration was requested, but no Linux speech adapter is available on ${os.release()}. Install espeak-ng or omit narrationText.`);
  }
  const outputPath = path.join(params.outputDir, 'narration.wav');
  await params.run(espeak, ['-w', outputPath, '-f', textPath]);
  return { path: outputPath, engine: 'system', voice: 'espeak-default' };
}
