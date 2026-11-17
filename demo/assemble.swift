// Turns the captured frames and the soundtrack into an MP4 (H.264 + AAC), using only macOS's own
// AVFoundation. Usage: swift demo/assemble.swift <build dir> <output.mp4>
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

struct Frame: Decodable { let file: String; let t: Double }
struct Capture: Decodable { let frames: [Frame]; let end: Double }

let args = CommandLine.arguments
let build = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let width = 1920, height = 1080, fps: Int32 = 30

let capture = try JSONDecoder().decode(Capture.self, from: Data(contentsOf: build.appendingPathComponent("frames.json")))
let start = capture.frames[0].t
let duration = capture.end - start

// ── 1. Video only: every output frame shows the latest captured picture at that moment ──
let silent = build.appendingPathComponent("video-only.mp4")
try? FileManager.default.removeItem(at: silent)
let writer = try AVAssetWriter(outputURL: silent, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 8_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: 60,
    ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func loadImage(_ name: String) -> CGImage {
    let url = build.appendingPathComponent("frames").appendingPathComponent(name)
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}

func pixelBuffer(_ image: CGImage) -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
    let pb = buffer!
    CVPixelBufferLockBaseAddress(pb, [])
    let ctx = CGContext(
        data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pb, [])
    return pb
}

let total = Int(duration * Double(fps))
var index = 0
var currentName = ""
var current: CVPixelBuffer? = nil
for n in 0..<total {
    let t = start + Double(n) / Double(fps)
    while index + 1 < capture.frames.count && capture.frames[index + 1].t <= t { index += 1 }
    let name = capture.frames[index].file
    if name != currentName {
        current = pixelBuffer(loadImage(name))
        currentName = name
    }
    while !input.isReadyForMoreMediaData { usleep(2000) }
    adaptor.append(current!, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: fps))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fatalError("Video failed: \(String(describing: writer.error))") }
print("video: \(total) frames")

// ── 2. Add the soundtrack and export the final MP4 ──
let composition = AVMutableComposition()
let videoAsset = AVURLAsset(url: silent)
let audioAsset = AVURLAsset(url: build.appendingPathComponent("soundtrack.wav"))
let videoTrack = try await videoAsset.loadTracks(withMediaType: .video)[0]
let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio)[0]
let videoLength = try await videoAsset.load(.duration)
let audioLength = try await audioAsset.load(.duration)
let length = CMTimeMinimum(videoLength, audioLength)
let v = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try v.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: videoTrack, at: .zero)
let a = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
try a.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: audioTrack, at: .zero)

try? FileManager.default.removeItem(at: output)
let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality)!
try await export.export(to: output, as: .mp4)
print("wrote \(output.path) (\(String(format: "%.1f", CMTimeGetSeconds(length)))s)")
