import Foundation

/// An image slot declared in a slide's HTML by the design contract
/// (packages/design-kit: `data-type="slot"`, `data-slot-state`,
/// `data-slot-ratio`, `data-slot-label`). Read with a plain attribute scan:
/// the apps never render or execute slide HTML.
public struct ImageSlot: Sendable, Hashable {
    public enum State: String, Sendable { case empty, filled, unknown }

    public var slideIndex: Int
    public var layerId: String?
    public var state: State
    /// `"4:5"` as declared.
    public var ratio: String?
    public var label: String?

    public var isEmpty: Bool { state == .empty }

    /// Width / height from `ratio`, if it parses.
    public var aspect: Double? {
        guard let ratio else { return nil }
        let parts = ratio.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 2, parts[1] > 0 else { return nil }
        return parts[0] / parts[1]
    }
}

public enum SlotScanner {
    /// Every slot in `slides`, in document order.
    public static func slots(in slides: [Slide]) -> [ImageSlot] {
        slides.enumerated().flatMap { index, slide in slots(inHTML: slide.html, slideIndex: index) }
    }

    public static func slots(inHTML html: String, slideIndex: Int = 0) -> [ImageSlot] {
        var result: [ImageSlot] = []
        var searchStart = html.startIndex
        while let open = html[searchStart...].firstIndex(of: "<") {
            guard let close = html[open...].firstIndex(of: ">") else { break }
            let tag = html[open...close]
            searchStart = html.index(after: close)
            guard tag.count > 2, tag.dropFirst().first?.isLetter == true else { continue }
            let attributes = parseAttributes(String(tag))
            guard attributes["data-type"]?.lowercased() == "slot" else { continue }
            result.append(ImageSlot(
                slideIndex: slideIndex,
                layerId: attributes["data-layer"],
                state: ImageSlot.State(rawValue: attributes["data-slot-state"]?.lowercased() ?? "") ?? .unknown,
                ratio: attributes["data-slot-ratio"],
                label: attributes["data-slot-label"]))
        }
        return result
    }

    /// `name="value"` / `name='value'` / `name=value` pairs of one tag, lowercased names.
    static func parseAttributes(_ tag: String) -> [String: String] {
        var attributes: [String: String] = [:]
        let scalars = Array(tag.unicodeScalars)
        var i = 1
        // Skip the tag name.
        while i < scalars.count, !CharacterSet.whitespacesAndNewlines.contains(scalars[i]), scalars[i] != ">" { i += 1 }
        func isSpace(_ s: Unicode.Scalar) -> Bool { CharacterSet.whitespacesAndNewlines.contains(s) }
        while i < scalars.count {
            while i < scalars.count, isSpace(scalars[i]) || scalars[i] == "/" { i += 1 }
            guard i < scalars.count, scalars[i] != ">" else { break }
            var name = ""
            while i < scalars.count, !isSpace(scalars[i]), scalars[i] != "=", scalars[i] != ">" {
                name.unicodeScalars.append(scalars[i])
                i += 1
            }
            while i < scalars.count, isSpace(scalars[i]) { i += 1 }
            var value = ""
            if i < scalars.count, scalars[i] == "=" {
                i += 1
                while i < scalars.count, isSpace(scalars[i]) { i += 1 }
                if i < scalars.count, scalars[i] == "\"" || scalars[i] == "'" {
                    let quote = scalars[i]
                    i += 1
                    while i < scalars.count, scalars[i] != quote {
                        value.unicodeScalars.append(scalars[i])
                        i += 1
                    }
                    i += 1
                } else {
                    while i < scalars.count, !isSpace(scalars[i]), scalars[i] != ">" {
                        value.unicodeScalars.append(scalars[i])
                        i += 1
                    }
                }
            }
            if !name.isEmpty { attributes[name.lowercased()] = decodeEntities(value) }
        }
        return attributes
    }

    static func decodeEntities(_ value: String) -> String {
        guard value.contains("&") else { return value }
        return value
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }
}

/// A caption split into its body and the trailing hashtag block.
public struct CaptionParts: Sendable, Equatable {
    public var body: String
    public var hashtags: [String]

    public init(body: String, hashtags: [String]) {
        self.body = body
        self.hashtags = hashtags
    }

    /// Trailing lines made only of `#tags` become `hashtags`.
    public init(caption: String) {
        var lines = caption.components(separatedBy: "\n")
        var tags: [String] = []
        while let last = lines.last {
            let trimmed = last.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                lines.removeLast()
                continue
            }
            let words = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard !words.isEmpty, words.allSatisfy({ $0.hasPrefix("#") && $0.count > 1 }) else { break }
            tags = words + tags
            lines.removeLast()
        }
        self.init(body: lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), hashtags: tags)
    }

    /// Normalise free text ("venta, #bor  çinko") into `#tags`.
    public static func parseHashtags(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" || $0 == "\t" })
            .map { word in word.hasPrefix("#") ? String(word) : "#" + word }
            .filter { $0.count > 1 }
    }

    public var caption: String {
        let tags = hashtags.joined(separator: " ")
        if body.isEmpty { return tags }
        if tags.isEmpty { return body }
        return body + "\n\n" + tags
    }
}
