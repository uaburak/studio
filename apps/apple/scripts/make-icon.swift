// Placeholder app icon: white rounded square, black "S", orange dot.
//   swift apps/apple/scripts/make-icon.swift <appiconset-dir>
import AppKit

let out = CommandLine.arguments[1]
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = s * 0.1
    let rect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.width * 0.225).fill()
    NSColor(white: 0, alpha: 0.08).setStroke()
    NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: rect.width * 0.225, yRadius: rect.width * 0.225).stroke()
    let font = NSFont.systemFont(ofSize: rect.width * 0.56, weight: .bold)
    let text = NSAttributedString(string: "S", attributes: [.font: font, .foregroundColor: NSColor(white: 0.06, alpha: 1)])
    let bounds = text.size()
    text.draw(at: NSPoint(x: rect.midX - bounds.width / 2 - rect.width * 0.04, y: rect.midY - bounds.height / 2))
    NSColor(srgbRed: 1, green: 0x6A / 255, blue: 0, alpha: 1).setFill()
    let dot = rect.width * 0.12
    NSBezierPath(ovalIn: NSRect(x: rect.maxX - rect.width * 0.26, y: rect.minY + rect.width * 0.2, width: dot, height: dot)).fill()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/icon_\(size).png"))
}
