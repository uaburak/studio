import Foundation

// Videos from the phone (N21): Reels footage shot on the iPhone goes to the Mac as an asset.
// The API takes `video/mp4` and `video/quicktime` up to 50 MiB (`ASSET_MIME_RULES` in
// packages/contract/src/asset.ts; the file is held in memory there for hashing). A clip that
// already fits goes as it is; a larger one, or one in another container, is exported again to
// an H.264 / HEVC mp4 that fits; a clip too long to fit at a watchable quality is refused with
// the longest length that would.

/// What the phone knows about a picked video before deciding.
public struct VideoSourceInfo: Sendable, Equatable {
    public var bytes: Int
    public var durationMs: Int
    /// `video/mp4`, `video/quicktime`, … (from the file type).
    public var mimeType: String?
    public var width: Int?
    public var height: Int?
    public var codec: VideoCodec

    public init(bytes: Int, durationMs: Int, mimeType: String?, width: Int? = nil, height: Int? = nil, codec: VideoCodec = .unknown) {
        self.bytes = bytes
        self.durationMs = durationMs
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.codec = codec
    }
}

public enum VideoCodec: String, Sendable, Equatable {
    case h264, hevc, prores, other, unknown

    /// FourCC of a video track's format description (`avc1`, `hvc1`, `apcn`, …).
    public init(fourCC: String) {
        switch fourCC.lowercased() {
        case "avc1", "avc3": self = .h264
        case "hvc1", "hev1", "dvh1", "dvhe": self = .hevc
        case "apcn", "apch", "apcs", "apco", "ap4h", "ap4x": self = .prores
        default: self = .other
        }
    }

    /// Codecs the Mac's ffmpeg and the platforms take as they are.
    var isDeliverable: Bool { self == .h264 || self == .hevc || self == .unknown }
}

/// An AVAssetExportSession preset the phone may export with, best first.
public enum VideoExportPreset: String, Sendable, CaseIterable {
    /// `AVAssetExportPresetHEVC1920x1080`.
    case hevc1080 = "AVAssetExportPresetHEVC1920x1080"
    /// `AVAssetExportPreset1920x1080` (H.264).
    case h264_1080 = "AVAssetExportPreset1920x1080"
    /// `AVAssetExportPreset1280x720` (H.264).
    case h264_720 = "AVAssetExportPreset1280x720"
    /// `AVAssetExportPreset960x540` (H.264): the smallest still fine for a phone screen.
    case h264_540 = "AVAssetExportPreset960x540"

    /// Rough video + audio bitrate (bits/s) of a phone clip exported with this preset; only for
    /// choosing a first try (the export's own estimate and the real size decide).
    public var typicalBitrate: Int {
        switch self {
        case .hevc1080: 7_000_000
        case .h264_1080: 11_000_000
        case .h264_720: 5_500_000
        case .h264_540: 3_000_000
        }
    }

    public var label: String {
        switch self {
        case .hevc1080: "1080p HEVC"
        case .h264_1080: "1080p H.264"
        case .h264_720: "720p"
        case .h264_540: "540p"
        }
    }
}

/// What to do with a picked video.
public enum VideoUploadDecision: Sendable, Equatable {
    /// Send the file as it is, with this mime type.
    case asIs(mimeType: String)
    /// Export again; try these presets in order until the result fits.
    case transcode([VideoExportPreset])
    /// Cannot be sent; the Turkish reason.
    case refuse(String)
}

public enum VideoUploadPlanner {
    /// The server's limit for `video/mp4` and `video/quicktime`.
    public static let maxBytes = AssetMimeRules.videoMaxBytes
    /// Containers the server stores.
    public static let acceptedMimeTypes: Set<String> = ["video/mp4", "video/quicktime"]
    /// Room left for the multipart framing and the estimate being off.
    public static let headroom = 0.92

    public static func decide(_ info: VideoSourceInfo, limit: Int = maxBytes) -> VideoUploadDecision {
        guard info.durationMs > 0, info.bytes > 0 else {
            return .refuse("Video okunamadı. Fotoğraflar'da açılıyorsa yeniden dene.")
        }
        let mime = info.mimeType?.lowercased()
        if let mime, acceptedMimeTypes.contains(mime), info.bytes <= limit, info.codec.isDeliverable {
            return .asIs(mimeType: mime)
        }
        let presets = presets(durationMs: info.durationMs, limit: limit)
        guard !presets.isEmpty else {
            return .refuse("Video \(megabytes(limit)) sınırına sığmıyor. En fazla \(maxDurationText(limit: limit)) uzunluğunda bir bölümünü kırpıp yeniden dene.")
        }
        return .transcode(presets)
    }

    /// Presets worth a try, best first: empty when even the smallest would not fit. A larger
    /// one stays in while its typical size is within 1.5× the limit, since the export session's
    /// own estimate (checked before exporting) and the real size (checked after) decide.
    public static func presets(durationMs: Int, limit: Int = maxBytes) -> [VideoExportPreset] {
        guard let smallest = VideoExportPreset.allCases.last,
              fits(estimatedBytes: estimatedBytes(smallest, durationMs: durationMs), limit: limit) else { return [] }
        return VideoExportPreset.allCases.filter { Double(estimatedBytes($0, durationMs: durationMs)) <= Double(limit) * 1.5 }
    }

    public static func estimatedBytes(_ preset: VideoExportPreset, durationMs: Int) -> Int {
        Int((Double(preset.typicalBitrate) / 8 * Double(durationMs) / 1000).rounded(.up))
    }

    public static func fits(estimatedBytes: Int, limit: Int = maxBytes) -> Bool {
        Double(estimatedBytes) <= Double(limit) * headroom
    }

    /// An export result is usable: under the limit and not cut short (`fileLengthLimit` stops an
    /// export early instead of failing).
    public static func accepts(outputBytes: Int, outputDurationMs: Int, sourceDurationMs: Int, limit: Int = maxBytes) -> Bool {
        guard outputBytes > 0, outputBytes <= limit else { return false }
        return Double(outputDurationMs) >= Double(sourceDurationMs) * 0.97 - 100
    }

    /// The longest clip the smallest preset fits ("3 dk 40 sn").
    public static func maxDurationText(limit: Int = maxBytes) -> String {
        let smallest = VideoExportPreset.allCases.last!
        let seconds = Int(Double(limit) * headroom * 8 / Double(smallest.typicalBitrate))
        let minutes = seconds / 60
        let rest = seconds % 60
        if minutes == 0 { return "\(seconds) sn" }
        return rest == 0 ? "\(minutes) dk" : "\(minutes) dk \(rest) sn"
    }

    public static func megabytes(_ bytes: Int) -> String { "\(bytes / (1024 * 1024)) MB" }

    /// `video/mp4` / `video/quicktime` from a file extension (nil for others).
    public static func mimeType(forExtension ext: String) -> String? {
        switch ext.lowercased() {
        case "mp4", "m4v": "video/mp4"
        case "mov", "qt": "video/quicktime"
        default: nil
        }
    }
}
