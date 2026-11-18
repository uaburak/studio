import Foundation

/// `studio://open/...`: where a widget tap (N22) or a share-sheet "Studio'da aç" leads the app.
/// (`studio://pair?...` is the pairing link, `PairingInvite`.)
public enum StudioLink: Sendable, Hashable {
    /// Posts waiting for approval (the brand's "Hazır" filter).
    case approvals(brandId: EntityID?)
    case post(EntityID)
    case calendar(brandId: EntityID?)
    /// Posts whose publishing failed (the brand's "Hata" filter).
    case failures(brandId: EntityID?)
    case media(brandId: EntityID?)
    case products(brandId: EntityID?)
    case conversation(EntityID)

    public static let scheme = "studio"
    public static let host = "open"

    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        var brand: EntityID?
        switch self {
        case .approvals(let id): components.path = "/approvals"; brand = id
        case .post(let id): components.path = "/post/\(id)"
        case .calendar(let id): components.path = "/calendar"; brand = id
        case .failures(let id): components.path = "/failures"; brand = id
        case .media(let id): components.path = "/media"; brand = id
        case .products(let id): components.path = "/products"; brand = id
        case .conversation(let id): components.path = "/conversation/\(id)"
        }
        if let brand, !brand.isEmpty { components.queryItems = [URLQueryItem(name: "brand", value: brand)] }
        return components.url ?? URL(string: "studio://open")!
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme, url.host()?.lowercased() == Self.host else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }.map { $0.removingPercentEncoding ?? $0 }
        let brand = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "brand" }?.value.flatMap { $0.isEmpty ? nil : $0 }
        switch (parts.first?.lowercased(), parts.count) {
        case ("approvals", 1): self = .approvals(brandId: brand)
        case ("post", 2): self = .post(parts[1])
        case ("calendar", 1): self = .calendar(brandId: brand)
        case ("failures", 1): self = .failures(brandId: brand)
        case ("media", 1): self = .media(brandId: brand)
        case ("products", 1): self = .products(brandId: brand)
        case ("conversation", 2): self = .conversation(parts[1])
        default: return nil
        }
    }

    /// The brand the screen belongs to, when the link names one.
    public var brandId: EntityID? {
        switch self {
        case .approvals(let id), .calendar(let id), .failures(let id), .media(let id), .products(let id): id
        case .post, .conversation: nil
        }
    }
}
