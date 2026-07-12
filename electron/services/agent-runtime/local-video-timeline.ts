import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { HostCapabilityTaskContext } from './host-capability-registry';

export type LocalVideoTimelineScene = {
  sourcePath: string;
  kind: 'image' | 'video';
  durationSeconds: number;
  motion: 'none' | 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'pan_up' | 'pan_down' | 'ken_burns';
  transition: 'cut' | 'crossfade' | 'fade';
  transitionDurationSeconds: number;
  caption?: string;
  captionPosition: 'top' | 'center' | 'bottom';
};

export type LocalVideoTimelineInput = {
  scenes: LocalVideoTimelineScene[];
  filename: string;
  targetDurationSeconds?: number;
  width: number;
  height: number;
  fps: number;
  narrationText?: string;
  voice: string;
  narrationVolume: number;
  backgroundMusicPath?: string;
  backgroundMusicVolume: number;
};

type TimelineMetadata = {
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  sceneCount?: number;
  imageSceneCount?: number;
  videoSceneCount?: number;
  captionCount?: number;
  transitionCount?: number;
};

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
const IMAGE_INPUT_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/iu;
const VIDEO_INPUT_EXT_RE = /\.(?:mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu;
const MOTIONS = new Set<LocalVideoTimelineScene['motion']>([
  'none',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'pan_up',
  'pan_down',
  'ken_burns',
]);
const TRANSITIONS = new Set<LocalVideoTimelineScene['transition']>(['cut', 'crossfade', 'fade']);
const CAPTION_POSITIONS = new Set<LocalVideoTimelineScene['captionPosition']>(['top', 'center', 'bottom']);

const SWIFT_TIMELINE_RENDERER = String.raw`
import Foundation
import AppKit
import AVFoundation
import CoreGraphics
import CoreVideo

struct SceneInput: Decodable {
  let sourcePath: String
  let kind: String
  let durationSeconds: Double
  let motion: String
  let transition: String
  let transitionDurationSeconds: Double
  let caption: String?
  let captionPosition: String
}

struct Input: Decodable {
  let scenes: [SceneInput]
  let visualOutput: String
  let output: String
  let narration: String?
  let narrationVolume: Double
  let backgroundMusic: String?
  let backgroundMusicVolume: Double
  let targetDurationSeconds: Double?
  let width: Int
  let height: Int
  let fps: Int
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func finiteDuration(_ value: Double, label: String) -> Double {
  guard value.isFinite && value > 0 else { fail("\(label) must be positive") }
  return value
}

func loadImage(_ filePath: String) -> CGImage {
  guard let image = NSImage(contentsOfFile: filePath) else { fail("cannot read image scene: \(filePath)") }
  var rect = NSRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fail("cannot decode image scene: \(filePath)")
  }
  return cgImage
}

final class SceneSource {
  let input: SceneInput
  let image: CGImage?
  let asset: AVURLAsset?
  let generator: AVAssetImageGenerator?
  let videoDuration: Double

  init(_ input: SceneInput, fps: Int) {
    self.input = input
    if input.kind == "image" {
      self.image = loadImage(input.sourcePath)
      self.asset = nil
      self.generator = nil
      self.videoDuration = 0
      return
    }

    let asset = AVURLAsset(url: URL(fileURLWithPath: input.sourcePath))
    guard !asset.tracks(withMediaType: .video).isEmpty else { fail("video scene has no video track: \(input.sourcePath)") }
    let duration = finiteDuration(asset.duration.seconds, label: "video scene duration")
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: CMTimeScale(fps))
    generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: CMTimeScale(fps))
    self.image = nil
    self.asset = asset
    self.generator = generator
    self.videoDuration = duration
  }

  func frame(at seconds: Double) -> CGImage {
    if let image { return image }
    guard let generator else { fail("video frame generator is unavailable") }
    let wrapped = max(0, seconds.truncatingRemainder(dividingBy: videoDuration))
    let safeTime = min(wrapped, max(0, videoDuration - 0.001))
    do {
      return try generator.copyCGImage(
        at: CMTime(seconds: safeTime, preferredTimescale: 600),
        actualTime: nil
      )
    } catch {
      fail("cannot decode video frame from \(input.sourcePath): \(error.localizedDescription)")
    }
  }
}

func interpolate(_ start: Double, _ end: Double, _ progress: Double) -> Double {
  start + (end - start) * max(0, min(1, progress))
}

func motionState(_ motion: String, _ progress: Double) -> (zoom: Double, focusX: Double, focusY: Double) {
  let value = max(0, min(1, progress))
  switch motion {
  case "zoom_in": return (interpolate(1.0, 1.12, value), 0.5, 0.5)
  case "zoom_out": return (interpolate(1.12, 1.0, value), 0.5, 0.5)
  case "pan_left": return (1.08, interpolate(0.85, 0.15, value), 0.5)
  case "pan_right": return (1.08, interpolate(0.15, 0.85, value), 0.5)
  case "pan_up": return (1.08, 0.5, interpolate(0.2, 0.8, value))
  case "pan_down": return (1.08, 0.5, interpolate(0.8, 0.2, value))
  case "ken_burns": return (
    interpolate(1.0, 1.14, value),
    interpolate(0.2, 0.8, value),
    interpolate(0.3, 0.7, value)
  )
  default: return (1.0, 0.5, 0.5)
  }
}

func drawSource(
  _ image: CGImage,
  in context: CGContext,
  width: Int,
  height: Int,
  motion: String,
  progress: Double,
  alpha: Double
) {
  let state = motionState(motion, progress)
  let sourceWidth = Double(image.width)
  let sourceHeight = Double(image.height)
  let baseScale = max(Double(width) / sourceWidth, Double(height) / sourceHeight)
  let scale = baseScale * state.zoom
  let drawWidth = sourceWidth * scale
  let drawHeight = sourceHeight * scale
  let overflowX = max(0, drawWidth - Double(width))
  let overflowY = max(0, drawHeight - Double(height))
  let drawRect = CGRect(
    x: -overflowX * state.focusX,
    y: -overflowY * state.focusY,
    width: drawWidth,
    height: drawHeight
  )
  context.saveGState()
  context.setAlpha(CGFloat(max(0, min(1, alpha))))
  context.interpolationQuality = .high
  context.draw(image, in: drawRect)
  context.restoreGState()
}

func drawCaption(_ text: String?, position: String, in context: CGContext, width: Int, height: Int) {
  guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
  let fontSize = max(24, min(64, CGFloat(height) * 0.046))
  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = .center
  paragraph.lineBreakMode = .byWordWrapping
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.8)
  shadow.shadowBlurRadius = 5
  shadow.shadowOffset = NSSize(width: 0, height: 2)
  let attributed = NSAttributedString(string: text, attributes: [
    .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
    .foregroundColor: NSColor.white,
    .paragraphStyle: paragraph,
    .shadow: shadow,
  ])
  let maximumWidth = CGFloat(width) * 0.82
  let measured = attributed.boundingRect(
    with: NSSize(width: maximumWidth, height: CGFloat(height) * 0.35),
    options: [.usesLineFragmentOrigin, .usesFontLeading]
  )
  let horizontalPadding = max(18, fontSize * 0.55)
  let verticalPadding = max(10, fontSize * 0.3)
  let boxWidth = min(maximumWidth + horizontalPadding * 2, measured.width + horizontalPadding * 2)
  let boxHeight = measured.height + verticalPadding * 2
  let boxX = (CGFloat(width) - boxWidth) / 2
  let boxY: CGFloat
  switch position {
  case "top": boxY = CGFloat(height) * 0.075
  case "center": boxY = (CGFloat(height) - boxHeight) / 2
  default: boxY = CGFloat(height) - boxHeight - CGFloat(height) * 0.075
  }
  let box = NSRect(x: boxX, y: boxY, width: boxWidth, height: boxHeight)
  NSColor.black.withAlphaComponent(0.48).setFill()
  NSBezierPath(roundedRect: box, xRadius: 12, yRadius: 12).fill()
  attributed.draw(
    with: NSRect(
      x: box.minX + horizontalPadding,
      y: box.minY + verticalPadding,
      width: box.width - horizontalPadding * 2,
      height: box.height - verticalPadding * 2
    ),
    options: [.usesLineFragmentOrigin, .usesFontLeading]
  )
  NSGraphicsContext.restoreGraphicsState()
}

func makeContext(for pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> CGContext {
  CVPixelBufferLockBaseAddress(pixelBuffer, [])
  guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { fail("pixel buffer has no base address") }
  guard let context = CGContext(
    data: baseAddress,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
  ) else { fail("cannot create frame drawing context") }
  return context
}

func finishWriter(_ writer: AVAssetWriter) {
  let semaphore = DispatchSemaphore(value: 0)
  writer.finishWriting { semaphore.signal() }
  semaphore.wait()
  guard writer.status == .completed else { fail(writer.error?.localizedDescription ?? "timeline video writer failed") }
}

func renderVisual(_ input: Input, sources: [SceneSource], duration: Double) {
  let outputURL = URL(fileURLWithPath: input.visualOutput)
  let writer: AVAssetWriter
  do { writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4) }
  catch { fail("cannot create timeline video writer: \(error.localizedDescription)") }
  let bitrate = min(45_000_000, max(4_000_000, input.width * input.height * input.fps / 6))
  let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: input.width,
    AVVideoHeightKey: input.height,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: bitrate,
      AVVideoExpectedSourceFrameRateKey: input.fps,
      AVVideoMaxKeyFrameIntervalKey: input.fps * 2,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    ],
  ])
  writerInput.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: writerInput, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: input.width,
    kCVPixelBufferHeightKey as String: input.height,
  ])
  guard writer.canAdd(writerInput) else { fail("cannot add timeline video writer input") }
  writer.add(writerInput)
  guard writer.startWriting() else { fail(writer.error?.localizedDescription ?? "cannot start timeline video writer") }
  writer.startSession(atSourceTime: .zero)
  guard let pool = adaptor.pixelBufferPool else { fail("timeline pixel buffer pool is unavailable") }

  var starts: [Double] = []
  var cursor = 0.0
  for scene in input.scenes {
    starts.append(cursor)
    cursor += scene.durationSeconds
  }
  let frameCount = max(1, Int(ceil(duration * Double(input.fps))))
  var sceneIndex = 0
  for frameIndex in 0..<frameCount {
    autoreleasepool {
      let time = min(duration, Double(frameIndex) / Double(input.fps))
      while sceneIndex < input.scenes.count - 1 && time >= starts[sceneIndex] + input.scenes[sceneIndex].durationSeconds {
        sceneIndex += 1
      }
      let scene = input.scenes[sceneIndex]
      let localTime = max(0, time - starts[sceneIndex])
      let progress = min(1, localTime / scene.durationSeconds)
      var pixelBuffer: CVPixelBuffer?
      guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess, let pixelBuffer else {
        fail("cannot allocate timeline pixel buffer")
      }
      let context = makeContext(for: pixelBuffer, width: input.width, height: input.height)
      context.setFillColor(NSColor.black.cgColor)
      context.fill(CGRect(x: 0, y: 0, width: input.width, height: input.height))

      let transitionDuration = min(
        scene.transitionDurationSeconds,
        scene.durationSeconds / 2,
        sceneIndex + 1 < input.scenes.count ? input.scenes[sceneIndex + 1].durationSeconds / 2 : 0
      )
      let transitionStart = scene.durationSeconds - transitionDuration
      let transitioning = transitionDuration > 0 && localTime >= transitionStart && sceneIndex + 1 < input.scenes.count
      if scene.transition == "crossfade" && transitioning {
        let transitionProgress = min(1, max(0, (localTime - transitionStart) / transitionDuration))
        drawSource(
          sources[sceneIndex].frame(at: localTime),
          in: context,
          width: input.width,
          height: input.height,
          motion: scene.motion,
          progress: progress,
          alpha: 1 - transitionProgress
        )
        let next = input.scenes[sceneIndex + 1]
        drawSource(
          sources[sceneIndex + 1].frame(at: transitionProgress * transitionDuration),
          in: context,
          width: input.width,
          height: input.height,
          motion: next.motion,
          progress: transitionProgress * transitionDuration / next.durationSeconds,
          alpha: transitionProgress
        )
      } else {
        let alpha = scene.transition == "fade" && transitioning
          ? 1 - min(1, max(0, (localTime - transitionStart) / transitionDuration))
          : 1
        drawSource(
          sources[sceneIndex].frame(at: localTime),
          in: context,
          width: input.width,
          height: input.height,
          motion: scene.motion,
          progress: progress,
          alpha: alpha
        )
      }
      drawCaption(scene.caption, position: scene.captionPosition, in: context, width: input.width, height: input.height)
      CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
      while !writerInput.isReadyForMoreMediaData {
        if writer.status == .failed { fail(writer.error?.localizedDescription ?? "timeline video writer failed") }
        Thread.sleep(forTimeInterval: 0.002)
      }
      let presentationTime = CMTime(value: CMTimeValue(frameIndex), timescale: CMTimeScale(input.fps))
      guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
        fail(writer.error?.localizedDescription ?? "cannot append timeline frame")
      }
    }
  }
  writerInput.markAsFinished()
  finishWriter(writer)
}

func insertLoopedAudio(
  from asset: AVURLAsset,
  sourceTrack: AVAssetTrack,
  into destinationTrack: AVMutableCompositionTrack,
  duration: CMTime
) {
  let sourceDuration = asset.duration
  guard sourceDuration.seconds.isFinite && sourceDuration.seconds > 0 else { fail("background music duration is invalid") }
  var cursor = CMTime.zero
  while CMTimeCompare(cursor, duration) < 0 {
    let remaining = CMTimeSubtract(duration, cursor)
    let chunk = CMTimeMinimum(sourceDuration, remaining)
    do {
      try destinationTrack.insertTimeRange(CMTimeRange(start: .zero, duration: chunk), of: sourceTrack, at: cursor)
    } catch {
      fail("cannot insert background music: \(error.localizedDescription)")
    }
    cursor = CMTimeAdd(cursor, chunk)
  }
}

func exportFinal(_ input: Input) {
  let visualAsset = AVURLAsset(url: URL(fileURLWithPath: input.visualOutput))
  guard let sourceVideo = visualAsset.tracks(withMediaType: .video).first else { fail("rendered timeline has no video track") }
  let composition = AVMutableComposition()
  guard let destinationVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
    fail("cannot create final video track")
  }
  do {
    try destinationVideo.insertTimeRange(CMTimeRange(start: .zero, duration: visualAsset.duration), of: sourceVideo, at: .zero)
  } catch {
    fail("cannot insert rendered timeline: \(error.localizedDescription)")
  }

  var audioParameters: [AVMutableAudioMixInputParameters] = []
  if let narration = input.narration {
    let asset = AVURLAsset(url: URL(fileURLWithPath: narration))
    if let source = asset.tracks(withMediaType: .audio).first,
       let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
      let duration = CMTimeMinimum(asset.duration, visualAsset.duration)
      do { try destination.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: .zero) }
      catch { fail("cannot insert narration: \(error.localizedDescription)") }
      let parameters = AVMutableAudioMixInputParameters(track: destination)
      parameters.setVolume(Float(input.narrationVolume), at: .zero)
      audioParameters.append(parameters)
    } else { fail("narration audio has no audio track") }
  }
  if let backgroundMusic = input.backgroundMusic {
    let asset = AVURLAsset(url: URL(fileURLWithPath: backgroundMusic))
    guard let source = asset.tracks(withMediaType: .audio).first,
          let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      fail("background music has no audio track")
    }
    insertLoopedAudio(from: asset, sourceTrack: source, into: destination, duration: visualAsset.duration)
    let parameters = AVMutableAudioMixInputParameters(track: destination)
    parameters.setVolume(Float(input.backgroundMusicVolume), at: .zero)
    audioParameters.append(parameters)
  }

  guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
    fail("cannot create final timeline export session")
  }
  exporter.outputURL = URL(fileURLWithPath: input.output)
  exporter.outputFileType = .mp4
  exporter.shouldOptimizeForNetworkUse = true
  if !audioParameters.isEmpty {
    let audioMix = AVMutableAudioMix()
    audioMix.inputParameters = audioParameters
    exporter.audioMix = audioMix
  }
  let semaphore = DispatchSemaphore(value: 0)
  exporter.exportAsynchronously { semaphore.signal() }
  semaphore.wait()
  guard exporter.status == .completed else { fail(exporter.error?.localizedDescription ?? "final timeline export failed") }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("manifest path is required") }
let input: Input
do {
  input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
} catch {
  fail("invalid timeline manifest: \(error.localizedDescription)")
}
let plannedDuration = input.scenes.reduce(0) { $0 + finiteDuration($1.durationSeconds, label: "scene duration") }
let duration = input.targetDurationSeconds ?? plannedDuration
if duration > plannedDuration + 0.001 { fail("scene timeline \(plannedDuration)s is below target \(duration)s") }
let sources = input.scenes.map { SceneSource($0, fps: input.fps) }
renderVisual(input, sources: sources, duration: duration)
exportFinal(input)

let outputAsset = AVURLAsset(url: URL(fileURLWithPath: input.output))
let outputVideo = outputAsset.tracks(withMediaType: .video).first
let transformedSize = outputVideo.map { $0.naturalSize.applying($0.preferredTransform) }
let metadata: [String: Any] = [
  "durationSeconds": outputAsset.duration.seconds,
  "width": Int(abs(transformedSize?.width ?? CGFloat(input.width))),
  "height": Int(abs(transformedSize?.height ?? CGFloat(input.height))),
  "hasAudio": !outputAsset.tracks(withMediaType: .audio).isEmpty,
  "hasVideo": outputVideo != nil,
  "sceneCount": input.scenes.count,
  "imageSceneCount": input.scenes.filter { $0.kind == "image" }.count,
  "videoSceneCount": input.scenes.filter { $0.kind == "video" }.count,
  "captionCount": input.scenes.filter { !($0.caption ?? "").isEmpty }.count,
  "transitionCount": input.scenes.filter { $0.transition != "cut" }.count,
]
do {
  let data = try JSONSerialization.data(withJSONObject: metadata)
  print(String(data: data, encoding: .utf8)!)
} catch {
  fail("cannot serialize timeline metadata: \(error.localizedDescription)")
}
`;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maximum) throw new Error(`${label} must contain 1 to ${maximum} characters`);
  return normalized || undefined;
}

