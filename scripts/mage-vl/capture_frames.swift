import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreImage

struct CaptureError: Error, CustomStringConvertible {
    let description: String
}

struct FrameEvent: Encodable {
    let capturedAtMs: Int64
    let imageBase64: String
    let changeScore: Double
    let width: Int
    let height: Int
}

func meanAbsoluteDifference(_ left: [UInt8], _ right: [UInt8]) -> Double {
    guard left.count == right.count, !left.isEmpty else { return 0 }
    let total = zip(left, right).reduce(0) { partial, pair in
        partial + abs(Int(pair.0) - Int(pair.1))
    }
    return min(1, max(0, Double(total) / Double(left.count * 255)))
}

final class FrameCollector: NSObject, SCStreamOutput, SCStreamDelegate {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let encoder = JSONEncoder()
    private let outputQueue = DispatchQueue(label: "kxyy.capture-frames.output")
    private let done = DispatchSemaphore(value: 0)
    private var previousLuma: [UInt8]?
    private var stopped = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer),
              let pixelBuffer = sampleBuffer.imageBuffer else { return }
        autoreleasepool {
            guard let jpeg = makeJpeg(pixelBuffer, maxSide: 640),
                  let luma = makeLuma(pixelBuffer, width: 32, height: 18) else { return }
            let score = previousLuma.map { meanAbsoluteDifference($0, luma) } ?? 0
            previousLuma = luma
            let event = FrameEvent(
                capturedAtMs: Int64(Date().timeIntervalSince1970 * 1000),
                imageBase64: jpeg.data.base64EncodedString(),
                changeScore: score,
                width: jpeg.width,
                height: jpeg.height
            )
            outputQueue.async { [encoder] in
                guard let json = try? encoder.encode(event) else { return }
                FileHandle.standardOutput.write(json)
                FileHandle.standardOutput.write(Data([0x0A]))
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

    private func scaledImage(_ pixelBuffer: CVPixelBuffer, maxSide: CGFloat) -> CGImage? {
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        let longest = max(source.extent.width, source.extent.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxSide / longest)
        let transformed = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return context.createCGImage(transformed, from: transformed.extent)
    }

    private func makeJpeg(_ pixelBuffer: CVPixelBuffer, maxSide: CGFloat) -> (data: Data, width: Int, height: Int)? {
        guard let image = scaledImage(pixelBuffer, maxSide: maxSide) else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { return nil }
        return (data, image.width, image.height)
    }

    private func makeLuma(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> [UInt8]? {
        guard let image = scaledImage(pixelBuffer, maxSide: CGFloat(max(width, height))) else { return nil }
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pixels
    }
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

if CommandLine.arguments.contains("--self-test") {
    let score = meanAbsoluteDifference([0, 0, 255, 255], [0, 255, 255, 0])
    print(String(format: "%.6f", score))
    exit(score == 0.5 ? 0 : 1)
}

let windowID = UInt32(argument("--window-id") ?? "0") ?? 0
let intervalMs = UInt64(argument("--interval-ms") ?? "500") ?? 500
guard windowID > 0, (250...2000).contains(intervalMs) else {
    throw CaptureError(description: "invalid arguments")
}

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

let frame = window.frame
let scale = min(1, 960 / max(frame.width, frame.height))
let configuration = SCStreamConfiguration()
configuration.capturesAudio = false
configuration.showsCursor = false
configuration.width = max(2, Int(frame.width * scale))
configuration.height = max(2, Int(frame.height * scale))
configuration.minimumFrameInterval = CMTime(value: Int64(intervalMs), timescale: 1000)
configuration.queueDepth = 3

let collector = FrameCollector()
let filter = SCContentFilter(desktopIndependentWindow: window)
let stream = SCStream(filter: filter, configuration: configuration, delegate: collector)
try stream.addStreamOutput(collector, type: .screen, sampleHandlerQueue: DispatchQueue(label: "kxyy.capture-frames"))
stream.startCapture()
collector.wait()
