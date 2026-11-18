// The Vision requests the helper runs. Each takes an upright CGImage and returns plain values.
import CoreGraphics
import CoreVideo
import Foundation
import Vision

// MARK: - OCR (VNRecognizeTextRequest)

/// The supported code for a requested language ("tr" → "tr-TR", "en" → "en-US").
func resolveLanguage(_ requested: String, supported: [String]) -> String? {
    if supported.contains(requested) { return requested }
    let lower = requested.lowercased()
    if let exact = supported.first(where: { $0.lowercased() == lower }) { return exact }
    let prefix = lower.split(separator: "-").first.map(String.init) ?? lower
    return supported.first(where: { $0.lowercased().hasPrefix("\(prefix)-") || $0.lowercased() == prefix })
}

public func recognizeText(
    _ image: CGImage,
    languages: [String] = ["tr-TR", "en-US"],
    accurate: Bool = true,
    languageCorrection: Bool = true
) throws -> OcrResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = accurate ? .accurate : .fast
    request.usesLanguageCorrection = languageCorrection
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    var used: [String] = []
    var unsupported: [String] = []
    for language in languages {
        if let code = resolveLanguage(language, supported: supported) {
            if !used.contains(code) { used.append(code) }
        } else {
            unsupported.append(language)
        }
    }
    if !used.isEmpty { request.recognitionLanguages = used }
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = used.isEmpty }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError.vision(error)
    }
    var lines: [OcrLine] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        lines.append(
            OcrLine(
                text: text, confidence: Double(candidate.confidence),
                box: topLeftBox(observation.boundingBox)))
    }
    // Reading order: rows (centres closer than half a line apart share a row), then left to right.
    lines.sort { a, b in
        let ay = a.box.y + a.box.height / 2
        let by = b.box.y + b.box.height / 2
        let tolerance = min(a.box.height, b.box.height) / 2
        if abs(ay - by) > tolerance { return ay < by }
        return a.box.x < b.box.x
    }
    return OcrResult(
        languages: used, unsupportedLanguages: unsupported, lines: lines,
        text: lines.map(\.text).joined(separator: "\n"))
}

// MARK: - Classification (VNClassifyImageRequest)

public func classify(_ image: CGImage, minConfidence: Double = 0.08, maxLabels: Int = 12) throws
    -> ClassifyResult
{
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError.vision(error)
    }
    let labels = (request.results ?? [])
        .filter { Double($0.confidence) >= minConfidence }
        .sorted { $0.confidence > $1.confidence }
        .prefix(max(1, maxLabels))
        .map { ClassifyLabel(identifier: $0.identifier, confidence: Double($0.confidence)) }
    return ClassifyResult(labels: Array(labels))
}

// MARK: - Feature print (VNGenerateImageFeaturePrintRequest)

func featurePrintObservation(_ image: CGImage) throws -> VNFeaturePrintObservation {
    let request = VNGenerateImageFeaturePrintRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError.vision(error)
    }
    guard let observation = request.results?.first else {
        throw HelperError("vision_failed", "Benzerlik izi üretilemedi.")
    }
    return observation
}

/// The observation's elements as Float32 (Vision gives float or double).
func featureValues(_ observation: VNFeaturePrintObservation) -> [Float] {
    let count = observation.elementCount
    return observation.data.withUnsafeBytes { raw -> [Float] in
        switch observation.elementType {
        case .double:
            return (0..<count).map { Float(raw.load(fromByteOffset: $0 * 8, as: Double.self)) }
        default:
            return (0..<count).map { raw.load(fromByteOffset: $0 * 4, as: Float.self) }
        }
    }
}

public func featurePrint(_ image: CGImage) throws -> FeaturePrintResult {
    let observation = try featurePrintObservation(image)
    let values = featureValues(observation)
    var bytes = Data(capacity: values.count * 4)
    for value in values {
        var little = value.bitPattern.littleEndian
        withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
    }
    return FeaturePrintResult(
        revision: observation.requestRevision, count: values.count,
        data: bytes.base64EncodedString())
}

/// Vision's own distance between two pictures' feature prints.
public func featureDistance(_ a: CGImage, _ b: CGImage) throws -> Double {
    let first = try featurePrintObservation(a)
    let second = try featurePrintObservation(b)
    var distance: Float = 0
    do {
        try first.computeDistance(&distance, to: second)
    } catch {
        throw HelperError.vision(error)
    }
    return Double(distance)
}

/// Euclidean distance of two decoded feature prints (what the API computes in JS).
public func euclidean(_ a: [Float], _ b: [Float]) -> Double {
    guard a.count == b.count else { return .infinity }
    var sum: Double = 0
    for i in 0..<a.count {
        let d = Double(a[i]) - Double(b[i])
        sum += d * d
    }
    return sum.squareRoot()
}

/// Decode `FeaturePrintResult.data`.
public func decodeFeatureData(_ base64: String) -> [Float] {
    guard let data = Data(base64Encoded: base64) else { return [] }
    let count = data.count / 4
    return data.withUnsafeBytes { raw in
        (0..<count).map { Float(bitPattern: UInt32(littleEndian: raw.load(fromByteOffset: $0 * 4, as: UInt32.self))) }
    }
}

// MARK: - Foreground mask (VNGenerateForegroundInstanceMaskRequest, macOS 14+)

public var foregroundMaskAvailable: Bool {
    if #available(macOS 14.0, *) { return true }
    return false
}

