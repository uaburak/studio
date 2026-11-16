import Foundation

/// An editable `[data-layer="..."]` element extracted from a slide's HTML
/// without WebKit or HTML execution.
public struct SlideLayer: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable, CaseIterable, Codable {
        case text
        case image
        case slot
        case logo
        case shape
        case group
        case other

        public var label: String {
            switch self {
            case .text: "Metin"
            case .image: "Görsel"
            case .slot: "Görsel yuvası"
            case .logo: "Logo"
            case .shape: "Şekil"
            case .group: "Grup"
            case .other: "Katman"
            }
        }
    }

    /// Unique key across slides (`"<slideIndex>:<layerId>"`).
    public var id: String { "\(slideIndex):\(layerId)" }
    public var slideIndex: Int
    /// Value of `data-layer`.
    public var layerId: String
    public var kind: Kind
    public var tagName: String
    public var role: String?
    /// Plain text content for `.text` layers (`<br>` converted to `\n`).
    public var text: String
    /// `src` attribute for `.image` / `.logo` (or filled `.slot`).
    public var src: String?
    public var slotLabel: String?
    public var slotState: ImageSlot.State?
    public var isHidden: Bool

    public init(
        slideIndex: Int = 0,
        layerId: String,
        kind: Kind,
        tagName: String = "div",
        role: String? = nil,
        text: String = "",
        src: String? = nil,
        slotLabel: String? = nil,
        slotState: ImageSlot.State? = nil,
        isHidden: Bool = false
    ) {
        self.slideIndex = slideIndex
        self.layerId = layerId
        self.kind = kind
        self.tagName = tagName
        self.role = role
        self.text = text
        self.src = src
        self.slotLabel = slotLabel
        self.slotState = slotState
        self.isHidden = isHidden
    }
}

/// Serialisable layer edit operation sent to `content.render` (`patches`)
/// or applied locally in pure Swift for immediate preview / `SampleBackend`.
public enum SlideLayerPatch: Sendable, Hashable, Codable {
    case setText(layer: String, text: String, slideIndex: Int = 0)
    case setVisible(layer: String, visible: Bool, slideIndex: Int = 0)

    private enum CodingKeys: String, CodingKey {
        case op, layer, text, visible, slide
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let op = try c.decode(String.self, forKey: .op)
        let layer = try c.decode(String.self, forKey: .layer)
        let slide = try c.decodeIfPresent(Int.self, forKey: .slide) ?? 0
        switch op {
        case "set_text", "setText":
            let text = try c.decode(String.self, forKey: .text)
            self = .setText(layer: layer, text: text, slideIndex: slide)
        case "set_visible", "setVisibility":
            let visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
            self = .setVisible(layer: layer, visible: visible, slideIndex: slide)
        default:
            throw DecodingError.dataCorruptedError(forKey: .op, in: c, debugDescription: "unsupported patch op \(op)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .setText(let layer, let text, let slideIndex):
            try c.encode("set_text", forKey: .op)
            try c.encode(layer, forKey: .layer)
            try c.encode(text, forKey: .text)
            if slideIndex > 0 { try c.encode(slideIndex, forKey: .slide) }
        case .setVisible(let layer, let visible, let slideIndex):
            try c.encode("set_visible", forKey: .op)
            try c.encode(layer, forKey: .layer)
            try c.encode(visible, forKey: .visible)
            if slideIndex > 0 { try c.encode(slideIndex, forKey: .slide) }
        }
    }

    /// JSON dictionary matching `[{ op: "set_text", layer: id, text }, { op: "set_visible", layer: id, visible }]`.
    public func toJSONObject() -> JSONObject {
        switch self {
        case .setText(let layer, let text, let slideIndex):
            var obj: JSONObject = [
                "op": .string("set_text"),
                "layer": .string(layer),
                "text": .string(text),
            ]
            if slideIndex > 0 { obj["slide"] = .number(Double(slideIndex)) }
            return obj
        case .setVisible(let layer, let visible, let slideIndex):
            var obj: JSONObject = [
                "op": .string("set_visible"),
                "layer": .string(layer),
                "visible": .bool(visible),
            ]
            if slideIndex > 0 { obj["slide"] = .number(Double(slideIndex)) }
            return obj
        }
    }
}

public enum SlideLayerScanner {
    private static let voidTags: Set<String> = [
        "img", "br", "hr", "input", "meta", "link", "source", "track", "wbr", "area", "base", "col", "embed", "param",
    ]

