import Foundation

// Reels (P6): the editable description of a 1080×1920 video (`ReelSpec` in
// packages/contract/src/reel.ts). A reel version stores one slide whose
// `<main data-artboard>` carries the video and cover asset ids, the duration and
// `data-reel-spec-b64` (base64 UTF-8 JSON of the spec). Editing sends a `content.render`
// job with `format: "mp4"` and a `reel` patch; the worker re-renders without AI.

public enum ReelRecipe: String, Codable, Sendable, Hashable, CaseIterable {
    case motionGraphics = "motion_graphics"
    case footageEdit = "footage_edit"
    case narration

    public var label: String {
        switch self {
        case .motionGraphics: "Hareketli grafik"
        case .footageEdit: "Çekim kurgusu"
        case .narration: "Seslendirmeli"
        }
    }
}

public struct ReelScene: Codable, Sendable, Hashable {
    public var eyebrow: String
    public var headline: String
    public var subhead: String
    public var durationMs: Int

    public init(eyebrow: String = "", headline: String, subhead: String = "", durationMs: Int) {
        self.eyebrow = eyebrow
        self.headline = headline
        self.subhead = subhead
        self.durationMs = durationMs
    }
}

/// A timed text overlay burned into the video.
public struct ReelOverlay: Codable, Sendable, Hashable {
    public var text: String
    public var startMs: Int
    public var endMs: Int

    public init(text: String, startMs: Int, endMs: Int) {
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
    }
}

public struct ReelWord: Codable, Sendable, Hashable {
    public var word: String
    public var startMs: Int
    public var endMs: Int
}

public struct ReelSpec: Codable, Sendable, Hashable {
    public var recipe: ReelRecipe
    public var hook: String
    public var cta: String
    public var scenes: [ReelScene]
    public var overlays: [ReelOverlay]
    public var narrationScript: String
    public var words: [ReelWord]
    public var captions: Bool
    public var durationMs: Int
    public var clipAssetId: EntityID?
    public var audioAssetId: EntityID?
    public var heroAssetId: EntityID?
    public var voice: String?
    public var coverAtMs: Int?

    enum CodingKeys: String, CodingKey {
        case recipe, hook, cta, scenes, overlays, narrationScript, words, captions, durationMs
        case clipAssetId, audioAssetId, heroAssetId, voice, coverAtMs
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recipe = try c.decode(ReelRecipe.self, forKey: .recipe)
        hook = try c.decodeIfPresent(String.self, forKey: .hook) ?? ""
        cta = try c.decodeIfPresent(String.self, forKey: .cta) ?? ""
        scenes = try c.decodeIfPresent([ReelScene].self, forKey: .scenes) ?? []
        overlays = try c.decodeIfPresent([ReelOverlay].self, forKey: .overlays) ?? []
        narrationScript = try c.decodeIfPresent(String.self, forKey: .narrationScript) ?? ""
        words = try c.decodeIfPresent([ReelWord].self, forKey: .words) ?? []
        captions = try c.decodeIfPresent(Bool.self, forKey: .captions) ?? true
        durationMs = try c.decode(Int.self, forKey: .durationMs)
        clipAssetId = try c.decodeIfPresent(String.self, forKey: .clipAssetId)
        audioAssetId = try c.decodeIfPresent(String.self, forKey: .audioAssetId)
        heroAssetId = try c.decodeIfPresent(String.self, forKey: .heroAssetId)
        voice = try c.decodeIfPresent(String.self, forKey: .voice)
        coverAtMs = try c.decodeIfPresent(Int.self, forKey: .coverAtMs)
    }

    public init(recipe: ReelRecipe, hook: String = "", cta: String = "", scenes: [ReelScene] = [], overlays: [ReelOverlay] = [],
                narrationScript: String = "", captions: Bool = true, durationMs: Int) {
        self.recipe = recipe
        self.hook = hook
        self.cta = cta
        self.scenes = scenes
        self.overlays = overlays
        self.narrationScript = narrationScript
        self.words = []
        self.captions = captions
        self.durationMs = durationMs
    }
}

/// What a reel version's slide says about its video.
public struct ReelVersionInfo: Sendable, Hashable {
    public var videoAssetId: EntityID?
    public var coverAssetId: EntityID?
    public var durationMs: Int?
    public var recipe: ReelRecipe?
    public var spec: ReelSpec?

