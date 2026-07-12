import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { HostCapabilityTaskContext } from './host-capability-registry';

type ComposeInput = {
  segments: string[];
  filename: string;
  targetDurationSeconds?: number;
  width?: number;
  height?: number;
  narrationText?: string;
  voice: string;
  keepOriginalAudio: boolean;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

const SWIFT_COMPOSER = String.raw`
import Foundation
import AVFoundation

struct Input: Decodable {
  let segments: [String]
  let output: String
  let narration: String?
  let keepOriginalAudio: Bool
  let targetDurationSeconds: Double?
  let width: Int?
  let height: Int?
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("manifest path is required") }
let manifestURL = URL(fileURLWithPath: args[1])
let input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: manifestURL))
let composition = AVMutableComposition()
guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("cannot create video track") }
let sourceAudioTrack = input.keepOriginalAudio ? composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) : nil
var cursor = CMTime.zero
var instructions: [AVMutableVideoCompositionInstruction] = []
var renderSize = CGSize.zero

for segmentPath in input.segments {
  let asset = AVURLAsset(url: URL(fileURLWithPath: segmentPath))
  guard let sourceVideo = asset.tracks(withMediaType: .video).first else { fail("segment has no video track: \(segmentPath)") }
  let duration = asset.duration
  if duration.seconds <= 0 { fail("segment duration is invalid: \(segmentPath)") }
  try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: cursor)
  if let destinationAudio = sourceAudioTrack, let audio = asset.tracks(withMediaType: .audio).first {
    try destinationAudio.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: audio, at: cursor)
  }
  let transformed = sourceVideo.naturalSize.applying(sourceVideo.preferredTransform)
  let sourceSize = CGSize(width: abs(transformed.width), height: abs(transformed.height))
  if renderSize == .zero {
    renderSize = CGSize(width: input.width ?? Int(sourceSize.width), height: input.height ?? Int(sourceSize.height))
  }
  let instruction = AVMutableVideoCompositionInstruction()
  instruction.timeRange = CMTimeRange(start: cursor, duration: duration)
  let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
  let scale = max(renderSize.width / sourceSize.width, renderSize.height / sourceSize.height)
  let scaledWidth = sourceSize.width * scale
  let scaledHeight = sourceSize.height * scale
  var transform = sourceVideo.preferredTransform.concatenating(CGAffineTransform(scaleX: scale, y: scale))
  transform = transform.concatenating(CGAffineTransform(translationX: (renderSize.width - scaledWidth) / 2, y: (renderSize.height - scaledHeight) / 2))
  layer.setTransform(transform, at: cursor)
  instruction.layerInstructions = [layer]
  instructions.append(instruction)
  cursor = CMTimeAdd(cursor, duration)
}

if let narrationPath = input.narration {
  let narrationAsset = AVURLAsset(url: URL(fileURLWithPath: narrationPath))
  if let sourceNarration = narrationAsset.tracks(withMediaType: .audio).first,
     let narrationTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
    let duration = CMTimeMinimum(narrationAsset.duration, cursor)
    try narrationTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceNarration, at: .zero)
  }
}

if let target = input.targetDurationSeconds, cursor.seconds + 0.05 < target {
  fail("segments total \(String(format: "%.3f", cursor.seconds))s, below target \(target)s")
}
let exportDuration = input.targetDurationSeconds.map { CMTimeMinimum(cursor, CMTime(seconds: $0, preferredTimescale: 600)) } ?? cursor
let videoComposition = AVMutableVideoComposition()
videoComposition.instructions = instructions
videoComposition.renderSize = renderSize
videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { fail("cannot create export session") }
exporter.outputURL = URL(fileURLWithPath: input.output)
exporter.outputFileType = .mp4
exporter.timeRange = CMTimeRange(start: .zero, duration: exportDuration)
exporter.shouldOptimizeForNetworkUse = true
exporter.videoComposition = videoComposition
let semaphore = DispatchSemaphore(value: 0)
exporter.exportAsynchronously { semaphore.signal() }
semaphore.wait()
guard exporter.status == .completed else { fail(exporter.error?.localizedDescription ?? "video export failed") }
let outputAsset = AVURLAsset(url: URL(fileURLWithPath: input.output))
let metadata: [String: Any] = [
  "durationSeconds": outputAsset.duration.seconds,
  "width": Int(renderSize.width),
  "height": Int(renderSize.height),
  "hasAudio": !outputAsset.tracks(withMediaType: .audio).isEmpty,
  "hasVideo": !outputAsset.tracks(withMediaType: .video).isEmpty
]
let data = try JSONSerialization.data(withJSONObject: metadata)
print(String(data: data, encoding: .utf8)!)
`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local.video.compose input must be an object');
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value as number;
}

