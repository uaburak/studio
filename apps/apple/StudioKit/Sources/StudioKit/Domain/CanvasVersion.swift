import Foundation

/// A version saved from the Mac's design canvas (Wecra): its slides carry
/// `<meta name="studio:editor" content="wecra">` and, when the canvas document was imported
/// from an HTML version, `<meta name="studio:source-version" content="N">`
/// (`canvasOrigin` in apps/desktop/src/renderer/features/post-editor/wecra/slide-html.ts).
///
/// The real design lives in a `.wecra` document only the Mac can edit; the slide HTML is the
/// canvas render (plus, possibly, transparent layers that only describe it). The phone must not
/// edit such a version layer by layer, and an AI request must not use it as the design to revise.
public struct CanvasOrigin: Sendable, Hashable {
    /// The HTML version the canvas document was imported from (the AI edits from there).
    public var sourceVersion: Int?

    public init(sourceVersion: Int?) {
        self.sourceVersion = sourceVersion
    }

    /// nil when the slide is not a canvas render.
    public init?(html: String) {
        let metas = Self.metaTags(in: html)
        guard metas["studio:editor"]?.lowercased() == "wecra" else { return nil }
        sourceVersion = metas["studio:source-version"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 > 0 ? $0 : nil }
    }

    /// nil when no slide of the version is a canvas render.
    public init?(version: ContentVersion) {
        let origins = version.slides.compactMap { CanvasOrigin(html: $0.html) }
        guard let first = origins.first else { return nil }
        sourceVersion = origins.lazy.compactMap(\.sourceVersion).first ?? first.sourceVersion
    }

    /// Shown where the phone would edit the design (layers, slots, pictures).
    public static let editNote = "Bu post Mac'teki tasarım tuvalinde düzenlendi; tasarımı Mac'te düzenleyebilirsin."

    /// The line the Mac puts in front of an AI request about a canvas version (`postReference`
    /// in apps/desktop/src/renderer/features/post-editor/chat.ts), word for word.
    public func referenceNote(version: Int) -> String {
        let how = sourceVersion.map { " Metin ve katman değişikliklerini v\($0) HTML'si üzerinden yap;" } ?? " Değişikliği yeni bir HTML sürümüyle yap;"
        return "(v\(version) tuvalde, Wecra ile düzenlendi: kareleri Wecra'nın render'ı; HTML'de render en altta, metinler, görsel yuvaları ve logolar üstünde görünmez katmanlar, tüm katmanlar studio:canvas bilgisinde.\(how) yeni sürüm tuvale yeniden aktarılır.)"
    }

    /// The "Neyi değiştireyim?" request for canvas version `version`: the same note the Mac
    /// writes, and the HTML version it points at as the base (never the canvas render itself).
    /// Without a source version there is no HTML design to revise: no base, a new HTML version.
    public func revisionRequest(version: Int, instruction: String) -> (baseVersion: Int?, instructions: String) {
        let base = sourceVersion.flatMap { $0 != version ? $0 : nil }
        return (base, "\(referenceNote(version: version))\n\(instruction)")
    }

    // MARK: - Meta tags

    private static let metaPattern = try! NSRegularExpression(pattern: "<meta\\b[^>]*>", options: [.caseInsensitive])
    private static let attributePattern = try! NSRegularExpression(
        pattern: "([a-zA-Z_:][-a-zA-Z0-9_:.]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", options: [])

    /// `name -> content` of the document's `<meta name content>` tags (first one wins).
    static func metaTags(in html: String) -> [String: String] {
        guard html.range(of: "studio:", options: .caseInsensitive) != nil else { return [:] }
        // Meta tags live in the head; the body (layers, inline pictures) can be long.
        let head = html.range(of: "</head>", options: .caseInsensitive).map { String(html[..<$0.lowerBound]) } ?? html
        let ns = head as NSString
        let html = head
        var result: [String: String] = [:]
        for match in metaPattern.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let tag = ns.substring(with: match.range)
            let tagNS = tag as NSString
            var attributes: [String: String] = [:]
            for attribute in attributePattern.matches(in: tag, range: NSRange(location: 0, length: tagNS.length)) {
                let key = tagNS.substring(with: attribute.range(at: 1)).lowercased()
                let value = (2...4).lazy
                    .map { attribute.range(at: $0) }
                    .first { $0.location != NSNotFound }
                    .map { tagNS.substring(with: $0) } ?? ""
                attributes[key] = value
            }
            if let name = attributes["name"]?.lowercased(), let content = attributes["content"], result[name] == nil {
                result[name] = content
            }
        }
        return result
    }
}

extension ContentVersion {
    /// Saved from the Mac's design canvas (see `CanvasOrigin`).
    public var canvasOrigin: CanvasOrigin? { CanvasOrigin(version: self) }
    public var isCanvasVersion: Bool { canvasOrigin != nil }
}

extension PostCard {
    /// The card's current version was saved from the Mac's design canvas.
    public var isCanvasVersion: Bool { version?.isCanvasVersion ?? false }
}