private func withLockedBuffer<T>(_ buffer: CVPixelBuffer, _ body: (UnsafeRawPointer, Int, Int, Int) -> T) -> T {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = CVPixelBufferGetBaseAddress(buffer)!
    return body(
        UnsafeRawPointer(base), CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer),
        CVPixelBufferGetBytesPerRow(buffer))
}

public func foregroundMask(
    _ image: CGImage,
    instances mode: String = "all",
    crop: Bool = true,
    output: String? = nil
) throws -> MaskResult {
    guard #available(macOS 14.0, *) else {
        throw HelperError.unsupportedOS("Arka plan ayırma macOS 14 ya da üstünü ister.")
    }
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError.vision(error)
    }
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
        throw HelperError.noForeground("Fotoğrafta arka plandan ayrılabilen bir nesne bulunamadı.")
    }

    // Instance areas from the low-resolution label map (each pixel holds its instance number).
    let labelMap = observation.instanceMask
    var counts: [Int: Int] = [:]
    let total = withLockedBuffer(labelMap) { base, width, height, rowBytes -> Int in
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let label = Int(row[x])
                if label != 0 { counts[label, default: 0] += 1 }
            }
        }
        return width * height
    }
    let areas = observation.allInstances.sorted().map {
        InstanceArea(instance: $0, area: total > 0 ? Double(counts[$0] ?? 0) / Double(total) : 0)
    }
    var chosen = observation.allInstances
    if mode == "largest", let largest = areas.max(by: { $0.area < $1.area }) {
        chosen = IndexSet(integer: largest.instance)
    }

    // Exact extent and coverage from the full-resolution soft mask.
    let scaled: CVPixelBuffer
    do {
        scaled = try observation.generateScaledMaskForImage(forInstances: chosen, from: handler)
    } catch {
        throw HelperError.vision(error)
    }
    let extent = withLockedBuffer(scaled) {
        base, width, height, rowBytes -> (minX: Int, minY: Int, maxX: Int, maxY: Int, covered: Double, width: Int, height: Int) in
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        var covered: Double = 0
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float.self)
            for x in 0..<width {
                let value = row[x]
                covered += Double(value)
                if value >= 0.5 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        return (minX, minY, maxX, maxY, covered, width, height)
    }
    guard extent.maxX >= extent.minX, extent.maxY >= extent.minY else {
        throw HelperError.noForeground("Ayrılan nesne çok küçük ya da belirsiz.")
    }
    let maskW = Double(extent.width)
    let maskH = Double(extent.height)
    let box = Box(
        x: Double(extent.minX) / maskW, y: Double(extent.minY) / maskH,
        width: Double(extent.maxX - extent.minX + 1) / maskW,
        height: Double(extent.maxY - extent.minY + 1) / maskH)
    let imageW = Double(image.width)
    let imageH = Double(image.height)
    let pixelBox = Box(
        x: (box.x * imageW).rounded(), y: (box.y * imageH).rounded(),
        width: (box.width * imageW).rounded(), height: (box.height * imageH).rounded())

    let cutout: CVPixelBuffer
    do {
        cutout = try observation.generateMaskedImage(
            ofInstances: chosen, from: handler, croppedToInstancesExtent: crop)
    } catch {
        throw HelperError.vision(error)
    }
    let png = try pngData(of: cutout)
    var written: String? = nil
    var inline: String? = nil
    if let output, !output.isEmpty {
        do {
            try png.write(to: URL(fileURLWithPath: output), options: .atomic)
        } catch {
            throw HelperError("write_failed", "Kesilmiş görsel yazılamadı: \(output)")
        }
        written = output
    } else {
        inline = png.base64EncodedString()
    }
    return MaskResult(
        instances: areas, used: chosen.sorted(), box: box, pixelBox: pixelBox,
        coverage: extent.covered / max(1, maskW * maskH),
        width: CVPixelBufferGetWidth(cutout), height: CVPixelBufferGetHeight(cutout),
        output: written, png: inline)
}

// MARK: - Saliency (VNGenerateAttentionBasedSaliencyImageRequest)

public func saliency(_ image: CGImage, columns: Int = 12, rows: Int = 12) throws -> SaliencyResult {
    let request = VNGenerateAttentionBasedSaliencyImageRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw HelperError.vision(error)
    }
    guard let observation = request.results?.first else {
        throw HelperError("vision_failed", "Dikkat haritası üretilemedi.")
    }
    let cols = min(64, max(1, columns))
    let rowsCount = min(64, max(1, rows))
    var sums = [Double](repeating: 0, count: cols * rowsCount)
    var counts = [Int](repeating: 0, count: cols * rowsCount)
    withLockedBuffer(observation.pixelBuffer) { base, width, height, rowBytes in
        // The heat map's first row is the top of the picture.
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float.self)
            let gy = min(rowsCount - 1, y * rowsCount / max(1, height))
            for x in 0..<width {
                let gx = min(cols - 1, x * cols / max(1, width))
                sums[gy * cols + gx] += Double(row[x])
                counts[gy * cols + gx] += 1
            }
        }
    }
    var grid = zip(sums, counts).map { $1 > 0 ? $0 / Double($1) : 0 }
    let peak = grid.max() ?? 0
    if peak > 0 { grid = grid.map { $0 / peak } }
    let objects = (observation.salientObjects ?? []).map {
        SalientObject(box: topLeftBox($0.boundingBox), confidence: Double($0.confidence))
    }
    return SaliencyResult(objects: objects, columns: cols, rows: rowsCount, grid: grid)
}