function normalizeInput(value: unknown): ComposeInput {
  const input = record(value);
  if (!Array.isArray(input.segments) || input.segments.length < 2 || input.segments.length > 120) {
    throw new Error('local.video.compose input.segments must contain 2 to 120 files');
  }
  const segments = input.segments.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('local.video.compose segment paths must be strings');
    return entry.trim();
  });
  const filename = typeof input.filename === 'string' && input.filename.trim()
    ? input.filename.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 180)
    : 'uclaw-composed-video.mp4';
  const targetDurationSeconds = typeof input.targetDurationSeconds === 'number' && Number.isFinite(input.targetDurationSeconds)
    ? input.targetDurationSeconds
    : undefined;
  if (targetDurationSeconds !== undefined && (targetDurationSeconds <= 0 || targetDurationSeconds > 7_200)) {
    throw new Error('local.video.compose targetDurationSeconds must be from 0 to 7200');
  }
  const narrationText = typeof input.narrationText === 'string' && input.narrationText.trim()
    ? input.narrationText.trim().slice(0, 16_000)
    : undefined;
  return {
    segments,
    filename: filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`,
    targetDurationSeconds,
    width: positiveInteger(input.width, 'local.video.compose width', 7_680),
    height: positiveInteger(input.height, 'local.video.compose height', 4_320),
    narrationText,
    voice: typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim().slice(0, 80) : 'Tingting',
    keepOriginalAudio: input.keepOriginalAudio === true,
  };
}

async function managedSegmentPaths(segments: string[]): Promise<string[]> {
  const managedRoot = await fs.realpath(getOpenClawConfigDir());
  const resolved: string[] = [];
  for (const segment of segments) {
    const actual = await fs.realpath(segment);
    const relative = path.relative(managedRoot, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Video segment is outside the managed OpenClaw directory: ${segment}`);
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Video segment is not a readable file: ${segment}`);
    resolved.push(actual);
  }
  return resolved;
}

async function runProcess(taskId: string, executable: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'pipe' });
    activeProcesses.set(taskId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      activeProcesses.delete(taskId);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(signal ? `Video composition stopped by ${signal}` : (stderr.trim() || `Video composition exited with code ${code}`)));
    });
    child.stdin.end(stdin);
  });
}

export async function runLocalVideoCompose(context: HostCapabilityTaskContext): Promise<void> {
  const input = normalizeInput(context.input);
  const segments = await managedSegmentPaths(input.segments);
  const outputDir = path.join(getOpenClawConfigDir(), 'media', 'outbound', 'composed-video', context.task.taskId);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(outputDir, input.filename);
  const temporaryPath = path.join(outputDir, `.${input.filename}.${process.pid}.tmp.mp4`);
  const narrationPath = input.narrationText ? path.join(outputDir, 'narration.aiff') : undefined;
  await context.update({
    status: 'running',
    checkpoint: { phase: 'validated', segments, finalPath },
    progress: { completed: 1, total: 4, detail: `已验证 ${segments.length} 个视频片段，准备本地合成。` },
  });
  if (input.narrationText && narrationPath) {
    await runProcess(context.task.taskId, '/usr/bin/say', ['-v', input.voice, '-o', narrationPath, input.narrationText]);
    await context.update({
      checkpoint: { phase: 'narration_ready', segments, finalPath, narrationPath },
      progress: { completed: 2, total: 4, detail: '中文旁白音轨已生成，正在拼接画面和音频。' },
    });
  }
  const manifestPath = path.join(outputDir, 'compose-input.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    segments,
    output: temporaryPath,
    narration: narrationPath,
    keepOriginalAudio: input.keepOriginalAudio,
    targetDurationSeconds: input.targetDurationSeconds,
    width: input.width,
    height: input.height,
  }), { mode: 0o600 });
  await fs.rm(temporaryPath, { force: true });
  const result = await runProcess(context.task.taskId, '/usr/bin/swift', ['-', manifestPath], SWIFT_COMPOSER);
  const metadata = JSON.parse(result.stdout.trim()) as { durationSeconds?: number; width?: number; height?: number; hasAudio?: boolean; hasVideo?: boolean };
  await fs.rename(temporaryPath, finalPath);
  const stat = await fs.stat(finalPath);
  const durationSatisfied = input.targetDurationSeconds === undefined
    || (typeof metadata.durationSeconds === 'number' && metadata.durationSeconds + 0.15 >= input.targetDurationSeconds);
  const audioSatisfied = !input.narrationText || metadata.hasAudio === true;
  if (!metadata.hasVideo || !durationSatisfied || !audioSatisfied || stat.size <= 0) {
    await context.update({
      status: 'blocked',
      checkpoint: { phase: 'verification_failed', finalPath, metadata },
      error: 'Composed video did not satisfy its duration, video-track, or narration-track acceptance requirements.',
      progress: { completed: 3, total: 4, detail: '本地合成已产出文件，但媒体验收未通过。' },
    });
    return;
  }
  const artifactId = `artifact:host-task:${context.task.taskId}:video`;
  await context.update({
    status: 'succeeded',
    checkpoint: { phase: 'completed', finalPath, metadata },
    progress: { completed: 4, total: 4, detail: `成片已验证：${metadata.durationSeconds?.toFixed(1) ?? '?'}s，${metadata.width}x${metadata.height}，${metadata.hasAudio ? '有音轨' : '无音轨'}。` },
    artifacts: [{
      id: artifactId,
      kind: 'video',
      title: input.filename,
      filePath: finalPath,
      mimeType: 'video/mp4',
      sizeBytes: stat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.compose',
    }],
    verifications: [{
      id: `verification:${artifactId}:media.metadata`,
      status: 'passed',
      kind: 'media.metadata',
      required: true,
      title: '验证最终视频时长、尺寸和音轨',
      detail: JSON.stringify(metadata),
      artifactId,
      targetId: artifactId,
      evidence: JSON.stringify(metadata),
      source: 'local.video.compose',
    }],
  });
}

export async function cancelLocalVideoCompose(context: HostCapabilityTaskContext & { reason: string }): Promise<void> {
  activeProcesses.get(context.task.taskId)?.kill('SIGTERM');
  await context.update({
    status: 'cancelled',
    checkpoint: { phase: 'cancelled' },
    error: context.reason,
    progress: { detail: '视频合成已取消。' },
  });
}