function numberInRange(value: unknown, label: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || (normalized as number) < minimum || (normalized as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized as number;
}

function evenIntegerInRange(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  const normalized = integerInRange(value, label, minimum, maximum, fallback);
  if (normalized % 2 !== 0) throw new Error(`${label} must be an even integer for H.264 output`);
  return normalized;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, label: string, fallback: T): T {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== 'string' || !values.has(normalized as T)) throw new Error(`${label} is invalid`);
  return normalized as T;
}

function inferSceneKind(sourcePath: string): LocalVideoTimelineScene['kind'] | undefined {
  if (IMAGE_INPUT_EXT_RE.test(sourcePath)) return 'image';
  if (VIDEO_INPUT_EXT_RE.test(sourcePath)) return 'video';
  return undefined;
}

export function normalizeLocalVideoTimelineInput(value: unknown): LocalVideoTimelineInput {
  const input = record(value, 'local.video.timeline.render input');
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 120) {
    throw new Error('local.video.timeline.render input.scenes must contain 1 to 120 scenes');
  }
  const scenes = input.scenes.map((candidate, index): LocalVideoTimelineScene => {
    const scene = record(candidate, `local.video.timeline.render scenes[${index}]`);
    const sourcePath = text(scene.sourcePath, `local.video.timeline.render scenes[${index}].sourcePath`, 4_096, true) as string;
    const inferredKind = inferSceneKind(sourcePath);
    const kind = scene.kind === undefined
      ? inferredKind
      : enumValue(scene.kind, new Set<LocalVideoTimelineScene['kind']>(['image', 'video']), `local.video.timeline.render scenes[${index}].kind`, 'image');
    if (!kind) throw new Error(`local.video.timeline.render scenes[${index}].kind is required for this file extension`);
    const durationSeconds = numberInRange(
      scene.durationSeconds,
      `local.video.timeline.render scenes[${index}].durationSeconds`,
      0.25,
      600,
    );
    const transition = enumValue(
      scene.transition,
      TRANSITIONS,
      `local.video.timeline.render scenes[${index}].transition`,
      'cut',
    );
    const transitionDurationSeconds = numberInRange(
      scene.transitionDurationSeconds,
      `local.video.timeline.render scenes[${index}].transitionDurationSeconds`,
      0,
      5,
      transition === 'cut' ? 0 : 0.5,
    );
    return {
      sourcePath,
      kind,
      durationSeconds,
      motion: enumValue(scene.motion, MOTIONS, `local.video.timeline.render scenes[${index}].motion`, 'ken_burns'),
      transition,
      transitionDurationSeconds,
      caption: text(scene.caption, `local.video.timeline.render scenes[${index}].caption`, 500),
      captionPosition: enumValue(
        scene.captionPosition,
        CAPTION_POSITIONS,
        `local.video.timeline.render scenes[${index}].captionPosition`,
        'bottom',
      ),
    };
  });
  const plannedDurationSeconds = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  if (plannedDurationSeconds > 7_200) throw new Error('local.video.timeline.render scene duration total cannot exceed 7200 seconds');
  const targetDurationSeconds = input.targetDurationSeconds === undefined
    ? undefined
    : numberInRange(input.targetDurationSeconds, 'local.video.timeline.render targetDurationSeconds', 0.25, 7_200);
  if (targetDurationSeconds !== undefined && targetDurationSeconds > plannedDurationSeconds + 0.001) {
    throw new Error(`local.video.timeline.render scenes total ${plannedDurationSeconds}s is below target ${targetDurationSeconds}s`);
  }
  const filenameInput = text(input.filename, 'local.video.timeline.render filename', 180);
  const filename = (filenameInput ?? 'uclaw-timeline-video.mp4')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180);
  return {
    scenes,
    filename: filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`,
    targetDurationSeconds,
    width: evenIntegerInRange(input.width, 'local.video.timeline.render width', 320, 7_680, 1_920),
    height: evenIntegerInRange(input.height, 'local.video.timeline.render height', 240, 4_320, 1_080),
    fps: integerInRange(input.fps, 'local.video.timeline.render fps', 12, 60, 30),
    narrationText: text(input.narrationText, 'local.video.timeline.render narrationText', 16_000),
    voice: text(input.voice, 'local.video.timeline.render voice', 80) ?? 'Tingting',
    narrationVolume: numberInRange(input.narrationVolume, 'local.video.timeline.render narrationVolume', 0, 1, 1),
    backgroundMusicPath: text(input.backgroundMusicPath, 'local.video.timeline.render backgroundMusicPath', 4_096),
    backgroundMusicVolume: numberInRange(input.backgroundMusicVolume, 'local.video.timeline.render backgroundMusicVolume', 0, 1, 0.18),
  };
}

async function managedFilePath(filePath: string, label: string): Promise<string> {
  const managedRoot = await fs.realpath(getOpenClawConfigDir());
  const actual = await fs.realpath(filePath);
  const relative = path.relative(managedRoot, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} is outside the managed OpenClaw directory: ${filePath}`);
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`${label} is not a readable file: ${filePath}`);
  return actual;
}

