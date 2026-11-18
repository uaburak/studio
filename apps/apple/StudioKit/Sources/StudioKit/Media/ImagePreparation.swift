import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A shared picture as it goes to the Mac (the share extension; the app's own picker keeps
/// `IOSImageImport`, which works on `UIImage`). Decoded with ImageIO at the size it is sent, so a
/// 48 MP photo never sits in the extension's small memory budget: at most 3072 px on the longest
/// side, upright; a picture with transparency stays PNG (a product cut-out), anything else
/// (HEIC, camera JPEG) becomes JPEG.
public enum ImagePreparation {
    public static let maxPixel = 3072

    public struct Prepared: Sendable {
        public var file: UploadFile
        /// A small preview (240 px) for the sheet.
        public var thumbnail: CGImage?
    }

    /// `longestSide`: the share extension asks for less (its memory is small; renders use
    /// 1080–2160 px).
    public static func prepare(data: Data, filename: String? = nil, longestSide: Int = maxPixel) throws -> Prepared {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw StudioAPIError.invalidConfiguration("Görsel açılamadı (desteklenmeyen biçim).")
        }
        return try prepare(source: source, filename: filename, longestSide: longestSide)
    }

    public static func prepare(fileAt url: URL, filename: String? = nil, longestSide: Int = maxPixel) throws -> Prepared {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw StudioAPIError.invalidConfiguration("Görsel açılamadı (desteklenmeyen biçim).")
        }
        return try prepare(source: source, filename: filename ?? url.lastPathComponent, longestSide: longestSide)
    }

    static func prepare(source: CGImageSource, filename: String?, longestSide: Int = maxPixel) throws -> Prepared {
        let limit = max(240, min(longestSide, maxPixel))
        guard CGImageSourceGetCount(source) > 0,
              let image = downsampled(source, maxPixel: limit) else {
            throw StudioAPIError.invalidConfiguration("Görsel açılamadı (desteklenmeyen biçim).")
        }
        let stem = stemName(filename)
        let thumbnail = downsampled(source, maxPixel: 240)
        if hasAlpha(image.alphaInfo) {
            for side in [limit, 2048, 1536] where side <= limit {
                let sized = side == limit ? image : (downsampled(source, maxPixel: side) ?? image)
                guard let png = encode(sized, type: .png) else { break }
                if png.count <= AssetMimeRules.imageMaxBytes {
                    return Prepared(file: UploadFile(filename: "\(stem).png", mimeType: "image/png", data: png, width: sized.width, height: sized.height), thumbnail: thumbnail)
                }
            }
            throw StudioAPIError.invalidConfiguration("Saydam görsel 20 MB sınırına sığmıyor.")
        }
        guard let jpeg = encode(image, type: .jpeg, quality: 0.88) else {
            throw StudioAPIError.invalidConfiguration("Görsel kodlanamadı.")
        }
        guard jpeg.count <= AssetMimeRules.imageMaxBytes else {
            throw StudioAPIError.invalidConfiguration("Görsel 20 MB sınırını aşıyor.")
        }
        return Prepared(file: UploadFile(filename: "\(stem).jpg", mimeType: "image/jpeg", data: jpeg, width: image.width, height: image.height), thumbnail: thumbnail)
    }

    /// The picture upright, at most `maxPixel` on the longest side (never enlarged).
    public static func downsampled(_ source: CGImageSource, maxPixel: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    public static func hasAlpha(_ info: CGImageAlphaInfo) -> Bool {
        switch info {
        case .none, .noneSkipFirst, .noneSkipLast: false
        default: true
        }
    }

    static func encode(_ image: CGImage, type: UTType, quality: Double? = nil) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        var options: [CFString: Any] = [:]
        if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }

    static func stemName(_ filename: String?) -> String {
        let stem = ((filename ?? "") as NSString).deletingPathExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = stem.replacingOccurrences(of: "/", with: "-")
        return cleaned.isEmpty ? "gorsel" : String(cleaned.prefix(80))
    }
}
