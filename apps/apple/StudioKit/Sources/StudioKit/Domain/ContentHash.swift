import CryptoKit
import Foundation

/// `computeContentHash` from packages/contract/src/content.ts, bit for bit:
/// SHA-256 over `JSON.stringify(slides.map(s => ({ width, height, html })))`.
///
/// The apps recompute it from the slides they show before approving, so an
/// approval always names the exact design the user looked at.
public enum ContentHash {
    public static func compute(_ slides: [Slide]) -> String {
        var json = "["
        for (index, slide) in slides.enumerated() {
            if index > 0 { json += "," }
            json += "{\"width\":\(slide.width),\"height\":\(slide.height),\"html\":"
            json += jsonString(slide.html)
            json += "}"
        }
        json += "]"
        let digest = SHA256.hash(data: Data(json.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// A string literal exactly as `JSON.stringify` writes it (ECMA-262 QuoteJSONString).
    static func jsonString(_ value: String) -> String {
        var out = "\""
        out.reserveCapacity(value.utf8.count + 2)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