    /// Extract all `[data-layer]` elements across `slides`, in document order.
    public static func layers(in slides: [Slide]) -> [SlideLayer] {
        slides.enumerated().flatMap { index, slide in
            layers(inHTML: slide.html, slideIndex: index)
        }
    }

    /// Extract all `[data-layer]` elements from one slide's HTML.
    public static func layers(inHTML html: String, slideIndex: Int = 0) -> [SlideLayer] {
        var results: [SlideLayer] = []
        var searchStart = html.startIndex

        while let open = html[searchStart...].firstIndex(of: "<") {
            guard let close = html[open...].firstIndex(of: ">") else { break }
            let rawTag = String(html[open...close])
            let afterOpenTag = html.index(after: close)
            searchStart = afterOpenTag

            // Ignore closing tags, comments, doctype
            guard rawTag.count > 2 else { continue }
            let second = rawTag[rawTag.index(after: rawTag.startIndex)]
            guard second.isLetter else { continue }

            let tagName = parseTagName(rawTag)
            let attrs = parseRawAttributes(rawTag)
            guard let layerId = attrs["data-layer"]?.value, !layerId.isEmpty else { continue }

            let selfClosing = rawTag.dropLast().trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/") || voidTags.contains(tagName)
            let innerRange: Range<String.Index>?
            if selfClosing {
                innerRange = nil
            } else if let endMatch = findMatchingClose(in: html, tagName: tagName, from: afterOpenTag) {
                innerRange = afterOpenTag..<endMatch.openOfCloseTag
                // Continue scanning inside if it's a group, otherwise advance past element or keep scanning in document order.
                // Advancing searchStart stays at afterOpenTag so nested layers inside groups are also discovered in order.
            } else {
                innerRange = nil
            }

            let innerHTML = innerRange.map { String(html[$0]) } ?? ""
            let declaredType = (attrs["data-type"]?.value ?? attrs["data-layer-type"]?.value)?.lowercased()
            let kind = inferKind(declaredType: declaredType, tagName: tagName)
            let hidden = isTagHidden(attrs: attrs)

            var src = attrs["src"]?.value
            if src == nil, kind == .slot {
                src = firstImgSrc(in: innerHTML)
            }

            let plainText = kind == .text ? extractPlainText(from: innerHTML) : ""
            let slotState: ImageSlot.State? = kind == .slot
                ? (ImageSlot.State(rawValue: attrs["data-slot-state"]?.value.lowercased() ?? "") ?? .unknown)
                : nil

            results.append(SlideLayer(
                slideIndex: slideIndex,
                layerId: layerId,
                kind: kind,
                tagName: tagName,
                role: attrs["data-role"]?.value,
                text: plainText,
                src: src,
                slotLabel: attrs["data-slot-label"]?.value,
                slotState: slotState,
                isHidden: hidden
            ))
        }
        return results
    }

    /// Compute minimal patches (`set_text`, `set_visible`) between `original` layers and edited `updated` layers.
    public static func diff(from original: [SlideLayer], to updated: [SlideLayer]) -> [SlideLayerPatch] {
        let byId = Dictionary(uniqueKeysWithValues: original.map { ($0.id, $0) })
        var patches: [SlideLayerPatch] = []
        for item in updated {
            guard let prev = byId[item.id] else { continue }
            if item.kind == .text, prev.text != item.text {
                patches.append(.setText(layer: item.layerId, text: item.text, slideIndex: item.slideIndex))
            }
            if prev.isHidden != item.isHidden {
                patches.append(.setVisible(layer: item.layerId, visible: !item.isHidden, slideIndex: item.slideIndex))
            }
        }
        return patches
    }

