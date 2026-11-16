import Foundation

// Attachment aliases and @mentions: a port of packages/contract/src/chat-alias.ts.

/// An attachment alias of a conversation (`image`, `image-1`, ...).
public struct ConversationAlias: Codable, Sendable, Hashable, Identifiable {
    /// Stable id; survives renames. Mentions and attachment parts carry it.
    public var id: EntityID
    public var conversationId: EntityID
    /// Current name.
    public var alias: String
    /// Earlier names, oldest first. They still resolve and are never reused.
    public var previousAliases: [String]
    public var assetId: EntityID
    public var kind: AssetKind
    public var mimeType: String
    public var width: Int?
    public var height: Int?
    public var filename: String?
    /// Path that streams the file on the API origin.
    public var contentPath: String
    public var messageId: EntityID?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: EntityID, conversationId: EntityID, alias: String, previousAliases: [String] = [], assetId: EntityID,
        kind: AssetKind = .image, mimeType: String, width: Int? = nil, height: Int? = nil, filename: String? = nil,
        messageId: EntityID? = nil, createdAt: Date, updatedAt: Date
    ) {
        self.id = id
        self.conversationId = conversationId
        self.alias = alias
        self.previousAliases = previousAliases
        self.assetId = assetId
        self.kind = kind
        self.mimeType = mimeType
        self.width = width
        self.height = height
        self.filename = filename
        self.contentPath = "/api/assets/\(assetId)/content"
        self.messageId = messageId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One resolved `@alias` in a user message's text. `start` / `end` are UTF-16
/// offsets into the text part (`end` exclusive), covering `@` and the name.
public struct MessageMention: Codable, Sendable, Hashable {
    /// The name as written (lower-cased); may be an older name of the alias.
    public var alias: String
    public var aliasId: EntityID
    public var assetId: EntityID
    public var start: Int
    public var end: Int

    public init(alias: String, aliasId: EntityID, assetId: EntityID, start: Int, end: Int) {
        self.alias = alias
        self.aliasId = aliasId
        self.assetId = assetId
        self.start = start
        self.end = end
    }
}

/// Alias rules shared by the composer, the sample service and the wire format.
public enum ImageAlias {
    public static let base = "image"
    public static let maxLength = 40

    /// `^[a-z](?:[a-z0-9-]*[a-z0-9])?$`, at most 40 characters.
    public static func isValid(_ alias: String) -> Bool {
        guard !alias.isEmpty, alias.count <= maxLength else { return false }
        let scalars = Array(alias.unicodeScalars)
        guard let first = scalars.first, ("a"..."z").contains(first) else { return false }
        guard let last = scalars.last, last != "-" else { return false }
        return scalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// Best-effort conversion of user input to a valid alias (`Tarla Fotoğrafı` -> `tarla-fotografi`).
    public static func normalize(_ input: String) -> String {
        let folded = input
            .replacingOccurrences(of: "ı", with: "i").replacingOccurrences(of: "İ", with: "i")
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: TurkishFormat.locale)
            .lowercased()
        var out = ""
        var lastWasHyphen = true
        for scalar in folded.unicodeScalars {
            if ("a"..."z").contains(scalar) || (("0"..."9").contains(scalar) && !out.isEmpty) {
                out.unicodeScalars.append(scalar)
                lastWasHyphen = false
            } else if !lastWasHyphen {
                out += "-"
                lastWasHyphen = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(maxLength))
    }

    /// Automatic aliases: index 0 -> `image`, k -> `image-k`.
    public static func automatic(_ index: Int, base: String = base) -> String {
        index == 0 ? base : "\(base)-\(index)"
    }

    /// The automatic index an alias occupies (`image` -> 0, `image-3` -> 3), if any.
    public static func automaticIndex(of alias: String, base: String = base) -> Int? {
        if alias == base { return 0 }
        guard alias.hasPrefix(base + "-"), let n = Int(alias.dropFirst(base.count + 1)), n > 0 else { return nil }
        return n
    }
}

/// Hands out draft aliases for one conversation before they are sent.
///
/// Knows every name the conversation ever used (current and previous names
/// of its aliases plus the drafts), so a requested alias never collides and
/// automatic numbering only moves forward.
public struct AliasAllocator: Sendable, Equatable {
    /// Next automatic index to try.
    public private(set) var nextIndex: Int
    /// Names taken in the conversation (sent aliases, their old names, drafts).
    public private(set) var used: Set<String>

    public init(existing: some Sequence<String> = []) {
        used = Set(existing)
        nextIndex = used.compactMap { ImageAlias.automaticIndex(of: $0) }.map { $0 + 1 }.max() ?? 0
    }

    public init(aliases: [ConversationAlias]) {
        self.init(existing: aliases.flatMap { [$0.alias] + $0.previousAliases })
    }

    public mutating func next() -> String {
        while used.contains(ImageAlias.automatic(nextIndex)) { nextIndex += 1 }
        let alias = ImageAlias.automatic(nextIndex)
        nextIndex += 1
        used.insert(alias)
        return alias
    }

    public func isAvailable(_ alias: String) -> Bool {
        ImageAlias.isValid(alias) && !used.contains(alias)
    }

    public enum RenameError: Error, Equatable {
        case invalid, taken
    }

    /// Rename a draft's alias; the automatic counter is not rewound.
    public mutating func rename(_ old: String, to new: String) throws(RenameError) {
        if old == new { return }
        guard ImageAlias.isValid(new) else { throw .invalid }
        guard !used.contains(new) else { throw .taken }
        used.remove(old)
        used.insert(new)
        if let index = ImageAlias.automaticIndex(of: new), index >= nextIndex { nextIndex = index + 1 }
    }

    /// Learn names that appeared later (e.g. from the stream).
    public mutating func register(_ aliases: [ConversationAlias]) {
        for alias in aliases {
            for name in [alias.alias] + alias.previousAliases {
                used.insert(name)
                if let index = ImageAlias.automaticIndex(of: name), index >= nextIndex { nextIndex = index + 1 }
            }
        }
    }

    /// A removed draft frees its name for renames; its number is not handed out again.
    public mutating func release(_ alias: String) {
        used.remove(alias)
    }
}

/// `@name` tokens in text (`scanAliasTokens` / `resolveAliasMentions`).
public enum MentionText {
    /// A candidate token: lower-cased name, UTF-16 range of `@name`.
    public struct Token: Sendable, Equatable {
        public var alias: String
        public var start: Int
        public var end: Int
    }

    /// What resolution needs to know about an alias.
    public struct Target: Sendable, Equatable {
        public var id: EntityID
        public var alias: String
        public var previousAliases: [String]
        public var assetId: EntityID

        public init(id: EntityID, alias: String, previousAliases: [String] = [], assetId: EntityID) {
            self.id = id
            self.alias = alias
            self.previousAliases = previousAliases
            self.assetId = assetId
        }

        public init(_ alias: ConversationAlias) {
            self.init(id: alias.id, alias: alias.alias, previousAliases: alias.previousAliases, assetId: alias.assetId)
        }
    }

    /// Before `@`, these make it part of a word (e-mail, handle, URL).
    static func isWordBefore(_ unit: UInt16) -> Bool {
        if let scalar = Unicode.Scalar(unit), isLetterNumberMark(scalar) { return true }
        return "_.+-@/\\=&%#~".utf16.contains(unit)
    }

    /// After the name, these mean the token goes on (a different word).
    static func isWordAfter(_ unit: UInt16) -> Bool {
        if let scalar = Unicode.Scalar(unit), isLetterNumberMark(scalar) { return true }
        return unit == UInt16(UInt8(ascii: "_"))
    }

    public static func isNameChar(_ unit: UInt16) -> Bool {
        (0x41...0x5A).contains(unit) || (0x61...0x7A).contains(unit) || (0x30...0x39).contains(unit) || unit == 0x2D
    }

    private static func isLetterNumberMark(_ scalar: Unicode.Scalar) -> Bool {
        CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
            || CharacterSet.nonBaseCharacters.contains(scalar) || scalar.properties.numericType != nil
    }

    /// Find `@name` tokens exactly like the server does.
    public static func scanTokens(_ text: String) -> [Token] {
        let units = Array(text.utf16)
        var out: [Token] = []
        var i = 0
        let at = UInt16(UInt8(ascii: "@"))
        let hyphen = UInt16(UInt8(ascii: "-"))
        while i < units.count {
            guard let found = units[i...].firstIndex(of: at) else { break }
            i = found + 1
            if found > 0 && isWordBefore(units[found - 1]) { continue }
            var j = found + 1
            while j < units.count && isNameChar(units[j]) { j += 1 }
            var end = j
            while end > found + 1 && units[end - 1] == hyphen { end -= 1 }
            let name = String(decoding: units[(found + 1)..<end], as: UTF16.self).lowercased()
            i = j
            guard !name.isEmpty, name.count <= ImageAlias.maxLength,
                  let first = name.unicodeScalars.first, ("a"..."z").contains(first) else { continue }
            if end == j && j < units.count && isWordAfter(units[j]) { continue }
            out.append(Token(alias: name, start: found, end: end))
        }
        return out
    }

    /// Resolve tokens against aliases (current and previous names). Unknown names stay plain text.
    public static func resolve(_ text: String, aliases: [Target]) -> [MessageMention] {
        var byName: [String: Target] = [:]
        for target in aliases {
            for old in target.previousAliases where byName[old] == nil { byName[old] = target }
        }
        for target in aliases { byName[target.alias] = target }
        return scanTokens(text).compactMap { token in
            guard let target = byName[token.alias] else { return nil }
            return MessageMention(alias: token.alias, aliasId: target.id, assetId: target.assetId, start: token.start, end: token.end)
        }
    }

    public enum Segment: Sendable, Equatable {
        case text(String)
        /// A mention, with the alias it resolves to.
        case mention(MessageMention)
    }

    /// Split `text` at `mentions` (UTF-16 ranges); invalid ranges are ignored.
    public static func segments(_ text: String, mentions: [MessageMention]) -> [Segment] {
        let units = Array(text.utf16)
        var segments: [Segment] = []
        var cursor = 0
        for mention in mentions.sorted(by: { $0.start < $1.start }) {
            guard mention.start >= cursor, mention.end <= units.count, mention.start < mention.end else { continue }
            if mention.start > cursor {
                segments.append(.text(String(decoding: units[cursor..<mention.start], as: UTF16.self)))
            }
            segments.append(.mention(mention))
            cursor = mention.end
        }
        if cursor < units.count {
            segments.append(.text(String(decoding: units[cursor...], as: UTF16.self)))
        }
        return segments
    }

    /// The `@query` being typed right before `cursor` (a UTF-16 offset), for autocomplete.
    public static func activeQuery(in text: String, cursor: Int) -> (start: Int, query: String)? {
        let units = Array(text.utf16)
        guard cursor <= units.count else { return nil }
        var i = cursor - 1
        while i >= 0 && isNameChar(units[i]) { i -= 1 }
        guard i >= 0, units[i] == UInt16(UInt8(ascii: "@")) else { return nil }
        if i > 0 && isWordBefore(units[i - 1]) { return nil }
        let query = String(decoding: units[(i + 1)..<cursor], as: UTF16.self).lowercased()
        return (i, query)
    }
}

/// An attachment the user sends with a message.
public struct OutgoingAttachment: Sendable, Equatable, Hashable {
    public var assetId: EntityID
    /// Requested alias; nil lets the server pick the next free one.
    public var alias: String?

    public init(assetId: EntityID, alias: String?) {
        self.assetId = assetId
        self.alias = alias
    }
}

/// A user message as the composer produces it. `text` carries mentions as `@alias`.
public struct OutgoingMessage: Sendable, Equatable {
    public var text: String
    public var attachments: [OutgoingAttachment]
    /// Idempotency key; keep it when retrying the same send.
    public var clientMessageId: String
    /// Model / effort for the turn; nil = worker default.
    public var model: AgentModel?
    public var effort: AgentEffort?

    public init(
        text: String, attachments: [OutgoingAttachment] = [], clientMessageId: String = UUID().uuidString,
        model: AgentModel? = nil, effort: AgentEffort? = nil
    ) {
        self.text = text
        self.attachments = attachments
        self.clientMessageId = clientMessageId
        self.model = model
        self.effort = effort
    }
}
