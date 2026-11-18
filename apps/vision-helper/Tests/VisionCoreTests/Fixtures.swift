// Synthetic pictures drawn in code (no fixture files): a product with a printed label on a busy,
// non-uniform backdrop, and an unrelated landscape.
import CoreGraphics
import CoreText
import Foundation

struct SeededRandom {
    var state: UInt64

    mutating func next() -> Double {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return Double(state % 1_000_000) / 1_000_000
    }
}

func rgbContext(width: Int, height: Int) -> CGContext {
    CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func drawText(
    _ context: CGContext, _ text: String, size: CGFloat, centerX: CGFloat, baselineFromTop: CGFloat,
    height: Int, color: CGColor
) {
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    context.textPosition = CGPoint(x: centerX - CGFloat(width) / 2, y: CGFloat(height) - baselineFromTop)
    CTLineDraw(line, context)
}

/// A bag with a white label (two lines of large text) on a busy backdrop. `productRect` is the
/// bag's box, normalized with a top-left origin.
func productPhoto(
    width: Int = 900, height: Int = 1125, label: [String] = ["VENTA BORİNÇ", "GÜBRE 25 KG"]
) -> (image: CGImage, productRect: CGRect) {
    let context = rgbContext(width: width, height: height)
    let w = CGFloat(width)
    let h = CGFloat(height)
    // Backdrop: a warm vertical gradient (a table and a wall), wood-like stripes, scattered blobs.
    let gradient = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [
            CGColor(srgbRed: 0.78, green: 0.66, blue: 0.5, alpha: 1),
            CGColor(srgbRed: 0.42, green: 0.3, blue: 0.22, alpha: 1),
        ] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: h), end: CGPoint(x: 0, y: 0), options: [])
    var random = SeededRandom(state: 0x5EED_1234_ABCD)
    for i in 0..<14 {
        let y = h * 0.62 * CGFloat(i) / 14
        context.setFillColor(
            CGColor(srgbRed: 0.35 + 0.2 * random.next(), green: 0.25, blue: 0.15, alpha: 0.35))
        context.fill(CGRect(x: 0, y: y, width: w, height: h * 0.012))
    }
    for _ in 0..<40 {
        let size = 20 + 70 * random.next()
        context.setFillColor(
            CGColor(
                srgbRed: random.next(), green: random.next(), blue: random.next(), alpha: 0.35))
        context.fillEllipse(
            in: CGRect(x: w * random.next(), y: h * random.next(), width: size, height: size))
    }
    // The product: a dark green bag with a white label.
    let bag = CGRect(x: w * 0.22, y: h * 0.18, width: w * 0.56, height: h * 0.66)  // bottom-left origin
    context.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: CGColor(gray: 0, alpha: 0.45))
    context.setFillColor(CGColor(srgbRed: 0.08, green: 0.33, blue: 0.16, alpha: 1))
    context.addPath(CGPath(roundedRect: bag, cornerWidth: 28, cornerHeight: 28, transform: nil))
    context.fillPath()
    context.setShadow(offset: .zero, blur: 0, color: nil)
    let labelRect = bag.insetBy(dx: bag.width * 0.07, dy: bag.height * 0.2)
    context.setFillColor(CGColor(srgbRed: 0.98, green: 0.98, blue: 0.96, alpha: 1))
    context.fill(labelRect)
    let top = h - labelRect.maxY
    for (index, text) in label.enumerated() {
        drawText(
            context, text, size: w * 0.062, centerX: bag.midX,
            baselineFromTop: top + labelRect.height * (0.32 + 0.3 * CGFloat(index)), height: height,
            color: CGColor(srgbRed: 0.05, green: 0.05, blue: 0.05, alpha: 1))
    }
    let image = context.makeImage()!
    let normalized = CGRect(
        x: bag.minX / w, y: (h - bag.maxY) / h, width: bag.width / w, height: bag.height / h)
    return (image, normalized)
}

/// An unrelated picture: a blue sky over green hills.
func landscape(width: Int = 900, height: Int = 600) -> CGImage {
    let context = rgbContext(width: width, height: height)
    let w = CGFloat(width)
    let h = CGFloat(height)
    let sky = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        colors: [
            CGColor(srgbRed: 0.35, green: 0.6, blue: 0.95, alpha: 1),
            CGColor(srgbRed: 0.8, green: 0.9, blue: 1, alpha: 1),
        ] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(sky, start: CGPoint(x: 0, y: h), end: CGPoint(x: 0, y: h * 0.4), options: [])
    context.setFillColor(CGColor(srgbRed: 0.2, green: 0.55, blue: 0.2, alpha: 1))
    context.fillEllipse(in: CGRect(x: -w * 0.2, y: -h * 0.5, width: w * 0.9, height: h * 0.95))
    context.setFillColor(CGColor(srgbRed: 0.15, green: 0.45, blue: 0.18, alpha: 1))
    context.fillEllipse(in: CGRect(x: w * 0.35, y: -h * 0.6, width: w * 0.9, height: h * 1.0))
    context.setFillColor(CGColor(srgbRed: 1, green: 0.95, blue: 0.6, alpha: 1))
    context.fillEllipse(in: CGRect(x: w * 0.75, y: h * 0.72, width: w * 0.1, height: w * 0.1))
    return context.makeImage()!
}

func temporaryFile(_ name: String, _ data: Data) throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
        "studio-vision-tests-\(ProcessInfo.processInfo.processIdentifier)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent(name)
    try data.write(to: url)
    return url.path
}

/// Lowercase, Turkish letters folded to ASCII, punctuation dropped (for tolerant text checks).
func folded(_ text: String) -> String {
    let lower = text.lowercased(with: Locale(identifier: "tr_TR"))
    let mapped = lower.map { character -> String in
        switch character {
        case "ı", "i̇": return "i"
        case "ş": return "s"
        case "ç": return "c"
        case "ğ": return "g"
        case "ü": return "u"
        case "ö": return "o"
        default: return String(character)
        }
    }.joined()
    return mapped.folding(options: [.diacriticInsensitive], locale: nil)
}
