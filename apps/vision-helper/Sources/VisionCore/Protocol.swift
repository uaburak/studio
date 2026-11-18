// The helper's JSON protocol (mirrored by apps/worker/src/vision/helper.ts).
//
// Request (stdin, one object):
//   { "command": "version" | "ocr" | "classify" | "feature-print" | "foreground-mask"
//                | "saliency" | "analyze" | "feature-distance",
//     "path": "/abs/image.png"  or  "base64": "<image bytes>",
//     … the command's options (below) }
//
// Response (stdout, one object):
//   { "ok": true, "command": …, "helperVersion": …, "image": { "width", "height" }, "result": … }
//   { "ok": false, "command": …, "helperVersion": …, "error": { "code", "message" } }
//
// Boxes are normalized to the image (0…1) with the origin at the TOP-LEFT (Vision's own boxes
// start bottom-left; they are flipped here so the worker can use them with sharp directly).
import Foundation

public let helperVersion = "1.0.0"

public struct HelperRequest: Decodable, Sendable {
    public var command: String
    public var path: String?
    public var base64: String?
    /// `feature-distance`: the second image.
    public var otherPath: String?
    /// `foreground-mask`: where to write the PNG cutout (else it comes back as base64).
    public var output: String?
    /// `ocr`: BCP-47 codes, e.g. ["tr-TR", "en-US"] ("tr" and "en" are accepted too).
    public var languages: [String]?
    /// `ocr`: "accurate" (default) or "fast".
    public var level: String?
    /// `ocr`: Vision's language correction (default true).
    public var languageCorrection: Bool?
    /// `classify`: drop labels below this confidence (default 0.08).
    public var minConfidence: Double?
    /// `classify`: at most this many labels (default 12).
    public var maxLabels: Int?
    /// `foreground-mask`: "all" (default) or "largest".
    public var instances: String?
    /// `foreground-mask`: crop the cutout to the instances' extent (default true).
    public var crop: Bool?
    /// `saliency`: the coarse grid's size (default 12 × 12).
    public var gridColumns: Int?
    public var gridRows: Int?
    /// `analyze`: which parts to run (default classify, ocr, feature-print).
    public var ops: [String]?

    public init(command: String, path: String? = nil) {
        self.command = command
        self.path = path
    }
}

public struct Box: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct ImageSize: Codable, Sendable {
    public var width: Int
    public var height: Int
}

public struct OcrLine: Codable, Sendable {
    public var text: String
    public var confidence: Double
    public var box: Box
}

public struct OcrResult: Codable, Sendable {
    /// The languages Vision was asked for (only the supported ones of the request).
    public var languages: [String]
    /// Requested languages this macOS cannot read.
    public var unsupportedLanguages: [String]
    /// Top to bottom, then left to right.
    public var lines: [OcrLine]
    public var text: String
}

public struct ClassifyLabel: Codable, Sendable {
    public var identifier: String
    public var confidence: Double
}

public struct ClassifyResult: Codable, Sendable {
    public var labels: [ClassifyLabel]
}

public struct FeaturePrintResult: Codable, Sendable {
    public var revision: Int
    /// Number of elements (768 for revision 2).
    public var count: Int
    /// Little-endian Float32 values, base64.
    public var data: String
}

public struct InstanceArea: Codable, Sendable {
    public var instance: Int
    /// Share of the image's area.
    public var area: Double
}

public struct MaskResult: Codable, Sendable {
    /// Every instance Vision separated from the background.
    public var instances: [InstanceArea]
    /// The instances in the cutout.
    public var used: [Int]
    /// The cutout's extent in the image (normalized, top-left origin).
    public var box: Box
    /// The same in pixels of the input image.
    public var pixelBox: Box
    /// Share of the image's area the cutout covers.
    public var coverage: Double
    /// Size of the written cutout.
    public var width: Int
    public var height: Int
    /// The written file (`output`), or nil when the PNG came back as `png`.
    public var output: String?
    public var png: String?
}

public struct SalientObject: Codable, Sendable {
    public var box: Box
    public var confidence: Double
}

public struct SaliencyResult: Codable, Sendable {
    public var objects: [SalientObject]
    public var columns: Int
    public var rows: Int
    /// Row-major from the top-left, each cell's mean attention scaled so the highest is 1.
    public var grid: [Double]
}

public struct DistanceResult: Codable, Sendable {
    public var distance: Double
}

public struct VersionResult: Codable, Sendable {
    public var helperVersion: String
    public var os: String
    public var ocrLanguages: [String]
    public var foregroundMask: Bool
    public var featurePrintRevision: Int
}

public struct PartError: Codable, Sendable {
    public var code: String
    public var message: String
}

public struct AnalyzeResult: Codable, Sendable {
    public var classify: ClassifyResult?
    public var ocr: OcrResult?
    public var featurePrint: FeaturePrintResult?
    public var saliency: SaliencyResult?
    /// A part that failed, by op name; the others still came back.
    public var errors: [String: PartError]
}

public enum HelperResult: Sendable {
    case version(VersionResult)
    case ocr(OcrResult)
    case classify(ClassifyResult)
    case featurePrint(FeaturePrintResult)
    case mask(MaskResult)
    case saliency(SaliencyResult)
    case analyze(AnalyzeResult)
    case distance(DistanceResult)
}

public struct HelperError: Error, Sendable, Equatable {
    public var code: String
    public var message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public static func badRequest(_ message: String) -> HelperError {
        HelperError("bad_request", message)
    }

    public static func unreadable(_ message: String) -> HelperError {
        HelperError("unreadable_image", message)
    }

    public static func unsupportedOS(_ message: String) -> HelperError {
        HelperError("unsupported_os", message)
    }

    public static func noForeground(_ message: String) -> HelperError {
        HelperError("no_foreground", message)
    }

    public static func vision(_ error: Error) -> HelperError {
        if let own = error as? HelperError { return own }
        return HelperError("vision_failed", String(describing: error))
    }
}

/// The JSON written to stdout.
public struct HelperResponse: Encodable, Sendable {
    public var ok: Bool
    public var command: String
    public var helperVersion: String = VisionCore.helperVersion
    public var image: ImageSize?
    public var result: HelperResult?
    public var error: PartError?
    public var timingMs: Int

    enum CodingKeys: String, CodingKey {
        case ok, command, helperVersion, image, result, error, timingMs
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ok, forKey: .ok)
        try c.encode(command, forKey: .command)
        try c.encode(helperVersion, forKey: .helperVersion)
        try c.encodeIfPresent(image, forKey: .image)
        try c.encodeIfPresent(error, forKey: .error)
        try c.encode(timingMs, forKey: .timingMs)
        switch result {
        case .version(let r): try c.encode(r, forKey: .result)
        case .ocr(let r): try c.encode(r, forKey: .result)
        case .classify(let r): try c.encode(r, forKey: .result)
        case .featurePrint(let r): try c.encode(r, forKey: .result)
        case .mask(let r): try c.encode(r, forKey: .result)
        case .saliency(let r): try c.encode(r, forKey: .result)
        case .analyze(let r): try c.encode(r, forKey: .result)
        case .distance(let r): try c.encode(r, forKey: .result)
        case nil: break
        }
    }
}
