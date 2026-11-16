import Foundation
import StudioKit

/// Pure helpers behind the profile editor: the editable rows of `brand.json`
/// tokens, the facts list (`tokens.facts`) and their validation. No AppKit, so
/// the rules are unit-tested directly.
enum ProfileTokens {
    enum Kind: Equatable {
        case color
        case text
        case number
    }

    /// One editable scalar of the tokens (`color.accent.value`, `font.display.family`, `space.margin`).
    struct Row: Equatable, Identifiable {
        var path: [String]
        var label: String
        var group: String
        var kind: Kind
        var value: String
        var note: String?

        var id: String { path.joined(separator: ".") }
    }

    private static let groupOrder = ["Renkler", "Yazı tipleri", "Boşluk", "Köşeler"]

    /// The rows the editor shows, in a stable order: colours, fonts, spacing, radii.
    static func rows(_ tokens: JSONObject) -> [Row] {
        var rows: [Row] = []
        if case .object(let colors)? = tokens["color"] {
            for name in orderedKeys(colors.keys, preferred: ["paper", "mist", "ink", "graphite", "stone", "line", "accent", "accent-deep"]) {
                switch colors[name] {
                case .string(let hex)?:
                    rows.append(Row(path: ["color", name], label: name, group: "Renkler", kind: .color, value: hex))
                case .object(let entry)?:
                    if case .string(let hex)? = entry["value"] {
                        rows.append(Row(path: ["color", name, "value"], label: name, group: "Renkler", kind: .color, value: hex, note: entry["use"]?.stringValue))
                    }
                default: break
                }
            }
        }
        if case .object(let fonts)? = tokens["font"] {
            for role in orderedKeys(fonts.keys, preferred: ["display", "text"]) {
                guard case .object(let entry)? = fonts[role] else { continue }
                let roleLabel = role == "display" ? "Başlık" : role == "text" ? "Gövde" : role
                if case .string(let family)? = entry["family"] {
                    let files = entry["files"].flatMap { if case .array(let a) = $0 { a.count } else { nil } } ?? 0
                    rows.append(Row(
                        path: ["font", role, "family"], label: "\(roleLabel) ailesi", group: "Yazı tipleri", kind: .text, value: family,
                        note: files > 0 ? "\(files) dosya" : "Dosya yok, sistem fontu"
                    ))
                }
                if case .string(let license)? = entry["license"] {
                    rows.append(Row(path: ["font", role, "license"], label: "\(roleLabel) lisansı", group: "Yazı tipleri", kind: .text, value: license))
                }
            }
        }
        if case .object(let space)? = tokens["space"] {
            let labels = ["margin": "Kenar boşluğu", "gutter": "Aralık", "unit": "Birim", "columns": "Sütun"]
            for key in ["margin", "gutter", "unit", "columns"] {
                if case .number(let value)? = space[key] {
                    rows.append(Row(path: ["space", key], label: labels[key] ?? key, group: "Boşluk", kind: .number, value: format(value), note: key == "columns" ? nil : "px"))
                }
            }
        }
        if case .object(let radius)? = tokens["radius"] {
            for key in orderedKeys(radius.keys, preferred: ["sm", "md", "lg", "pill"]) {
                if case .number(let value)? = radius[key] {
                    rows.append(Row(path: ["radius", key], label: key, group: "Köşeler", kind: .number, value: format(value), note: "px"))
                }
            }
        }
        return rows.sorted { (groupOrder.firstIndex(of: $0.group) ?? 9) < (groupOrder.firstIndex(of: $1.group) ?? 9) }
    }

