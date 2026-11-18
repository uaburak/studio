// One request in, one response out.
import CoreGraphics
import Foundation
import Vision

public let defaultAnalyzeOps = ["classify", "ocr", "feature-print"]

func versionResult() -> VersionResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let info = ProcessInfo.processInfo.operatingSystemVersion
    return VersionResult(
        helperVersion: helperVersion,
        os: "macOS \(info.majorVersion).\(info.minorVersion).\(info.patchVersion)",
        ocrLanguages: (try? request.supportedRecognitionLanguages()) ?? [],
        foregroundMask: foregroundMaskAvailable,
        featurePrintRevision: VNGenerateImageFeaturePrintRequest.defaultRevision)
}

func ocrOptions(_ request: HelperRequest, _ image: CGImage) throws -> OcrResult {
    try recognizeText(
        image,
        languages: request.languages ?? ["tr-TR", "en-US"],
        accurate: (request.level ?? "accurate") != "fast",
        languageCorrection: request.languageCorrection ?? true)
}

func partError(_ error: Error) -> PartError {
    let own = HelperError.vision(error)
    return PartError(code: own.code, message: own.message)
}

/// Run one request. Never throws: failures come back as `ok: false` with a code.
public func handle(_ request: HelperRequest) -> HelperResponse {
    let started = Date()
    var response = HelperResponse(ok: false, command: request.command, timingMs: 0)
    do {
        if request.command == "version" {
            response.result = .version(versionResult())
            response.ok = true
            response.timingMs = Int(Date().timeIntervalSince(started) * 1000)
            return response
        }
        let image = try loadRequestImage(request)
        response.image = ImageSize(width: image.width, height: image.height)
        switch request.command {
        case "ocr":
            response.result = .ocr(try ocrOptions(request, image))
        case "classify":
            response.result = .classify(
                try classify(
                    image, minConfidence: request.minConfidence ?? 0.08,
                    maxLabels: request.maxLabels ?? 12))
        case "feature-print":
            response.result = .featurePrint(try featurePrint(image))
        case "foreground-mask":
            response.result = .mask(
                try foregroundMask(
                    image, instances: request.instances ?? "all", crop: request.crop ?? true,
                    output: request.output))
        case "saliency":
            response.result = .saliency(
                try saliency(
                    image, columns: request.gridColumns ?? 12, rows: request.gridRows ?? 12))
        case "feature-distance":
            guard let other = request.otherPath else {
                throw HelperError.badRequest("feature-distance otherPath ister.")
            }
            let second = try loadRequestImage(HelperRequest(command: "load", path: other))
            response.result = .distance(DistanceResult(distance: try featureDistance(image, second)))
        case "analyze":
            let ops = request.ops ?? defaultAnalyzeOps
            var result = AnalyzeResult(errors: [:])
            for op in ops {
                do {
                    switch op {
                    case "classify":
                        result.classify = try classify(
                            image, minConfidence: request.minConfidence ?? 0.08,
                            maxLabels: request.maxLabels ?? 12)
                    case "ocr":
                        result.ocr = try ocrOptions(request, image)
                    case "feature-print":
                        result.featurePrint = try featurePrint(image)
                    case "saliency":
                        result.saliency = try saliency(
                            image, columns: request.gridColumns ?? 12, rows: request.gridRows ?? 12)
                    default:
                        result.errors[op] = PartError(code: "bad_request", message: "Bilinmeyen işlem: \(op)")
                    }
                } catch {
                    result.errors[op] = partError(error)
                }
            }
            response.result = .analyze(result)
        default:
            throw HelperError.badRequest("Bilinmeyen komut: \(request.command)")
        }
        response.ok = true
    } catch {
        let own = HelperError.vision(error)
        response.error = PartError(code: own.code, message: own.message)
        response.result = nil
    }
    response.timingMs = Int(Date().timeIntervalSince(started) * 1000)
    return response
}

/// Parse stdin's bytes and answer (bad JSON is an `ok: false` response too).
public func handle(json data: Data) -> HelperResponse {
    let request: HelperRequest
    do {
        request = try JSONDecoder().decode(HelperRequest.self, from: data)
    } catch {
        return HelperResponse(
            ok: false, command: "",
            error: PartError(code: "bad_request", message: "İstek JSON değil: \(error)"),
            timingMs: 0)
    }
    return handle(request)
}

public func encode(_ response: HelperResponse) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return (try? encoder.encode(response))
        ?? Data(#"{"ok":false,"command":"","error":{"code":"encode_failed","message":"yanıt yazılamadı"},"timingMs":0}"#.utf8)
}