    public init(html: String) {
        func attr(_ name: String) -> String? {
            guard let range = html.range(of: " \(name)=\"") else { return nil }
            let rest = html[range.upperBound...]
            guard let end = rest.firstIndex(of: "\"") else { return nil }
            let value = String(rest[..<end])
            return value.isEmpty ? nil : value
        }
        videoAssetId = attr("data-video-asset-id")
        coverAssetId = attr("data-cover-asset-id")
        spec = attr("data-reel-spec-b64").flatMap { b64 in
            Data(base64Encoded: b64).flatMap { try? JSONDecoder().decode(ReelSpec.self, from: $0) }
        }
        durationMs = attr("data-duration-ms").flatMap(Int.init) ?? spec?.durationMs
        recipe = attr("data-reel-recipe").flatMap(ReelRecipe.init(rawValue:)) ?? spec?.recipe
    }

    public init(version: ContentVersion) {
        self.init(html: version.slides.first?.html ?? "")
        if coverAssetId == nil { coverAssetId = version.slides.first?.renderedAssetId }
    }

    public var hasVideo: Bool { videoAssetId != nil }
}

/// Platform duration rules for vertical video (`REEL_PLATFORM_LIMITS` in the contract).
public enum ReelLimits {
    public static let minMs = 3_000
    /// Longest reel Studio renders (Facebook Reels via API: 90 s).
    public static let maxRenderMs = 90_000

    public static func range(_ platform: Platform) -> ClosedRange<Int> {
        switch platform {
        case .facebook: 3_000...90_000
        case .linkedin: 3_000...(30 * 60_000)
        case .instagram, .unknown: 3_000...(15 * 60_000)
        }
    }

    static func label(_ platform: Platform) -> String {
        switch platform {
        case .instagram: "Instagram Reels"
        case .facebook: "Facebook Reels"
        case .linkedin: "LinkedIn video"
        case .unknown: "Reels"
        }
    }

    /// Turkish problems of `durationMs` on `platforms` (empty = fine everywhere).
    public static func issues(durationMs: Int, platforms: [Platform]) -> [String] {
        var seen = Set<Platform>()
        return platforms.compactMap { platform in
            guard seen.insert(platform).inserted else { return nil }
            let r = range(platform)
            if durationMs < r.lowerBound {
                return "\(label(platform)) en az \(TurkishFormat.duration(ms: r.lowerBound)) olmalı; bu video \(TurkishFormat.duration(ms: durationMs))."
            }
            if durationMs > r.upperBound {
                return "\(label(platform)) en fazla \(TurkishFormat.duration(ms: r.upperBound)) olabilir; bu video \(TurkishFormat.duration(ms: durationMs))."
            }
            return nil
        }
    }

    /// Longest reel Studio renders for `platforms`.
    public static func maxMs(_ platforms: [Platform]) -> Int {
        platforms.reduce(maxRenderMs) { min($0, range($1).upperBound) }
    }
}

extension TurkishFormat {
    /// `0:12`, `1:30` (video length).
    public static func clock(ms: Int) -> String {
        let total = max(0, Int((Double(ms) / 1000).rounded()))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    /// `12 sn`, `1,5 sn`, `15 dk`.
    public static func duration(ms: Int) -> String {
        if ms >= 60_000, ms % 60_000 == 0 { return "\(ms / 60_000) dk" }
        let s = Double(ms) / 1000
        if s == s.rounded() { return "\(Int(s)) sn" }
        return String(format: "%.1f", s).replacingOccurrences(of: ".", with: ",") + " sn"
    }
}

/// The reel editor's working copy: texts and timings the user changes, validated, and
/// turned into the `reel` patch of a `content.render` job (only what changed).
public struct ReelDraft: Sendable, Hashable {
    public let base: ReelSpec
    public var hook: String
    public var cta: String
    public var scenes: [ReelScene]
    public var overlays: [ReelOverlay]
    public var narrationScript: String
    public var captions: Bool
    /// Footage length (only `footage_edit` sets it directly).
    public var durationMs: Int

    /// Closing card length the worker adds to motion graphics with a CTA.
    public static let ctaMs = 1_800

    public init(_ spec: ReelSpec) {
        base = spec
        hook = spec.hook
        cta = spec.cta
        scenes = spec.scenes
        overlays = spec.overlays
        narrationScript = spec.narrationScript
        captions = spec.captions
        durationMs = spec.durationMs
    }

