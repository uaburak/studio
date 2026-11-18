// Reading the input picture (upright, EXIF orientation applied) and writing PNGs.
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO

/// Decode an image file's bytes into an upright CGImage.
public func loadImage(data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
        CGImageSourceGetCount(source) > 0
    else {
        throw HelperError.unreadable("Görsel okunamadı (desteklenmeyen ya da bozuk dosya).")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw HelperError.unreadable("Görsel çözülemedi.")
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.int32Value ?? 1
    if orientation == 1 { return image }
    let upright = CIImage(cgImage: image).oriented(forExifOrientation: orientation)
    let context = CIContext(options: [.useSoftwareRenderer: false])
    guard
        let rendered = context.createCGImage(
            upright, from: upright.extent, format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    else {
        throw HelperError.unreadable("Görselin yönü düzeltilemedi.")
    }
    return rendered
}

/// The request's picture: `path` or `base64`.
public func loadRequestImage(_ request: HelperRequest) throws -> CGImage {
    if let path = request.path, !path.isEmpty {
        let url = URL(fileURLWithPath: path)
        guard let data = try? Data(contentsOf: url) else {
            throw HelperError.unreadable("Dosya okunamadı: \(path)")
        }
        return try loadImage(data: data)
    }
    if let encoded = request.base64, !encoded.isEmpty {
        guard let data = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters) else {
            throw HelperError.badRequest("base64 çözülemedi.")
        }
        return try loadImage(data: data)
    }
    throw HelperError.badRequest("Görsel yok: path ya da base64 gerekli.")
}

/// PNG bytes of a pixel buffer (keeps alpha), in sRGB.
public func pngData(of buffer: CVPixelBuffer) throws -> Data {
    let image = CIImage(cvPixelBuffer: buffer)
    let context = CIContext()
    guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
        let data = context.pngRepresentation(of: image, format: .RGBA8, colorSpace: srgb)
    else {
        throw HelperError("encode_failed", "PNG yazılamadı.")
    }
    return data
}

/// PNG bytes of a CGImage (tests and fixtures).
public func pngData(of image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard
        let destination = CGImageDestinationCreateWithData(
            data as CFMutableData, "public.png" as CFString, 1, nil)
    else {
        throw HelperError("encode_failed", "PNG yazılamadı.")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw HelperError("encode_failed", "PNG yazılamadı.")
    }
    return data as Data
}

/// Vision's bottom-left normalized rect → top-left `Box`.
func topLeftBox(_ rect: CGRect) -> Box {
    Box(
        x: clamp01(Double(rect.minX)),
        y: clamp01(1 - Double(rect.maxY)),
        width: clamp01(Double(rect.width)),
        height: clamp01(Double(rect.height)))
}

func clamp01(_ value: Double) -> Double {
    min(1, max(0, value))
}
