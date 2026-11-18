import CoreGraphics
import Foundation
import ImageIO

/// Sizes of `GET /api/assets/{id}/thumbnail?w=` (`THUMBNAIL_WIDTHS` in asset.ts).
public enum AssetThumbnail {
    public static let widths = [160, 240, 320, 480, 640, 960, 1280]

    /// The thumbnail width the server makes for a wanted pixel width (rounded up; the largest caps it).
    public static func width(for pixels: Double) -> Int {
        guard pixels.isFinite, pixels > 0 else { return 480 }
        return widths.first { Double($0) >= pixels } ?? widths[widths.count - 1]
    }

    /// Width for a view `points` wide on a screen of `scale`.
    public static func width(points: Double, scale: Double) -> Int {
        width(for: points * max(scale, 1))
    }

    /// Mime types the endpoint resizes (`THUMBNAILABLE_MIME_TYPES`); others answer 415.
    public static let resizableMimeTypes: Set<String> = ["image/jpeg", "image/png", "image/webp", "image/gif"]
}

/// Decodes pictures at the size they are shown (ImageIO thumbnails), never the full bitmap.
public enum ImageDownsampler {
    /// Pixel size of the encoded picture (orientation applied), without decoding it.
    public static func pixelSize(of data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 else { return nil }
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return orientation >= 5 ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
    }

    /// Longest side to ask ImageIO for so the result is `width` px wide (never larger than the original).
    public static func maxPixelSize(forWidth width: Int, imageSize: CGSize) -> Int {
        guard imageSize.width > 0, imageSize.height > 0 else { return max(width, 1) }
        let target = min(Double(width), imageSize.width)
        let longest = target * max(imageSize.width, imageSize.height) / imageSize.width
        return max(1, Int(longest.rounded(.up)))
    }

    /// The picture decoded `width` px wide (nil width: at most `maxPixel` on the longest side).
    /// Returns nil for data that is not a picture.
    public static func downsample(_ data: Data, width: Int?, maxPixel: Int = 2560) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let size = pixelSize(of: data)
        var limit = maxPixel
        if let width, let size { limit = min(maxPixel, maxPixelSize(forWidth: width, imageSize: size)) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: limit,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Bytes a decoded image holds in memory (the cache's cost).
    public static func memoryCost(_ image: CGImage) -> Int {
        image.bytesPerRow * image.height
    }
}
