import Foundation

// Products (`/api/brands/{brandId}/products`, apps/api/src/routes/brand-products.ts) and the
// phone's Reels-from-footage request (N21, N23).

extension APIClient {
    // MARK: Products

    /// Oldest first (the order they were added in).
    public func products(brandId: EntityID) async throws(StudioAPIError) -> [BrandProduct] {
        try await all(BrandProduct.self, "/api/brands/\(Self.enc(brandId))/products")
    }

    public func product(brandId: EntityID, id: EntityID) async throws(StudioAPIError) -> BrandProduct {
        try await get(BrandProduct.self, "/api/brands/\(Self.enc(brandId))/products/\(Self.enc(id))")
    }

    /// 400 when a photo is not an `image` asset of this brand.
    public func createProduct(brandId: EntityID, _ input: BrandProductCreate) async throws(StudioAPIError) -> BrandProduct {
        try await send(BrandProduct.self, .post, "/api/brands/\(Self.enc(brandId))/products", body: input.cleaned)
    }

    public func updateProduct(brandId: EntityID, id: EntityID, _ input: BrandProductUpdate) async throws(StudioAPIError) -> BrandProduct {
        try await send(BrandProduct.self, .patch, "/api/brands/\(Self.enc(brandId))/products/\(Self.enc(id))", body: input)
    }

    /// Deleted for good; its photos stay in the brand's media.
    public func deleteProduct(brandId: EntityID, id: EntityID) async throws(StudioAPIError) {
        let request = try await makeRequest(.delete, "/api/brands/\(Self.enc(brandId))/products/\(Self.enc(id))")
        _ = try await data(for: request)
    }

    // MARK: Reels from the phone's footage

    /// What the desktop's `generate_reel` tool does with a clip: a new `reel` content, then a
    /// `content.generate` job with `reel: { recipe: footage_edit, clipAssetId }`.
    public func createReel(_ request: ReelFromFootage) async throws(StudioAPIError) -> (Content, Job) {
        let content = try await send(Content.self, .post, "/api/contents", body: request.contentCreate)
        let job = try await createJob(JobCreate(type: .contentGenerate, payload: request.payload, brandId: request.brandId, contentId: content.id))
        return (content, job)
    }
}

/// "Bu çekimden Reels yap" (N21).
public struct ReelFromFootage: Sendable, Equatable {
    public var brandId: EntityID
    public var clipAssetId: EntityID
    public var brief: String
    public var title: String
    public var platforms: [Platform]
    /// Wanted length in seconds (3…90); nil = the worker decides.
    public var durationSec: Int?

    public init(brandId: EntityID, clipAssetId: EntityID, brief: String, title: String? = nil, platforms: [Platform] = [.instagram], durationSec: Int? = nil) {
        self.brandId = brandId
        self.clipAssetId = clipAssetId
        let text = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        self.brief = text.isEmpty ? Self.defaultBrief : String(text.prefix(4000))
        let firstLine = self.brief.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let named = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = String(((named?.isEmpty == false ? named : nil) ?? (firstLine.isEmpty ? "Yeni Reels" : firstLine)).prefix(80))
        self.platforms = platforms.filter { $0 != .unknown }.isEmpty ? [.instagram] : platforms.filter { $0 != .unknown }
        self.durationSec = durationSec.map { min(90, max(3, $0)) }
    }

    public static let defaultBrief = "Bu çekimden kısa, dikkat çekici bir Reels kurgusu yap."

    struct ContentCreateBody: Encodable, Equatable {
        var brandId: EntityID
        var type: ContentType
        var title: String
        var brief: String
        var targetPlatforms: [Platform]
    }

    var contentCreate: ContentCreateBody {
        ContentCreateBody(brandId: brandId, type: .reel, title: title, brief: brief, targetPlatforms: platforms)
    }

    /// The `content.generate` payload (`ContentGeneratePayload` with `reel` options).
    public var payload: JSONObject {
        var reel: JSONObject = [
            "recipe": .string(ReelRecipe.footageEdit.rawValue),
            "clipAssetId": .string(clipAssetId),
        ]
        if let durationSec { reel["durationSec"] = .number(Double(durationSec)) }
        return [
            "title": .string(title),
            "brief": .string(brief),
            "type": .string(ContentType.reel.rawValue),
            "targetPlatforms": .array(platforms.map { .string($0.rawValue) }),
            "reel": .object(reel),
        ]
    }
}