    /// Apply patches to an array of `Slide`s (matching each patch's `slideIndex`).
    public static func apply(patches: [SlideLayerPatch], to slides: [Slide]) -> [Slide] {
        var copy = slides
        for patch in patches {
            let idx: Int = switch patch {
            case .setText(_, _, let s), .setVisible(_, _, let s): s
            }
            guard copy.indices.contains(idx) else { continue }
            copy[idx].html = apply(patches: [patch], toHTML: copy[idx].html)
        }
        return copy
    }

    /// Apply patches directly to a single slide's HTML string.
    public static func apply(patches: [SlideLayerPatch], toHTML html: String) -> String {
        var current = html
        for patch in patches {
            switch patch {
            case .setText(let layerId, let text, _):
                current = replaceLayerText(in: current, layerId: layerId, newText: text)
            case .setVisible(let layerId, let visible, _):
                current = setLayerVisibility(in: current, layerId: layerId, visible: visible)
            }
        }
        return current
    }

    /// Fill an image slot in `html` with `/media/<assetId>.jpg` and `data-slot-state="filled"`.
    public static func fillSlot(inHTML html: String, slotId: String?, assetId: EntityID) -> String {
        guard let match = findLayerElement(in: html, layerId: slotId, fallbackSlot: true) else { return html }
        var openTag = String(html[match.openTagRange])
        openTag = upsertAttribute(inOpenTag: openTag, name: "data-slot-state", value: "filled")
        let imgMarkup = "<img data-slot-image src=\"/media/\(escapeAttribute(assetId)).jpg\" alt=\"\">"
        if let innerRange = match.innerRange {
            var out = html
            out.replaceSubrange(innerRange, with: imgMarkup)
            let updatedMatch = findLayerElement(in: out, layerId: slotId, fallbackSlot: true)
            if let openRange = updatedMatch?.openTagRange {
                out.replaceSubrange(openRange, with: openTag)
            }
            return out
        } else {
            var out = html
            out.replaceSubrange(match.openTagRange, with: openTag)
            return out
        }
    }

    // MARK: - Internal HTML Helpers

    private struct AttrValue {
        var value: String
        var hasValue: Bool
    }

    private struct ElementMatch {
        var openTagRange: Range<String.Index>
        var innerRange: Range<String.Index>?
        var tagName: String
        var attrs: [String: AttrValue]
    }

    private static func findLayerElement(in html: String, layerId: String?, fallbackSlot: Bool = false) -> ElementMatch? {
        var searchStart = html.startIndex
        while let open = html[searchStart...].firstIndex(of: "<") {
            guard let close = html[open...].firstIndex(of: ">") else { break }
            let openTagRange = open..<html.index(after: close)
            let rawTag = String(html[openTagRange])
            searchStart = openTagRange.upperBound

            guard rawTag.count > 2, rawTag[rawTag.index(after: rawTag.startIndex)].isLetter else { continue }
            let tagName = parseTagName(rawTag)
            let attrs = parseRawAttributes(rawTag)
            let matchesLayer: Bool
            if let layerId, !layerId.isEmpty {
                matchesLayer = attrs["data-layer"]?.value == layerId
            } else if fallbackSlot {
                matchesLayer = (attrs["data-type"]?.value ?? attrs["data-layer-type"]?.value)?.lowercased() == "slot"
            } else {
                matchesLayer = false
            }
            guard matchesLayer else { continue }

            let selfClosing = rawTag.dropLast().trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/") || voidTags.contains(tagName)
            if selfClosing {
                return ElementMatch(openTagRange: openTagRange, innerRange: nil, tagName: tagName, attrs: attrs)
            }
            if let closeMatch = findMatchingClose(in: html, tagName: tagName, from: openTagRange.upperBound) {
                return ElementMatch(
                    openTagRange: openTagRange,
                    innerRange: openTagRange.upperBound..<closeMatch.openOfCloseTag,
                    tagName: tagName,
                    attrs: attrs
                )
            }
            return ElementMatch(openTagRange: openTagRange, innerRange: nil, tagName: tagName, attrs: attrs)
        }
        return nil
    }

    private static func replaceLayerText(in html: String, layerId: String, newText: String) -> String {
        guard let match = findLayerElement(in: html, layerId: layerId),
              let innerRange = match.innerRange else { return html }
        let escaped = escapeHTMLText(newText).replacingOccurrences(of: "\n", with: "<br>")
        var out = html
        out.replaceSubrange(innerRange, with: escaped)
        return out
    }