    /// Length of the video this draft renders (narration: until the new voice is measured).
    public var totalMs: Int {
        switch base.recipe {
        case .motionGraphics:
            let sum = scenes.reduce(0) { $0 + $1.durationMs } + (cta.trimmingCharacters(in: .whitespaces).isEmpty ? 0 : Self.ctaMs)
            return max(ReelLimits.minMs, sum)
        case .footageEdit: return durationMs
        case .narration: return base.durationMs
        }
    }

    /// Duration of the scenes can be edited (motion graphics); footage edits the total.
    public var editsSceneDurations: Bool { base.recipe == .motionGraphics }
    public var editsTotalDuration: Bool { base.recipe == .footageEdit }
    public var editsScript: Bool { base.recipe == .narration }

    public var isDirty: Bool { patch != nil }

    /// Problems that block re-rendering (Turkish).
    public var problems: [String] {
        var out: [String] = []
        if base.recipe == .motionGraphics {
            if scenes.isEmpty { out.append("En az bir sahne gerekli.") }
            for (i, s) in scenes.enumerated() {
                if s.headline.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("Sahne \(i + 1): başlık boş.") }
                if s.durationMs < 800 || s.durationMs > 20_000 { out.append("Sahne \(i + 1): süre 0,8–20 sn olmalı.") }
            }
        }
        for (i, o) in overlays.enumerated() {
            if o.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("Metin \(i + 1): boş.") }
            if o.endMs <= o.startMs { out.append("Metin \(i + 1): bitiş başlangıçtan sonra olmalı.") }
            if o.startMs >= totalMs { out.append("Metin \(i + 1): video bittikten sonra başlıyor.") }
        }
        if base.recipe == .narration, narrationScript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("Seslendirme metni boş.")
        }
        if totalMs < ReelLimits.minMs { out.append("Video en az 3 sn olmalı.") }
        if totalMs > ReelLimits.maxRenderMs { out.append("Video en fazla 90 sn olabilir.") }
        if hook.count > 140 { out.append("Kanca en fazla 140 karakter.") }
        if cta.count > 100 { out.append("Kapanış en fazla 100 karakter.") }
        return out
    }

    /// The `reel` patch (nil when nothing changed).
    public var patch: JSONObject? {
        var p: JSONObject = [:]
        let trimmedHook = hook.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCta = cta.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedHook != base.hook { p["hook"] = .string(trimmedHook) }
        if trimmedCta != base.cta { p["cta"] = .string(trimmedCta) }
        if scenes != base.scenes {
            p["scenes"] = .array(scenes.map { s in
                .object([
                    "eyebrow": .string(s.eyebrow), "headline": .string(s.headline.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "subhead": .string(s.subhead), "durationMs": .number(Double(s.durationMs)),
                ])
            })
        }
        if overlays != base.overlays {
            p["overlays"] = .array(overlays.map { o in
                .object(["text": .string(o.text.trimmingCharacters(in: .whitespacesAndNewlines)), "startMs": .number(Double(o.startMs)), "endMs": .number(Double(o.endMs))])
            })
        }
        if narrationScript.trimmingCharacters(in: .whitespacesAndNewlines) != base.narrationScript.trimmingCharacters(in: .whitespacesAndNewlines) {
            p["narrationScript"] = .string(narrationScript.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if captions != base.captions { p["captions"] = .bool(captions) }
        if base.recipe == .footageEdit, durationMs != base.durationMs { p["durationMs"] = .number(Double(durationMs)) }
        return p.isEmpty ? nil : p
    }

    public mutating func addOverlay() {
        let start = min(overlays.last.map { $0.endMs } ?? 2_400, max(0, totalMs - 1_000))
        overlays.append(ReelOverlay(text: "Yeni metin", startMs: start, endMs: min(totalMs, start + 2_500)))
    }

    public mutating func addScene() {
        scenes.append(ReelScene(headline: "Yeni sahne", durationMs: 2_500))
    }
}

extension ContentRenderRequest {
    /// `content.render` that re-renders a reel from `version` with the editor's `patch`.
    public static func reel(version: Int?, patch: JSONObject?, note: String? = nil) -> ContentRenderRequest {
        ContentRenderRequest(version: version, format: .mp4, note: note, reel: patch)
    }
}

extension APIClient {
    /// Re-render a reel with editor changes (`content.render`, `format: "mp4"`, `reel` patch).
    public func renderReel(contentId: EntityID, version: Int?, patch: JSONObject?) async throws(StudioAPIError) -> Job {
        try await renderContent(contentId: contentId, .reel(version: version, patch: patch))
    }
}