    /// nil when `value` is acceptable for the row's kind, else a Turkish reason.
    static func problem(kind: Kind, value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .color:
            return BrandKitRules.normalizedHex(trimmed) == nil ? "Renk #RRGGBB biçiminde olmalı." : nil
        case .number:
            guard let number = Double(trimmed.replacingOccurrences(of: ",", with: ".")), number >= 0, number <= 2000 else {
                return "0 ile 2000 arasında bir sayı girin."
            }
            return nil
        case .text:
            return trimmed.isEmpty ? "Boş bırakılamaz." : nil
        }
    }

    /// Tokens with `row`'s path set to `value` (normalised). Throws the Turkish reason when invalid.
    static func setting(_ tokens: JSONObject, path: [String], kind: Kind, value: String) throws(ProfileEditError) -> JSONObject {
        if let reason = problem(kind: kind, value: value) { throw ProfileEditError(message: reason) }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        let json: JSONValue = switch kind {
        case .color: .string(BrandKitRules.normalizedHex(trimmed) ?? trimmed)
        case .number: .number(Double(trimmed.replacingOccurrences(of: ",", with: ".")) ?? 0)
        case .text: .string(trimmed)
        }
        if path.first == "font", path.last == "family", !BrandKitRules.isValidFamily(trimmed) {
            throw ProfileEditError(message: "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir.")
        }
        return set(tokens, path[...], json)
    }

    private static func set(_ object: JSONObject, _ path: ArraySlice<String>, _ value: JSONValue) -> JSONObject {
        guard let head = path.first else { return object }
        var copy = object
        if path.count == 1 {
            copy[head] = value
        } else {
            let child: JSONObject = if case .object(let existing)? = object[head] { existing } else { [:] }
            copy[head] = .object(set(child, path.dropFirst(), value))
        }
        return copy
    }

    private static func orderedKeys(_ keys: Dictionary<String, JSONValue>.Keys, preferred: [String]) -> [String] {
        let known = preferred.filter { keys.contains($0) }
        return known + keys.filter { !preferred.contains($0) }.sorted()
    }

    /// Valid design-kit tokens for a blank draft: neutral colours (overridden by the kit's
    /// palette), system fonts (or the kit's families), spacing and radii.
    static func starter(kit: BrandKit?, brand: Brand?) -> JSONObject {
        var colors: JSONObject = [:]
        let neutral: [(String, String, String)] = [
            ("paper", "#FFFFFF", "zemin"), ("mist", "#F1F1EE", "ikincil zemin"), ("ink", "#151515", "başlık"),
            ("graphite", "#2E2E2E", "gövde metni"), ("stone", "#666666", "ikincil metin"), ("line", "#D9D9D6", "çizgiler"),
            ("accent", "#2F5D50", "tek vurgu"), ("accent-deep", "#22453B", "koyu vurgu"),
        ]
        for (name, hex, use) in neutral { colors[name] = .object(["value": .string(hex), "use": .string(use)]) }
        for color in kit?.palette ?? [] {
            var entry: JSONObject = ["value": .string(color.hex)]
            if let use = color.use { entry["use"] = .string(use) }
            colors[color.name] = .object(entry)
        }
        let display = kit?.fonts.first { $0.role != .text }?.family ?? "Helvetica Neue"
        let text = kit?.fonts.first { $0.role != .display }?.family ?? "Helvetica Neue"
        func font(_ family: String, weight: Double, leading: Double) -> JSONValue {
            .object([
                "family": .string(family), "files": .array([]), "fallback": .string("sans-serif"),
                "default": .object(["weight": .number(weight), "leading": .number(leading)]),
            ])
        }
        var tokens: JSONObject = [
            "status": .string("provisional"),
            "color": .object(colors),
            "font": .object(["display": font(display, weight: 800, leading: 1.0), "text": font(text, weight: 400, leading: 1.38)]),
            "space": .object([
                "unit": .number(8), "margin": .number(72), "gutter": .number(24), "columns": .number(6),
                "scale": .array([8, 16, 24, 32, 48, 64, 72, 96, 128, 160].map { .number(Double($0)) }),
            ]),
            "radius": .object(["sm": .number(8), "md": .number(16), "lg": .number(32), "pill": .number(999)]),
            "usage": .object([
                "background": .string("paper"), "text": .string("ink"), "accent": .string("accent"), "muted": .string("stone"),
                "slotFill": .string("mist"), "slotInk": .string("accent-deep"), "textFont": .string("text"), "displayFont": .string("display"),
            ]),
            "facts": .object(["allowedNumbers": .array([]), "statements": .array([]), "forbidden": .array([])]),
        ]
        if let brand {
            tokens["id"] = .string(brand.slug)
            tokens["name"] = .string(brand.name)
        }
        return tokens
    }

    static func format(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }
}

struct ProfileEditError: Error, Equatable {
    var message: String
}

/// `tokens.facts`: numbers the generator may use, true statements and claims to avoid.
struct ProfileFacts: Equatable {
    var allowedNumbers: [String] = []
    var statements: [String] = []
    var forbidden: [String] = []

    init(allowedNumbers: [String] = [], statements: [String] = [], forbidden: [String] = []) {
        self.allowedNumbers = allowedNumbers
        self.statements = statements
        self.forbidden = forbidden
    }

    init(tokens: JSONObject) {
        guard case .object(let facts)? = tokens["facts"] else { return }
        allowedNumbers = Self.strings(facts["allowedNumbers"])
        statements = Self.strings(facts["statements"])
        forbidden = Self.strings(facts["forbidden"])
    }

    /// Tokens with these facts written back (other keys of `facts` are kept).
    func applied(to tokens: JSONObject) -> JSONObject {
        var copy = tokens
        var facts: JSONObject = if case .object(let existing)? = tokens["facts"] { existing } else { [:] }
        facts["allowedNumbers"] = .array(allowedNumbers.map { .string($0) })
        facts["statements"] = .array(statements.map { .string($0) })
        facts["forbidden"] = .array(forbidden.map { .string($0) })
        copy["facts"] = .object(facts)
        return copy
    }

    /// `"10, 6132 ; %20"` → `["10", "6132", "%20"]` (commas, semicolons, new lines; duplicates dropped).
    static func numbers(from text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// One item per line, blank lines dropped.
    static func lines(from text: String) -> [String] {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func strings(_ value: JSONValue?) -> [String] {
        guard case .array(let items)? = value else { return [] }
        return items.compactMap {
            switch $0 {
            case .string(let s): s
            case .number(let n): ProfileTokens.format(n)
            default: nil
            }
        }
    }
}

/// What the editor holds for one profile version.
struct ProfileDraft: Equatable {
    var tokens: JSONObject
    var designRules: String
    var voice: String

    init(tokens: JSONObject = [:], designRules: String = "", voice: String = "") {
        self.tokens = tokens
        self.designRules = designRules
        self.voice = voice
    }

    init(_ profile: BrandProfile) {
        self.init(tokens: profile.tokens, designRules: profile.designRules, voice: profile.voice)
    }

    var facts: ProfileFacts {
        get { ProfileFacts(tokens: tokens) }
        set { tokens = newValue.applied(to: tokens) }
    }

    func differs(from profile: BrandProfile) -> Bool {
        self != ProfileDraft(profile)
    }

    /// `tokens.status` is `provisional` when the analysis had thin evidence.
    var isProvisional: Bool { tokens["status"]?.stringValue == "provisional" }
}
