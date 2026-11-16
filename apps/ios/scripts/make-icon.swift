// Draws the placeholder app icon (1024×1024, opaque) with AppKit.
//   swift scripts/make-icon.swift Studio/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit

let size = 1024
let out = CommandLine.arguments.dropFirst().first ?? "AppIcon.png"
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("bitmap") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let rect = NSRect(x: 0, y: 0, width: size, height: size)
NSGradient(starting: NSColor(srgbRed: 0.98, green: 0.52, blue: 0.24, alpha: 1),
           ending: NSColor(srgbRed: 0.80, green: 0.22, blue: 0.36, alpha: 1))!.draw(in: rect, angle: -60)
let style = NSMutableParagraphStyle(); style.alignment = .center
let text = NSAttributedString(string: "S", attributes: [
    .font: NSFont.systemFont(ofSize: 640, weight: .heavy),
    .foregroundColor: NSColor.white, .paragraphStyle: style])
let bounds = text.boundingRect(with: rect.size, options: [.usesLineFragmentOrigin])
text.draw(in: NSRect(x: 0, y: (CGFloat(size) - bounds.height) / 2, width: CGFloat(size), height: bounds.height))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
