import CryptoKit
import Foundation

/// Client-side copy of `computeContentHash` (packages/contract/src/content.ts):
/// SHA-256 over `JSON.stringify(slides.map(s => ({ width, height, html })))`.
///
/// Recomputing it proves that the approval refers to the exact design the user
/// looked at. The JSON is produced by hand to match JavaScript's
/// `JSON.stringify` byte for byte (Foundation's encoder escapes differently).
enum ContentHash {
    static func compute(_ slides: [Slide]) -> String {
        let digest = SHA256.hash(data: Data(canonicalJSON(slides).utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func canonicalJSON(_ slides: [Slide]) -> String {
        var out = "["
        for (index, slide) in slides.enumerated() {
            if index > 0 { out += "," }
            out += "{\"width\":\(slide.width),\"height\":\(slide.height),\"html\":"
            out += jsString(slide.html)
            out += "}"
        }
        out += "]"
        return out
    }

    /// `JSON.stringify(string)`: escapes `"`, `\`, and control characters
    /// below U+0020 (short forms where JSON has them, otherwise `\u00xx`
    /// lowercase); everything else, including `/` and non-ASCII, is literal.
    static func jsString(_ value: String) -> String {
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

    /// First 8 hex digits, for display ("a1b2c3d4").
    static func short(_ hash: String) -> String { String(hash.prefix(8)) }
}