    private static func setLayerVisibility(in html: String, layerId: String, visible: Bool) -> String {
        guard let match = findLayerElement(in: html, layerId: layerId) else { return html }
        var openTag = String(html[match.openTagRange])
        if visible {
            openTag = removeBooleanOrValuedAttribute(inOpenTag: openTag, name: "data-hidden")
            openTag = removeBooleanOrValuedAttribute(inOpenTag: openTag, name: "hidden")
        } else {
            if match.attrs["data-hidden"] == nil {
                openTag = insertBooleanAttribute(inOpenTag: openTag, name: "data-hidden")
            }
        }
        var out = html
        out.replaceSubrange(match.openTagRange, with: openTag)
        return out
    }

    private static func upsertAttribute(inOpenTag openTag: String, name: String, value: String) -> String {
        let escaped = escapeAttribute(value)
        let pattern = "(?i)\\s+\(NSRegularExpression.escapedPattern(for: name))\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)"
        if let regex = try? NSRegularExpression(pattern: pattern),
           let range = regex.firstMatch(in: openTag, range: NSRange(openTag.startIndex..., in: openTag)).flatMap({ Range($0.range, in: openTag) }) {
            var copy = openTag
            copy.replaceSubrange(range, with: " \(name)=\"\(escaped)\"")
            return copy
        }
        return insertStringBeforeTagClose(inOpenTag: openTag, snippet: " \(name)=\"\(escaped)\"")
    }

    private static func insertBooleanAttribute(inOpenTag openTag: String, name: String) -> String {
        insertStringBeforeTagClose(inOpenTag: openTag, snippet: " \(name)")
    }

    private static func removeBooleanOrValuedAttribute(inOpenTag openTag: String, name: String) -> String {
        let pattern = "(?i)\\s+\(NSRegularExpression.escapedPattern(for: name))(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?(?=\\s|/?>)"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return openTag }
        return regex.stringByReplacingMatches(in: openTag, range: NSRange(openTag.startIndex..., in: openTag), withTemplate: "")
    }

    private static func insertStringBeforeTagClose(inOpenTag openTag: String, snippet: String) -> String {
        guard openTag.hasSuffix(">") else { return openTag }
        var body = String(openTag.dropLast())
        var suffix = ">"
        if body.hasSuffix("/") {
            body = String(body.dropLast())
            suffix = "/>"
        }
        return body + snippet + suffix
    }

    private static func inferKind(declaredType: String?, tagName: String) -> SlideLayer.Kind {
        if let declaredType {
            switch declaredType {
            case "text": return .text
            case "image": return .image
            case "slot": return .slot
            case "logo": return .logo
            case "shape": return .shape
            case "group": return .group
            default: break
            }
        }
        switch tagName {
        case "img": return .image
        case "svg": return .shape
        case "figure": return .slot
        case "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "blockquote", "li":
            return .text
        default:
            return .other
        }
    }

    private static func isTagHidden(attrs: [String: AttrValue]) -> Bool {
        if let dh = attrs["data-hidden"] {
            if !dh.hasValue || dh.value.lowercased() != "false" { return true }
        }
        if let h = attrs["hidden"] {
            if !h.hasValue || h.value.lowercased() != "false" { return true }
        }
        if let style = attrs["style"]?.value.lowercased() {
            let compact = style.replacingOccurrences(of: " ", with: "")
            if compact.contains("display:none") || compact.contains("visibility:hidden") {
                return true
            }
        }
        return false
    }

    private static func parseTagName(_ tag: String) -> String {
        let scalars = Array(tag.unicodeScalars)
        var i = 1
        var name = ""
        while i < scalars.count {
            let s = scalars[i]
            if CharacterSet.whitespacesAndNewlines.contains(s) || s == ">" || s == "/" { break }
            name.unicodeScalars.append(s)
            i += 1
        }
        return name.lowercased()
    }