async function managedTimelineInput(input: LocalVideoTimelineInput): Promise<LocalVideoTimelineInput> {
  const scenes = await Promise.all(input.scenes.map(async (scene, index) => ({
    ...scene,
    sourcePath: await managedFilePath(scene.sourcePath, `Timeline scene ${index + 1}`),
  })));
  const backgroundMusicPath = input.backgroundMusicPath
    ? await managedFilePath(input.backgroundMusicPath, 'Timeline background music')
    : undefined;
  return { ...input, scenes, backgroundMusicPath };
}

async function runProcess(taskId: string, executable: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'pipe' });
    activeProcesses.set(taskId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      activeProcesses.delete(taskId);
      reject(error);
    });
    child.once('close', (code, signal) => {
      activeProcesses.delete(taskId);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(signal ? `Timeline rendering stopped by ${signal}` : (stderr.trim() || `Timeline rendering exited with code ${code}`)));
    });
    child.stdin.end(stdin);
  });
}

export async function assessLocalVideoTimelineAvailability(): Promise<{ availability: 'available' | 'unavailable'; reason?: string }> {
  if (process.platform !== 'darwin') {
    return { availability: 'unavailable', reason: 'local.video.timeline.render currently requires the macOS AVFoundation runtime.' };
  }
  try {
    await Promise.all([fs.access('/usr/bin/swift'), fs.access('/usr/bin/say')]);
    return { availability: 'available' };
  } catch {
    return { availability: 'unavailable', reason: 'The macOS Swift or speech runtime is unavailable.' };
  }
}

