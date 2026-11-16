import Foundation
import Observation
import StudioKit

/// A post as the search sees it (from `GET /api/contents?brandId=` for every brand).
struct SearchablePost: Equatable, Sendable {
    var contentId: EntityID
    var brandId: EntityID
    var title: String
    var caption: String
    var brief: String
    var updatedAt: Date

    init(contentId: EntityID, brandId: EntityID, title: String, caption: String, brief: String = "", updatedAt: Date) {
        self.contentId = contentId
        self.brandId = brandId
        self.title = title
        self.caption = caption
        self.brief = brief
        self.updatedAt = updatedAt
    }

    init(_ content: Content) {
        self.init(contentId: content.id, brandId: content.brandId, title: content.title, caption: content.caption, brief: content.brief, updatedAt: content.updatedAt)
    }
}

/// One row of the search palette.
enum SearchResult: Equatable {
    case brand(Brand)
    case conversation(Conversation)
    /// `snippet`: the caption around the match when the title itself did not match.
    case post(SearchablePost, snippet: String?)

    var id: String {
        switch self {
        case .brand(let brand): "brand:\(brand.id)"
        case .conversation(let conversation): "conversation:\(conversation.id)"
        case .post(let post, _): "post:\(post.contentId)"
        }
    }
}

/// Client-side search over the lists the API already serves (there is no search endpoint).
/// Case-, diacritic- and Turkish-dotless-i-insensitive; every word of the query must match.
enum GlobalSearch {
    static let brandLimit = 6
    static let conversationLimit = 12
    static let postLimit = 12
    static let recentConversations = 6

    /// "Kasım ŞENLİĞİ" -> "kasim senligi".
    static func normalize(_ text: String) -> String {
        text.lowercased(with: TurkishFormat.locale)
            .folding(options: [.diacriticInsensitive, .widthInsensitive], locale: TurkishFormat.locale)
            .replacingOccurrences(of: "ı", with: "i")
    }

    static func tokens(_ query: String) -> [String] {
        normalize(query).split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { !$0.isEmpty }
    }

    /// 0 = no match, 2 = some field starts with the first word, 1 = all words appear somewhere.
    static func score(_ fields: [String], tokens: [String]) -> Int {
        guard !tokens.isEmpty else { return 0 }
        let normalized = fields.map(normalize)
        let all = normalized.joined(separator: "\n")
        guard tokens.allSatisfy({ all.contains($0) }) else { return 0 }
        let prefix = normalized.contains { field in
            field.hasPrefix(tokens[0]) || field.contains(" " + tokens[0])
        }
        return prefix ? 2 : 1
    }

    static func results(
        query: String,
        brands: [Brand],
        conversations: [Conversation],
        posts: [SearchablePost],
        currentBrandId: EntityID? = nil
    ) -> [SearchResult] {
        let words = tokens(query)
        if words.isEmpty {
            // No query: the most recent conversations, as a jump list.
            return conversations
                .sorted { $0.lastActivityAt > $1.lastActivityAt }
                .prefix(recentConversations)
                .map(SearchResult.conversation)
        }

        let brandHits = brands
            .map { ($0, score([$0.name, $0.slug], tokens: words)) }
            .filter { $0.1 > 0 }
            .sorted { ($0.1, $1.0.name) > ($1.1, $0.0.name) }
            .prefix(brandLimit)
            .map { SearchResult.brand($0.0) }

        let conversationHits = conversations
            .map { ($0, score([$0.displayTitle], tokens: words)) }
            .filter { $0.1 > 0 }
            .sorted { a, b in a.1 != b.1 ? a.1 > b.1 : a.0.lastActivityAt > b.0.lastActivityAt }
            .prefix(conversationLimit)
            .map { SearchResult.conversation($0.0) }

        let postHits = posts
            .compactMap { post -> (SearchablePost, Int, String?)? in
                let titleScore = score([post.title], tokens: words)
                if titleScore > 0 { return (post, titleScore + 1, nil) }
                let bodyScore = score([post.title, post.caption, post.brief], tokens: words)
                guard bodyScore > 0 else { return nil }
                return (post, bodyScore - 1, snippet(post.caption.isEmpty ? post.brief : post.caption, around: words[0]))
            }
            .sorted { a, b in
                if a.1 != b.1 { return a.1 > b.1 }
                let aCurrent = a.0.brandId == currentBrandId, bCurrent = b.0.brandId == currentBrandId
                if aCurrent != bCurrent { return aCurrent }
                return a.0.updatedAt > b.0.updatedAt
            }
            .prefix(postLimit)
            .map { SearchResult.post($0.0, snippet: $0.2) }

        return brandHits + conversationHits + postHits
    }

    /// About `radius` characters on each side of the first match, on one line, with ellipses.
    static func snippet(_ text: String, around token: String, radius: Int = 36) -> String? {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        guard !flat.isEmpty else { return nil }
        // Normalising keeps one character per character for Turkish text, so offsets line up.
        let normalized = normalize(flat)
        guard normalized.count == flat.count, let range = normalized.range(of: token) else {
            return flat.count > radius * 2 ? String(flat.prefix(radius * 2)) + "…" : flat
        }
        let start = normalized.distance(from: normalized.startIndex, to: range.lowerBound)
        let from = max(0, start - radius)
        let to = min(flat.count, start + token.count + radius)
        let lower = flat.index(flat.startIndex, offsetBy: from)
        let upper = flat.index(flat.startIndex, offsetBy: to)
        var out = String(flat[lower..<upper]).trimmingCharacters(in: .whitespaces)
        if from > 0 { out = "…" + out }
        if to < flat.count { out += "…" }
        return out
    }
}

/// Loads every brand's posts for the palette, with loading and error state.
@MainActor
@Observable
final class SearchModel {
    weak var app: AppModel?
    private(set) var posts: [SearchablePost] = []
    private(set) var isLoadingPosts = false
    private(set) var postsError: String?
    private var loadedAt: Date?
    private var loadTask: Task<Void, Never>?
    /// Posts older than this are fetched again when the palette opens.
    var maxAge: TimeInterval = 60

    /// Called when the palette opens.
    func refreshIfStale(now: Date = Date()) {
        if let loadedAt, now.timeIntervalSince(loadedAt) < maxAge, postsError == nil { return }
        reload()
    }

    func reload() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    func load() async {
        guard let app else { return }
        let service = app.dataService
        let brandIds = app.brands.map(\.id)
        isLoadingPosts = true
        defer { isLoadingPosts = false }
        var collected: [SearchablePost] = []
        var failures = 0
        var lastError: (any Error)?
        await withTaskGroup(of: Result<[Content], any Error>.self) { group in
            for brandId in brandIds {
                group.addTask {
                    do { return .success(try await service.contents(brandId: brandId)) } catch { return .failure(error) }
                }
            }
            for await result in group {
                switch result {
                case .success(let contents): collected += contents.map(SearchablePost.init)
                case .failure(let error):
                    failures += 1
                    lastError = error
                }
            }
        }
        guard !Task.isCancelled else { return }
        posts = collected
        loadedAt = Date()
        if let lastError, failures > 0 {
            postsError = failures == brandIds.count
                ? "Postlar aranamıyor: \(AppModel.describe(lastError))"
                : "Bazı markaların postları yüklenemedi; sonuçlar eksik olabilir."
        } else {
            postsError = nil
        }
    }

    /// A post changed or was deleted elsewhere: drop the cache so the next open refetches.
    func invalidate() {
        loadedAt = nil
    }
}