    private static func parseRawAttributes(_ tag: String) -> [String: AttrValue] {
        var attributes: [String: AttrValue] = [:]
        let scalars = Array(tag.unicodeScalars)
        var i = 1
        func isSpace(_ s: Unicode.Scalar) -> Bool { CharacterSet.whitespacesAndNewlines.contains(s) }
        while i < scalars.count, !isSpace(scalars[i]), scalars[i] != ">", scalars[i] != "/" { i += 1 }
        while i < scalars.count {
            while i < scalars.count, isSpace(scalars[i]) || scalars[i] == "/" { i += 1 }
            guard i < scalars.count, scalars[i] != ">" else { break }
            var name = ""
            while i < scalars.count, !isSpace(scalars[i]), scalars[i] != "=", scalars[i] != ">", scalars[i] != "/" {
                name.unicodeScalars.append(scalars[i])
                i += 1
            }
            while i < scalars.count, isSpace(scalars[i]) { i += 1 }
            var value = ""
            var hasValue = false
            if i < scalars.count, scalars[i] == "=" {
                hasValue = true
                i += 1
                while i < scalars.count, isSpace(scalars[i]) { i += 1 }
                if i < scalars.count, scalars[i] == "\"" || scalars[i] == "'" {
                    let quote = scalars[i]
                    i += 1
                    while i < scalars.count, scalars[i] != quote {
                        value.unicodeScalars.append(scalars[i])
                        i += 1
                    }
                    if i < scalars.count { i += 1 }
                } else {
                    while i < scalars.count, !isSpace(scalars[i]), scalars[i] != ">" {
                        value.unicodeScalars.append(scalars[i])
                        i += 1
                    }
                }
            }
            if !name.isEmpty {
                attributes[name.lowercased()] = AttrValue(value: SlotScanner.decodeEntities(value), hasValue: hasValue)
            }
        }
        return attributes
    }

    private static func findMatchingClose(
        in html: String, tagName: String, from start: String.Index
    ) -> (openOfCloseTag: String.Index, afterCloseTag: String.Index)? {
        var depth = 1
        var cursor = start
        while let open = html[cursor...].firstIndex(of: "<") {
            guard let close = html[open...].firstIndex(of: ">") else { return nil }
            let raw = String(html[open...close])
            let next = html.index(after: close)
            cursor = next
            guard raw.count >= 3 else { continue }
            let second = raw[raw.index(after: raw.startIndex)]
            if second == "/" {
                let closingName = raw.dropFirst(2).dropLast()
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                if closingName == tagName {
                    depth -= 1
                    if depth == 0 {
                        return (open, next)
                    }
                }
            } else if second.isLetter {
                let nestedName = parseTagName(raw)
                let selfClosing = raw.dropLast().trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/") || voidTags.contains(nestedName)
                if nestedName == tagName, !selfClosing {
                    depth += 1
                }
            }
        }
        return nil
    }

    private static func firstImgSrc(in innerHTML: String) -> String? {
        var cursor = innerHTML.startIndex
        while let open = innerHTML[cursor...].firstIndex(of: "<") {
            guard let close = innerHTML[open...].firstIndex(of: ">") else { break }
            let raw = String(innerHTML[open...close])
            cursor = innerHTML.index(after: close)
            guard raw.count > 3, parseTagName(raw) == "img" else { continue }
            let attrs = parseRawAttributes(raw)
            if let src = attrs["src"]?.value, !src.isEmpty { return src }
        }
        return nil
    }

    private static func extractPlainText(from innerHTML: String) -> String {
        var result = ""
        var cursor = innerHTML.startIndex
        while let open = innerHTML[cursor...].firstIndex(of: "<") {
            result += SlotScanner.decodeEntities(String(innerHTML[cursor..<open]))
            guard let close = innerHTML[open...].firstIndex(of: ">") else {
                cursor = innerHTML.endIndex
                break
            }
            let tag = parseTagName(String(innerHTML[open...close]))
            if tag == "br" {
                result += "\n"
            }
            cursor = innerHTML.index(after: close)
        }
        if cursor < innerHTML.endIndex {
            result += SlotScanner.decodeEntities(String(innerHTML[cursor...]))
        }
        return result
    }

    private static func escapeHTMLText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func escapeAttribute(_ text: String) -> String {
        escapeHTMLText(text)
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