export async function runLocalVideoTimelineRender(context: HostCapabilityTaskContext): Promise<void> {
  const normalizedInput = normalizeLocalVideoTimelineInput(context.input);
  const input = await managedTimelineInput(normalizedInput);
  const outputDir = path.join(getOpenClawConfigDir(), 'media', 'outbound', 'timeline-video', context.task.taskId);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(outputDir, input.filename);
  const temporaryPath = path.join(outputDir, `.${input.filename}.${process.pid}.tmp.mp4`);
  const visualPath = path.join(outputDir, `.${input.filename}.${process.pid}.visual.mp4`);
  const narrationPath = input.narrationText ? path.join(outputDir, 'narration.aiff') : undefined;
  const expectedDurationSeconds = input.targetDurationSeconds
    ?? input.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  await context.update({
    status: 'running',
    checkpoint: { phase: 'validated', finalPath, expectedDurationSeconds, sceneCount: input.scenes.length },
    progress: { completed: 1, total: 4, detail: `已验证 ${input.scenes.length} 个时间线场景，准备本地渲染。` },
  });

  await Promise.all([
    fs.rm(temporaryPath, { force: true }),
    fs.rm(visualPath, { force: true }),
  ]);
  if (input.narrationText && narrationPath) {
    await fs.rm(narrationPath, { force: true });
    await runProcess(context.task.taskId, '/usr/bin/say', ['-v', input.voice, '-o', narrationPath, input.narrationText]);
    await context.update({
      checkpoint: { phase: 'narration_ready', finalPath, narrationPath, expectedDurationSeconds },
      progress: { completed: 2, total: 4, detail: '中文旁白音轨已生成，正在渲染视频时间线。' },
    });
  } else {
    await context.update({
      checkpoint: { phase: 'rendering', finalPath, expectedDurationSeconds },
      progress: { completed: 2, total: 4, detail: '正在渲染视频时间线。' },
    });
  }

  const manifestPath = path.join(outputDir, 'timeline-input.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    scenes: input.scenes,
    visualOutput: visualPath,
    output: temporaryPath,
    narration: narrationPath,
    narrationVolume: input.narrationVolume,
    backgroundMusic: input.backgroundMusicPath,
    backgroundMusicVolume: input.backgroundMusicVolume,
    targetDurationSeconds: input.targetDurationSeconds,
    width: input.width,
    height: input.height,
    fps: input.fps,
  }), { mode: 0o600 });
  const result = await runProcess(context.task.taskId, '/usr/bin/swift', ['-', manifestPath], SWIFT_TIMELINE_RENDERER);
  let metadata: TimelineMetadata;
  try {
    metadata = JSON.parse(result.stdout.trim()) as TimelineMetadata;
  } catch {
    throw new Error(`Timeline renderer returned invalid metadata: ${result.stdout.trim().slice(0, 500)}`);
  }
  await fs.rm(finalPath, { force: true });
  await fs.rename(temporaryPath, finalPath);
  await fs.rm(visualPath, { force: true });
  const stat = await fs.stat(finalPath);
  const durationTolerance = Math.max(0.2, 1 / input.fps + 0.1);
  const durationSatisfied = typeof metadata.durationSeconds === 'number'
    && Math.abs(metadata.durationSeconds - expectedDurationSeconds) <= durationTolerance;
  const dimensionsSatisfied = metadata.width === input.width && metadata.height === input.height;
  const audioRequired = Boolean(input.narrationText || input.backgroundMusicPath);
  const audioSatisfied = !audioRequired || metadata.hasAudio === true;
  if (!metadata.hasVideo || !durationSatisfied || !dimensionsSatisfied || !audioSatisfied || stat.size <= 0) {
    await context.update({
      status: 'blocked',
      checkpoint: { phase: 'verification_failed', finalPath, metadata, expectedDurationSeconds },
      error: 'Rendered timeline did not satisfy its duration, dimensions, video-track, or requested audio-track acceptance requirements.',
      progress: { completed: 3, total: 4, detail: '时间线视频已产出，但媒体验收未通过。' },
    });
    return;
  }

  const artifactId = `artifact:host-task:${context.task.taskId}:video`;
  await context.update({
    status: 'succeeded',
    checkpoint: { phase: 'completed', finalPath, metadata, expectedDurationSeconds },
    progress: {
      completed: 4,
      total: 4,
      detail: `时间线成片已验证：${metadata.durationSeconds.toFixed(1)}s，${metadata.width}x${metadata.height}，${metadata.hasAudio ? '有音轨' : '无音轨'}。`,
    },
    artifacts: [{
      id: artifactId,
      kind: 'video',
      title: input.filename,
      filePath: finalPath,
      mimeType: 'video/mp4',
      sizeBytes: stat.size,
      stepId: `host-task:${context.task.taskId}`,
      sourceToolCallId: context.task.toolCallId,
      source: 'local.video.timeline.render',
    }],
    verifications: [{
      id: `verification:${artifactId}:media.metadata`,
      status: 'passed',
      kind: 'media.metadata',
      required: true,
      title: '验证时间线视频时长、尺寸和音轨',
      detail: JSON.stringify(metadata),
      artifactId,
      targetId: artifactId,
      evidence: JSON.stringify({ ...metadata, expectedDurationSeconds }),
      source: 'local.video.timeline.render',
    }],
  });
}

export async function cancelLocalVideoTimelineRender(context: HostCapabilityTaskContext & { reason: string }): Promise<void> {
  activeProcesses.get(context.task.taskId)?.kill('SIGTERM');
  await context.update({
    status: 'cancelled',
    checkpoint: { phase: 'cancelled' },
    error: context.reason,
    progress: { detail: '视频时间线渲染已取消。' },
  });
}
