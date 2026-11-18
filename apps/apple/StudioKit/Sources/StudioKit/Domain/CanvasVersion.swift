import Foundation

/// A version saved from the Mac's design canvas (Wecra): its slides carry
/// `<meta name="studio:editor" content="wecra">` and, when the canvas document was imported
/// from an HTML version, `<meta name="studio:source-version" content="N">`
/// (`canvasOrigin` in apps/desktop/src/renderer/features/post-editor/wecra/slide-html.ts).
///
/// The real design lives in a `.wecra` document (S1): the slide HTML is the canvas render (plus
/// transparent layers that only describe it). The phone does not edit such a version layer by
/// layer, and an AI request about it goes the Mac's way — a message to the post's conversation,
/// where the agent edits the Wecra document with the canvas tools (`canvas_outline`,
/// `canvas_edit`) and the hand edits made on the canvas stay — never a `content.generate`
/// revision of its HTML.
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

    /// Shown when the phone has no conversation to send a canvas request to.
    public static let chatMissingNote = "Bu post Mac'teki tasarım tuvalinde düzenlendi; AI isteği sohbet üzerinden gider ama sohbet bağlantısı yok."

    /// The note the Mac puts in a request about a canvas version (`canvasNote` in
    /// apps/desktop/src/renderer/features/post-editor/chat.ts), word for word.
    public static func referenceNote(version: Int) -> String {
        "(v\(version) Mac'teki tasarım tuvalinde kaydedildi: tasarım bu sürümün Wecra belgesidir, tuvalde elle yapılan değişiklikler onda. Değişikliği canvas_outline ile okuyup canvas_edit ile yap; HTML'den yeniden üretme.)"
    }

    /// The post's line in every request (`postReference` in chat.ts, word for word): the post and
    /// its current version; for a canvas version, the note.
    public static func postReference(title: String, contentId: EntityID, version: Int?, canvas: Bool) -> String {
        let head = "“\(title)” postu (id: \(contentId)\(version.map { ", güncel sürüm v\($0)" } ?? "")) için:"
        guard canvas, let version else { return head }
        return "\(head)\n\(referenceNote(version: version))"
    }

    /// The "Neyi değiştireyim?" message for canvas version `version` of `content`: what the Mac's
    /// post chat sends (`postChatText`), the request after the post's line.
    public static func chatRequest(content: Content, version: Int, instruction: String) -> String {
        "\(postReference(title: content.title, contentId: content.id, version: version, canvas: true))\n\(instruction)"
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
