import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import AudioToolbox

struct CaptureError: Error, CustomStringConvertible {
    let description: String
}

final class AudioCollector: NSObject, SCStreamOutput, SCStreamDelegate {
    private(set) var pcm = Data()
    private let done = DispatchSemaphore(value: 0)
    private var stopped = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferIsValid(sampleBuffer),
              let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return }
        let bytes = UnsafeRawBufferPointer(start: pointer, count: length)
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let bits = Int(asbd.mBitsPerChannel)
        if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 && bits == 32 {
            let samples = bytes.bindMemory(to: Float32.self)
            for frame in stride(from: 0, to: samples.count, by: channels) {
                var sum: Float32 = 0
                for channel in 0..<channels where frame + channel < samples.count { sum += samples[frame + channel] }
                let value = max(-1.0, min(1.0, sum / Float32(channels)))
                var pcm16 = Int16(value * 32767.0)
                withUnsafeBytes(of: &pcm16) { pcm.append(contentsOf: $0) }
            }
        } else if bits == 16 {
            let samples = bytes.bindMemory(to: Int16.self)
            for frame in stride(from: 0, to: samples.count, by: channels) {
                var sum: Int32 = 0
                for channel in 0..<channels where frame + channel < samples.count { sum += Int32(samples[frame + channel]) }
                var pcm16 = Int16(max(-32768, min(32767, sum / Int32(channels))))
                withUnsafeBytes(of: &pcm16) { pcm.append(contentsOf: $0) }
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish()
    }

    func finish() {
        guard !stopped else { return }
        stopped = true
        done.signal()
    }

    func wait() { done.wait() }
}

func writeWav(_ pcm: Data, to path: String) throws {
    let sampleRate: UInt32 = 16_000
    let channels: UInt16 = 1
    let bits: UInt16 = 16
    let byteRate = sampleRate * UInt32(channels) * UInt32(bits / 8)
    let blockAlign = channels * (bits / 8)
    var data = Data("RIFF".utf8)
    var riffSize = UInt32(36 + pcm.count).littleEndian
    let wave = Data("WAVEfmt ".utf8)
    var fmtSize = UInt32(16).littleEndian
    var audioFormat = UInt16(1).littleEndian
    var channelsLE = channels.littleEndian
    var rateLE = sampleRate.littleEndian
    var byteRateLE = byteRate.littleEndian
    var alignLE = blockAlign.littleEndian
    var bitsLE = bits.littleEndian
    withUnsafeBytes(of: &riffSize) { data.append(contentsOf: $0) }
    data.append(wave)
    withUnsafeBytes(of: &fmtSize) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &audioFormat) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &channelsLE) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &rateLE) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &byteRateLE) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &alignLE) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &bitsLE) { data.append(contentsOf: $0) }
    data.append(Data("data".utf8))
    var pcmSize = UInt32(pcm.count).littleEndian
    withUnsafeBytes(of: &pcmSize) { data.append(contentsOf: $0) }
    data.append(pcm)
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

let windowID = UInt32(argument("--window-id") ?? "0") ?? 0
let durationMs = UInt64(argument("--duration-ms") ?? "10000") ?? 10000
let output = argument("--output") ?? ""
guard windowID > 0, !output.isEmpty else { throw CaptureError(description: "invalid arguments") }

// ScreenCaptureKit resolves window/display metadata through WindowServer. A
// command-line Swift process must initialize AppKit before touching that API.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

let semaphore = DispatchSemaphore(value: 0)
var selected: SCWindow?
var contentError: Error?
SCShareableContent.getWithCompletionHandler { content, error in
    contentError = error
    selected = content?.windows.first(where: { $0.windowID == windowID })
    semaphore.signal()
}
semaphore.wait()
if let contentError { throw contentError }
guard let window = selected else { throw CaptureError(description: "window unavailable") }

let filter = SCContentFilter(desktopIndependentWindow: window)
let configuration = SCStreamConfiguration()
configuration.capturesAudio = true
configuration.excludesCurrentProcessAudio = true
configuration.width = 2
configuration.height = 2
configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
configuration.sampleRate = 16_000
configuration.channelCount = 1

let collector = AudioCollector()
let stream = SCStream(filter: filter, configuration: configuration, delegate: collector)
try stream.addStreamOutput(collector, type: .audio, sampleHandlerQueue: DispatchQueue(label: "kxyy.capture-audio"))
stream.startCapture()
DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(durationMs))) {
    stream.stopCapture()
    collector.finish()
}
collector.wait()
try writeWav(collector.pcm, to: output)
