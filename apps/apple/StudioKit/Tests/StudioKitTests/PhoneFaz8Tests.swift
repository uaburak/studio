import CoreGraphics
import Foundation
import ImageIO
import Security
import Synchronization
import Testing
import UniformTypeIdentifiers
@testable import StudioKit

/// Faz 8 on the phone: shared storage for the extensions (N20, N22), the widget snapshot (N22),
/// products (N23), video uploads (N21) and the share sheet's delivery.
@Suite("Phone Faz 8")
struct PhoneFaz8Tests {
    private static func json(_ text: String) -> Data { Data(text.utf8) }

    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8787/")!, session: session), host)
    }

    private static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private static func credential(_ token: String = "tok-1") -> DeviceCredential {
        DeviceCredential(token: token, deviceId: "d1", serverURL: URL(string: "http://192.168.1.20:8791")!, serverName: "Mac")
    }

    /// A Keychain store that refuses like a build without the shared group.
    private final class RefusingStore: DeviceTokenStore {
        let status: OSStatus
        init(status: OSStatus = errSecMissingEntitlement) { self.status = status }
        func load() throws -> DeviceCredential? { throw KeychainError(status: status) }
        func save(_ credential: DeviceCredential) throws { throw KeychainError(status: status) }
        func delete() throws { throw KeychainError(status: status) }
    }

    // MARK: Shared storage: identifiers

    @Test func sharedIdentifiersComeFromTheBundleId() {
        #expect(StudioSharedContainer.appGroupId(for: "net.example.studio.ios") == "group.net.example.studio.ios")
        #expect(StudioSharedContainer.keychainGroup(teamPrefix: "ABCDE12345.", baseBundleId: "net.example.studio.ios") == "ABCDE12345.net.example.studio.ios.shared")
        #expect(StudioSharedContainer.keychainGroup(teamPrefix: "ABCDE12345", baseBundleId: "x.y") == "ABCDE12345.x.y.shared")
        #expect(StudioSharedContainer.baseBundleId(fromBundleId: "net.example.studio.ios.share") == "net.example.studio.ios")
        #expect(StudioSharedContainer.baseBundleId(fromBundleId: "net.example.studio.ios.widget") == "net.example.studio.ios")
        #expect(StudioSharedContainer.baseBundleId(fromBundleId: "net.example.studio.ios") == "net.example.studio.ios")
        #expect(StudioSharedContainer.validTeamPrefix("ABCDE12345.") == "ABCDE12345.")
        #expect(StudioSharedContainer.validTeamPrefix("ABCDE12345") == "ABCDE12345.")
        #expect(StudioSharedContainer.validTeamPrefix("") == nil)
        #expect(StudioSharedContainer.validTeamPrefix("$(AppIdentifierPrefix)") == nil)
        #expect(StudioSharedContainer.validTeamPrefix("abcde12345.") == nil)
        let container = StudioSharedContainer(baseBundleId: "net.example.studio.ios", keychainGroup: nil, containerURL: nil)
        #expect(container.appGroupId == "group.net.example.studio.ios")
        #expect(container.appUploadSessionId == "net.example.studio.ios.uploads")
        #expect(container.shareUploadSessionId == "net.example.studio.ios.share.uploads")
        #expect(!container.isAppGroupAvailable)
        #expect(container.sharedDefaults == nil)
        #expect(container.directory("Widget") == nil)
    }

    // MARK: Shared storage: the device token moves to the shared item

    @Test func theOldTokenMovesToTheSharedItemOnFirstRead() throws {
        let legacy = InMemoryDeviceTokenStore(Self.credential())
        let shared = InMemoryDeviceTokenStore()
        let store = SharedDeviceTokenStore(shared: shared, legacy: legacy)
        #expect(try store.load()?.token == "tok-1")
        #expect(try shared.load()?.token == "tok-1")
        #expect(try legacy.load() == nil)
        #expect(store.location == .shared)
        // Later reads come from the shared item.
        #expect(try store.load()?.token == "tok-1")
    }

    @Test func savesGoToTheSharedItemAndClearTheOldOne() throws {
        let legacy = InMemoryDeviceTokenStore(Self.credential("old"))
        let shared = InMemoryDeviceTokenStore()
        let store = SharedDeviceTokenStore(shared: shared, legacy: legacy)
        try store.save(Self.credential("new"))
        #expect(try shared.load()?.token == "new")
        #expect(try legacy.load() == nil)
        #expect(try store.load()?.token == "new")
        try store.delete()
        #expect(try store.load() == nil)
        #expect(store.location == SharedDeviceTokenStore.Location.none)
    }

    @Test func withoutTheSharedGroupTheAppKeepsItsOwnItem() throws {
        let legacy = InMemoryDeviceTokenStore(Self.credential())
        let store = SharedDeviceTokenStore(shared: RefusingStore(), legacy: legacy)
        #expect(try store.load()?.token == "tok-1")
        #expect(try legacy.load()?.token == "tok-1")
        try store.save(Self.credential("tok-2"))
        #expect(try legacy.load()?.token == "tok-2")
        #expect(store.location == .appOnly)
        try store.delete()
        #expect(try legacy.load() == nil)
        // No shared group configured at all (no team prefix): the same.
        let plain = SharedDeviceTokenStore(shared: nil, legacy: InMemoryDeviceTokenStore(Self.credential()))
        #expect(try plain.load()?.token == "tok-1")
        #expect(plain.location == .appOnly)
    }

    @Test func otherKeychainErrorsAreNotHidden() throws {
        let store = SharedDeviceTokenStore(shared: RefusingStore(status: errSecInteractionNotAllowed), legacy: InMemoryDeviceTokenStore())
        #expect(throws: KeychainError.self) { _ = try store.load() }
        #expect(SharedDeviceTokenStore.isMissingEntitlement(KeychainError(status: errSecMissingEntitlement)))
        #expect(!SharedDeviceTokenStore.isMissingEntitlement(KeychainError(status: errSecItemNotFound)))
    }

    @Test func extensionsFindOnlyTheSharedItem() throws {
        // The extension's legacy query never sees the app's own group: an empty store.
        let shared = InMemoryDeviceTokenStore(Self.credential())
        let store = SharedDeviceTokenStore(shared: shared, legacy: InMemoryDeviceTokenStore())
        #expect(try store.load()?.token == "tok-1")
        #expect(SharedDeviceTokenStore.legacyAccount != SharedDeviceTokenStore.sharedAccount)
    }

    // MARK: Shared storage: settings move to the App Group

    @Test func settingsMoveToTheSharedDefaultsOnce() throws {
        let oldName = "studio.tests.old.\(UUID().uuidString)"
        let sharedName = "studio.tests.shared.\(UUID().uuidString)"
        let old = try #require(UserDefaults(suiteName: oldName))
        let shared = try #require(UserDefaults(suiteName: sharedName))
        defer {
            old.removePersistentDomain(forName: oldName)
            shared.removePersistentDomain(forName: sharedName)
        }
        old.set(true, forKey: SharedSettingsKeys.remoteEnabled)
        old.set("https://studio.ornek.com", forKey: SharedSettingsKeys.remoteURL)
        old.set("b-old", forKey: SharedSettingsKeys.lastBrand)
        old.set("dark", forKey: "studio.ios.appearance")
        shared.set("b-new", forKey: SharedSettingsKeys.lastBrand)

        let moved = SharedDefaults.migrate(from: old, to: shared)
        #expect(Set(moved) == [SharedSettingsKeys.remoteEnabled, SharedSettingsKeys.remoteURL])
        #expect(shared.bool(forKey: SharedSettingsKeys.remoteEnabled))
        #expect(shared.string(forKey: SharedSettingsKeys.remoteURL) == "https://studio.ornek.com")
        // A value already shared wins; the old copy is gone either way.
        #expect(shared.string(forKey: SharedSettingsKeys.lastBrand) == "b-new")
        #expect(old.object(forKey: SharedSettingsKeys.lastBrand) == nil)
        #expect(old.object(forKey: SharedSettingsKeys.remoteURL) == nil)
        // Keys the extensions do not need stay where they were.
        #expect(old.string(forKey: "studio.ios.appearance") == "dark")
        #expect(SharedDefaults.migrate(from: old, to: shared).isEmpty)
        #expect(SharedSettingsKeys.manualRemoteURL(in: shared)?.absoluteString == "https://studio.ornek.com")
        shared.set(false, forKey: SharedSettingsKeys.remoteEnabled)
        #expect(SharedSettingsKeys.manualRemoteURL(in: shared) == nil)

        SharedBrand.save([SharedBrand(id: "b1", name: "Koç Tarım")], to: shared)
        #expect(SharedBrand.load(from: shared) == [SharedBrand(id: "b1", name: "Koç Tarım")])
    }

    // MARK: Deep links

    @Test func studioLinksRoundTrip() {
        let links: [StudioLink] = [
            .approvals(brandId: "b1"), .approvals(brandId: nil), .post("c 1"), .calendar(brandId: nil),
            .failures(brandId: "b2"), .media(brandId: "b3"), .products(brandId: nil), .conversation("conv-1"),
        ]
        for link in links {
            #expect(StudioLink(url: link.url) == link, "\(link.url)")
            #expect(link.url.scheme == "studio" && link.url.host() == "open")
        }
        #expect(StudioLink(url: URL(string: "studio://pair?s=1")!) == nil)
        #expect(StudioLink(url: URL(string: "studio://open/unknown")!) == nil)
        #expect(StudioLink(url: URL(string: "https://open/approvals")!) == nil)
        #expect(StudioLink.approvals(brandId: "b9").brandId == "b9")
    }

    // MARK: Widget snapshot

    private static func content(_ id: String, brand: String = "b1", status: ContentStatus, version: Int? = 1, title: String = "Post") -> Content {
        Content(
            id: id, brandId: brand, type: .post, title: title, status: status, targetPlatforms: [.instagram], caption: "",
            currentVersion: version.map { ContentVersionRef(id: "\(id)-v\($0)", version: $0, contentHash: "h") },
            createdAt: t0, updatedAt: t0)
    }

    private static func schedule(_ id: String, content: String, brand: String = "b1", platform: Platform = .instagram, at: Date, status: ScheduleStatus = .pending, error: String? = nil, updated: Date? = nil) -> Schedule {
        Schedule(
            id: id, contentId: content, brandId: brand, platform: platform, socialAccountId: "acc-\(platform.rawValue)",
            versionId: "v", contentHash: "h", scheduledAt: at, status: status, lastError: error,
            createdAt: t0, updatedAt: updated ?? at)
    }

    @Test func widgetSnapshotCountsAndOrders() {
        let now = Self.t0
        let brands = [Brand(id: "b1", name: "Koç Tarım", slug: "koc", createdAt: now, updatedAt: now),
                      Brand(id: "b2", name: "Deniz Kafe", slug: "deniz", createdAt: now, updatedAt: now)]
        var trashed = Self.content("c-trash", status: .draft)
        trashed.deletedAt = now
        let approvable = [
            Self.content("c1", status: .draft), Self.content("c2", status: .inReview),
            Self.content("c-gen", status: .draft, version: nil), trashed,
            Self.content("c-ok", status: .approved),
        ]
        let failed = [Self.content("c-fail", brand: "b2", status: .failed, title: "Kampanya")]
        let pending = [
            Self.schedule("s3", content: "c9", at: now.addingTimeInterval(7200)),
            Self.schedule("s1", content: "c8", platform: .instagram, at: now.addingTimeInterval(3600)),
            Self.schedule("s2", content: "c8", platform: .facebook, at: now.addingTimeInterval(3600)),
            Self.schedule("s-past", content: "c7", at: now.addingTimeInterval(-3600)),
        ]
        let failedSchedules = [
            Self.schedule("f1", content: "c-fail", brand: "b2", at: now.addingTimeInterval(-7200), status: .failed, error: "Token süresi doldu\nayrıntı", updated: now.addingTimeInterval(-7000)),
            Self.schedule("f0", content: "c-fail", brand: "b2", at: now.addingTimeInterval(-9000), status: .failed, error: "eski", updated: now.addingTimeInterval(-9000)),
        ]
        let contents = ["c8": Self.content("c8", status: .scheduled, title: "Hasat"), "c9": Self.content("c9", status: .scheduled, title: " ")]
        let snapshot = WidgetSnapshot.build(
            brands: brands, approvable: approvable, failed: failed, pendingSchedules: pending,
            failedSchedules: failedSchedules, contents: contents, macName: "Mac", now: now)
        #expect(snapshot.approvalCount == 2)
        #expect(snapshot.approvalBrandId == "b1")
        #expect(snapshot.upcoming.map(\.contentId) == ["c8", "c9"])
        #expect(snapshot.upcoming[0].platforms == [.instagram, .facebook])
        #expect(snapshot.upcoming[0].title == "Hasat")
        #expect(snapshot.upcoming[0].brandName == "Koç Tarım")
        #expect(snapshot.upcoming[1].title == "Adsız post")
        #expect(snapshot.attentionCount == 1)
        #expect(snapshot.attention[0].reason == "Token süresi doldu")
        #expect(snapshot.attention[0].brandName == "Deniz Kafe")
        #expect(snapshot.primaryLink == .approvals(brandId: "b1"))

        let quiet = WidgetSnapshot.build(brands: brands, approvable: [], failed: failed, pendingSchedules: [], failedSchedules: [], contents: [:], now: now)
        #expect(quiet.attention[0].reason == "Yayınlanamadı")
        #expect(quiet.primaryLink == .failures(brandId: "b2"))
        #expect(WidgetSnapshot(fetchedAt: now).primaryLink == .calendar(brandId: nil))
    }

    @Test func widgetRefreshAndFreshness() {
        let now = Self.t0
        let empty = WidgetSnapshot(fetchedAt: now)
        #expect(WidgetSnapshot.nextRefresh(after: now, snapshot: empty) == now.addingTimeInterval(20 * 60))
        #expect(WidgetSnapshot.nextRefresh(after: now, snapshot: nil) == now.addingTimeInterval(20 * 60))
        let soon = WidgetSnapshot(fetchedAt: now, upcoming: [.init(id: "s", contentId: "c", title: "t", brandId: "b", brandName: "B", platforms: [.instagram], scheduledAt: now.addingTimeInterval(9 * 60))])
        #expect(WidgetSnapshot.nextRefresh(after: now, snapshot: soon) == now.addingTimeInterval(10 * 60))
        let verySoon = WidgetSnapshot(fetchedAt: now, upcoming: [.init(id: "s", contentId: "c", title: "t", brandId: "b", brandName: "B", platforms: [], scheduledAt: now.addingTimeInterval(60))])
        #expect(WidgetSnapshot.nextRefresh(after: now, snapshot: verySoon) == now.addingTimeInterval(5 * 60))
        #expect(!empty.isStale(now: now.addingTimeInterval(30 * 60)))
        #expect(empty.isStale(now: now.addingTimeInterval(46 * 60)))
    }

    @Test func widgetCacheKeepsTheSnapshotAndItsThumbnails() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-widget-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = WidgetSnapshotCache(directory: folder)
        #expect(cache.load() == nil)
        var snapshot = WidgetSnapshot(fetchedAt: Self.t0, macName: "Mac", approvalCount: 3, upcoming: [
            .init(id: "s", contentId: "c", title: "t", brandId: "b", brandName: "B", platforms: [.instagram], scheduledAt: Self.t0, thumbnailAssetId: "a/1"),
        ])
        try cache.save(snapshot, thumbnails: ["a/1": Data([1, 2, 3]), "old": Data([9])])
        #expect(cache.load() == snapshot)
        #expect(cache.thumbnail("a/1") == Data([1, 2, 3]))
        // A thumbnail no row uses is removed.
        #expect(cache.thumbnail("old") == nil)
        snapshot.upcoming = []
        try cache.save(snapshot, thumbnails: [:])
        #expect(cache.thumbnail("a/1") == nil)
    }

    @Test func widgetFetchReadsEveryList() async throws {
        let (api, host) = client { request, _ in
            let url = request.url!
            let query = url.query ?? ""
            switch url.path {
            case "/api/brands":
                return .init(status: 200, body: Self.json(#"{"items":[{"id":"b1","name":"Koç","slug":"koc","defaultLanguage":"tr","status":"active","createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}],"nextCursor":null}"#))
            case "/api/contents" where query.contains("status=draft"):
                return .init(status: 200, body: Self.json(#"{"items":[{"id":"c1","brandId":"b1","type":"post","title":"Hasat","brief":"","status":"draft","targetPlatforms":["instagram"],"caption":"","currentVersion":{"id":"v1","version":1,"contentHash":"h"},"approval":null,"createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}],"nextCursor":null}"#))
            case "/api/contents":
                return .init(status: 200, body: Self.json(#"{"items":[],"nextCursor":null}"#))
            case "/api/schedules":
                return .init(status: 200, body: Self.json(#"{"items":[],"nextCursor":null}"#))
            default:
                return .init(status: 404, body: Self.json(#"{"error":{"code":"not_found","message":"x"}}"#))
            }
        }
        let (snapshot, thumbnails) = try await WidgetSnapshotFetcher.fetch(client: api, macName: "Mac", now: Self.t0)
        #expect(snapshot.approvalCount == 1)
        #expect(snapshot.macName == "Mac")
        #expect(thumbnails.isEmpty)
        let queries = StubURLProtocol.recorded(host: host).compactMap { $0.0.url?.query }
        #expect(queries.contains { $0.contains("status=in_review") })
        #expect(queries.contains { $0.contains("status=failed") })
        #expect(queries.contains { $0.contains("status=pending") })
    }

    // MARK: Products

    private static let productJSON = #"""
    {"id":"p1","brandId":"b1","name":"Kompoze Gübre","description":"25 kg torba","category":"Gübre","tags":["organik","torba"],"notes":"","imageAssetIds":["a1","a2"],"createdAt":"2026-11-16T12:00:00.000Z","updatedAt":"2026-11-16T12:30:00.000Z"}
    """#

    @Test func productsDecodeAndTheirRequests() async throws {
        let (api, host) = client { request, body in
            switch (request.httpMethod, request.url!.path) {
            case ("GET", "/api/brands/b1/products"):
                return .init(status: 200, body: Self.json(#"{"items":[\#(Self.productJSON)],"nextCursor":null}"#))
            case ("POST", "/api/brands/b1/products"), ("PATCH", "/api/brands/b1/products/p1"):
                return .init(status: request.httpMethod == "POST" ? 201 : 200, body: Self.json(Self.productJSON))
            case ("DELETE", "/api/brands/b1/products/p1"):
                return .init(status: 204, body: Data())
            default:
                return .init(status: 404, body: Self.json(#"{"error":{"code":"not_found","message":"x"}}"#))
            }
        }
        let list = try await api.products(brandId: "b1")
        #expect(list.count == 1)
        #expect(list[0].name == "Kompoze Gübre")
        #expect(list[0].coverAssetId == "a1")
        #expect(list[0].tags == ["organik", "torba"])
        _ = try await api.createProduct(brandId: "b1", BrandProductCreate(name: "  Kompoze  ", tags: ["a", "A", " b "], imageAssetIds: ["a1", "a1"]))
        _ = try await api.updateProduct(brandId: "b1", id: "p1", BrandProductUpdate(name: "Yeni"))
        try await api.deleteProduct(brandId: "b1", id: "p1")
        let recorded = StubURLProtocol.recorded(host: host)
        let create = try #require(recorded.first { $0.0.httpMethod == "POST" })
        let createBody = try #require(JSONSerialization.jsonObject(with: create.1) as? [String: Any])
        #expect(createBody["name"] as? String == "Kompoze")
        #expect(createBody["tags"] as? [String] == ["a", "b"])
        #expect(createBody["imageAssetIds"] as? [String] == ["a1"])
        let patch = try #require(recorded.first { $0.0.httpMethod == "PATCH" })
        let patchBody = try #require(JSONSerialization.jsonObject(with: patch.1) as? [String: Any])
        #expect(patchBody.keys.sorted() == ["name"])
        #expect(recorded.contains { $0.0.httpMethod == "DELETE" })
    }

    @Test func productsWithMissingListsStillDecode() throws {
        let product = try StudioJSON.decoder().decode(BrandProduct.self, from: Self.json(#"{"id":"p","brandId":"b","name":"N","createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}"#))
        #expect(product.tags.isEmpty && product.imageAssetIds.isEmpty && product.description.isEmpty)
        #expect(product.coverAssetId == nil)
    }

    @Test func productEditsSendOnlyWhatChanged() {
        let product = BrandProduct(id: "p", brandId: "b", name: "Gübre", description: "d", tags: ["x"], imageAssetIds: ["a1"], createdAt: Self.t0, updatedAt: Self.t0)
        let same = BrandProductUpdate.changes(from: product, to: BrandProductCreate(name: " Gübre ", description: "d", tags: ["x"], imageAssetIds: ["a1"]))
        #expect(same.isEmpty)
        let changed = BrandProductUpdate.changes(from: product, to: BrandProductCreate(name: "Gübre", description: "d", category: "Tarım", tags: ["x", "y"], imageAssetIds: ["a2", "a1"]))
        #expect(changed == BrandProductUpdate(category: "Tarım", tags: ["x", "y"], imageAssetIds: ["a2", "a1"]))
        #expect(BrandProductCreate(name: "  ").problem != nil)
        #expect(ProductTags.parse("organik, Organik,\n torba ,, ") == ["organik", "torba"])
        #expect(ProductTags.parse(Array(repeating: "x", count: 1).joined()) == ["x"])
        #expect(ProductTags.clean((1...20).map { "t\($0)" }).count == ProductLimits.maxTags)
    }

    @Test func assetsCarryWhatTheMacReadOnThem() throws {
        let text = #"""
        {"id":"a1","brandId":"b1","kind":"image","source":"upload","objectKey":"k","mimeType":"image/jpeg","bytes":10,"sha256":"s","width":1,"height":1,"durationMs":null,"originalFilename":"x.jpg","createdAt":"2026-11-16T12:00:00Z",
         "analysis":{"status":"complete","tags":[{"id":"bag","label":"torba","confidence":0.9},{"id":"plant","label":"bitki","confidence":0.2},{"id":"text","label":"yazı","confidence":0.5}],
         "text":"25 KG\nwww.koctarim.com\nKOMPOZE GÜBRE\nOrganik","colors":[],"orientation":"portrait","aspectRatio":0.8,"isCutout":true,"isLogoLike":false,"caption":"Yeşil bir gübre torbası.","hasFeaturePrint":true,"note":null,"analyzedAt":"2026-11-16T12:01:00Z","newField":1}}
        """#
        let asset = try StudioJSON.decoder().decode(Asset.self, from: Self.json(text))
        let analysis = try #require(asset.analysis)
        #expect(analysis.status == .complete)
        #expect(analysis.isCutout)
        let suggestion = ProductSuggestion.from(analysis)
        #expect(suggestion.name == "KOMPOZE GÜBRE")
        #expect(suggestion.description == "Yeşil bir gübre torbası.")
        #expect(suggestion.tags == ["torba", "yazı"])
        // Not analysed yet, failed, or a state a newer server sends.
        let plain = try StudioJSON.decoder().decode(Asset.self, from: try Fixture.data("asset"))
        #expect(plain.analysis == nil)
        #expect(ProductSuggestion.from(nil).isEmpty)
        #expect(ProductSuggestion.from(AssetAnalysisSummary(status: .failed, text: "KOMPOZE")).isEmpty)
        let odd = try StudioJSON.decoder().decode(AssetAnalysisSummary.self, from: Self.json(#"{"status":"queued","tags":"x"}"#))
        #expect(odd.status == .unknown && odd.tags.isEmpty)
    }

    @Test func reelsFromFootageMatchTheDesktopTool() async throws {
        let request = ReelFromFootage(brandId: "b1", clipAssetId: "v1", brief: "  ", durationSec: 200)
        #expect(request.brief == ReelFromFootage.defaultBrief)
        #expect(request.durationSec == 90)
        #expect(request.title == ReelFromFootage.defaultBrief)
        guard case .object(let reel) = try #require(request.payload["reel"]) else { Issue.record("reel missing"); return }
        #expect(reel["recipe"] == JSONValue.string("footage_edit"))
        #expect(reel["clipAssetId"] == JSONValue.string("v1"))
        #expect(request.payload["type"] == .string("reel"))

        let (api, host) = client { request, _ in
            if request.url!.path == "/api/contents" {
                return .init(status: 201, body: Self.json(#"{"id":"c1","brandId":"b1","type":"reel","title":"t","brief":"b","status":"draft","targetPlatforms":["instagram"],"caption":"","currentVersion":null,"approval":null,"createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}"#))
            }
            return .init(status: 201, body: Self.json(#"{"id":"j1","type":"content.generate","status":"queued","payload":{},"brandId":"b1","contentId":"c1","attempts":0,"createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}"#))
        }
        let (content, job) = try await api.createReel(ReelFromFootage(brandId: "b1", clipAssetId: "v1", brief: "Hasat günü\nkısa olsun", durationSec: 20))
        #expect(content.id == "c1")
        #expect(job.id == "j1")
        let recorded = StubURLProtocol.recorded(host: host)
        let contentBody = try #require(JSONSerialization.jsonObject(with: recorded[0].1) as? [String: Any])
        #expect(contentBody["type"] as? String == "reel")
        #expect(contentBody["title"] as? String == "Hasat günü")
        let jobBody = try #require(JSONSerialization.jsonObject(with: recorded[1].1) as? [String: Any])
        #expect(jobBody["contentId"] as? String == "c1")
        #expect(jobBody["type"] as? String == "content.generate")
        let payload = try #require(jobBody["payload"] as? [String: Any])
        #expect((payload["reel"] as? [String: Any])?["durationSec"] as? Double == 20)
    }

    // MARK: Video uploads

    @Test func videosThatFitGoAsTheyAre() {
        let mov = VideoSourceInfo(bytes: 30 * 1024 * 1024, durationMs: 25_000, mimeType: "video/quicktime", codec: .hevc)
        #expect(VideoUploadPlanner.decide(mov) == .asIs(mimeType: "video/quicktime"))
        let mp4 = VideoSourceInfo(bytes: 10_000_000, durationMs: 12_000, mimeType: "VIDEO/MP4", codec: .h264)
        #expect(VideoUploadPlanner.decide(mp4) == .asIs(mimeType: "video/mp4"))
        let unknownCodec = VideoSourceInfo(bytes: 1_000_000, durationMs: 5_000, mimeType: "video/mp4")
        #expect(VideoUploadPlanner.decide(unknownCodec) == .asIs(mimeType: "video/mp4"))
    }

    @Test func largeOrForeignVideosAreExportedSmallEnough() {
        // 20 s, 60 MB: every preset is worth a try.
        let short = VideoSourceInfo(bytes: 60 * 1024 * 1024, durationMs: 20_000, mimeType: "video/quicktime", codec: .hevc)
        #expect(VideoUploadPlanner.decide(short) == .transcode([.hevc1080, .h264_1080, .h264_720, .h264_540]))
        // 60 s, 120 MB: 1080p H.264 (≈ 82 MB) is not tried; HEVC (≈ 52 MB) may still fit.
        let big = VideoSourceInfo(bytes: 120 * 1024 * 1024, durationMs: 60_000, mimeType: "video/quicktime", codec: .hevc)
        #expect(VideoUploadPlanner.decide(big) == .transcode([.hevc1080, .h264_720, .h264_540]))
        // 90 s: only 720p and 540p.
        let reel = VideoSourceInfo(bytes: 200 * 1024 * 1024, durationMs: 90_000, mimeType: "video/mp4", codec: .h264)
        #expect(VideoUploadPlanner.decide(reel) == .transcode([.h264_720, .h264_540]))
        // ProRes or another container is exported even when small.
        let prores = VideoSourceInfo(bytes: 40 * 1024 * 1024, durationMs: 3_000, mimeType: "video/quicktime", codec: .prores)
        guard case .transcode(let presets) = VideoUploadPlanner.decide(prores) else { Issue.record("expected transcode"); return }
        #expect(presets.first == .hevc1080)
        let m4v = VideoSourceInfo(bytes: 5_000_000, durationMs: 4_000, mimeType: "video/x-m4v", codec: .h264)
        guard case .transcode = VideoUploadPlanner.decide(m4v) else { Issue.record("expected transcode"); return }
    }

    @Test func videosTooLongAreRefusedWithTheLongestThatFits() {
        let long = VideoSourceInfo(bytes: 900 * 1024 * 1024, durationMs: 20 * 60_000, mimeType: "video/quicktime", codec: .hevc)
        guard case .refuse(let reason) = VideoUploadPlanner.decide(long) else { Issue.record("expected refuse"); return }
        #expect(reason.contains("50 MB"))
        #expect(reason.contains(VideoUploadPlanner.maxDurationText()))
        #expect(VideoUploadPlanner.maxDurationText() == "2 dk 8 sn")
        // Just over what 540p fits: refused, not tried in vain.
        guard case .refuse = VideoUploadPlanner.decide(VideoSourceInfo(bytes: 90_000_000, durationMs: 130_000, mimeType: "video/mp4", codec: .h264)) else {
            Issue.record("expected refuse"); return
        }
        guard case .refuse = VideoUploadPlanner.decide(VideoSourceInfo(bytes: 0, durationMs: 0, mimeType: "video/mp4")) else {
            Issue.record("expected refuse"); return
        }
    }

    @Test func exportResultsMustFitAndNotBeCutShort() {
        let limit = VideoUploadPlanner.maxBytes
        #expect(VideoUploadPlanner.accepts(outputBytes: limit - 1, outputDurationMs: 30_000, sourceDurationMs: 30_000))
        #expect(!VideoUploadPlanner.accepts(outputBytes: limit + 1, outputDurationMs: 30_000, sourceDurationMs: 30_000))
        // `fileLengthLimit` stopped the export early.
        #expect(!VideoUploadPlanner.accepts(outputBytes: limit - 1, outputDurationMs: 20_000, sourceDurationMs: 30_000))
        #expect(!VideoUploadPlanner.accepts(outputBytes: 0, outputDurationMs: 30_000, sourceDurationMs: 30_000))
        #expect(VideoUploadPlanner.mimeType(forExtension: "MOV") == "video/quicktime")
        #expect(VideoUploadPlanner.mimeType(forExtension: "mp4") == "video/mp4")
        #expect(VideoUploadPlanner.mimeType(forExtension: "avi") == nil)
        #expect(VideoCodec(fourCC: "hvc1") == .hevc)
        #expect(VideoCodec(fourCC: "avc1") == .h264)
        #expect(VideoCodec(fourCC: "apcn") == .prores)
        #expect(VideoPreparation.fourCC(0x6176_6331) == "avc1")
    }

    // MARK: Uploads from disk

    private final class FileTransport: UploadTransport, @unchecked Sendable {
        let bodies = Mutex<[(Data, String?)]>([])
        func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
            bodies.withLock { $0.append((body, nil)) }
            return (try Fixture.data("asset"), HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!)
        }

        func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
            bodies.withLock { $0.append((try! Data(contentsOf: bodyFile), tag)) }
            return (try Fixture.data("asset"), HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!)
        }
    }

    @Test func filesOnDiskAreStreamedIntoTheBody() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-upload-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = folder.appendingPathComponent("klip.mov")
        let bytes = Data((0..<(3 * 1024 * 1024 + 17)).map { UInt8($0 % 251) })
        try bytes.write(to: source)

        var form = MultipartForm(boundary: "B")
        form.addField("brandId", "b1")
        let streamed = folder.appendingPathComponent("body")
        try form.writeBody(to: streamed, fileField: "file", filename: "klip.mov", mimeType: "video/quicktime", source: source)
        var inMemory = form
        inMemory.addFile("file", filename: "klip.mov", mimeType: "video/quicktime", data: bytes)
        #expect(try Data(contentsOf: streamed) == inMemory.finalize())

        let api = APIClient(baseURL: URL(string: "http://mac.local:8791")!)
        let transport = FileTransport()
        api.useUploads(transport: transport, retry: .none)
        let file = UploadFile(filename: "klip.mov", mimeType: "video/quicktime", fileURL: source, width: 1080, height: 1920, durationMs: 12_345)
        #expect(file.byteCount == bytes.count)
        #expect(file.assetKind == .video)
        let bodyFolder = folder.appendingPathComponent("Uploads")
        _ = try await api.uploadAsset(file, brandId: "b1", kind: file.assetKind, tag: "share-x-0", bodyDirectory: bodyFolder)
        let sent = try #require(transport.bodies.withLock { $0.first })
        #expect(sent.1 == "share-x-0")
        let text = String(decoding: sent.0.prefix(2000), as: UTF8.self)
        #expect(text.contains("name=\"durationMs\"\r\n\r\n12345"))
        #expect(text.contains("name=\"kind\"\r\n\r\nvideo"))
        #expect(sent.0.count > bytes.count)
        // The body file is gone once the upload ended.
        #expect((try? FileManager.default.contentsOfDirectory(atPath: bodyFolder.path))?.isEmpty ?? true)
        #expect(APIClient.bodyFileName(forTag: "share-a/b-0") == "studio-upload-share-a_b-0.multipart")
    }

    // MARK: Pictures from the share sheet

    private static func png(width: Int, height: Int, alpha: Bool) -> Data {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: alpha ? 0.5 : 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = context.makeImage()!
        let out = NSMutableData()
        let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        return out as Data
    }

    @Test func sharedPicturesKeepTransparencyAndShrink() throws {
        let clear = try ImagePreparation.prepare(data: Self.png(width: 400, height: 300, alpha: true), filename: "urun.png")
        #expect(clear.file.mimeType == "image/png")
        #expect(clear.file.filename == "urun.png")
        #expect(clear.file.width == 400 && clear.file.height == 300)
        let opaque = try ImagePreparation.prepare(data: Self.png(width: 4000, height: 1000, alpha: false), filename: "IMG_1.HEIC")
        #expect(opaque.file.mimeType == "image/jpeg")
        #expect(opaque.file.filename == "IMG_1.jpg")
        #expect(opaque.file.width == ImagePreparation.maxPixel)
        #expect(opaque.thumbnail.map { max($0.width, $0.height) } == 240)
        #expect(throws: StudioAPIError.self) { _ = try ImagePreparation.prepare(data: Data("not a picture".utf8)) }
    }

    // MARK: Share sheet delivery

    @Test func shareTagsAndRecords() throws {
        #expect(PendingShare.tag(shareId: "ab-cd", index: 2) == "share-ab-cd-2")
        let parsed = try #require(PendingShare.parse(tag: "share-ab-cd-2"))
        #expect(parsed.shareId == "ab-cd" && parsed.index == 2)
        #expect(PendingShare.parse(tag: "other") == nil)
        #expect(PendingShare.parse(tag: "share--1") == nil)

        var share = PendingShare(id: "s1", brandId: "b1", destination: .conversation(id: nil, message: " Bunlarla post yap "), items: [
            .init(tag: "share-s1-0", filename: "a.jpg", mimeType: "image/jpeg"),
            .init(tag: "share-s1-1", filename: "b.mov", mimeType: "video/quicktime"),
        ])
        #expect(!share.isUploaded)
        share.record(tag: "share-s1-0", assetId: "a1", failure: nil)
        share.record(tag: "share-s1-1", assetId: nil, failure: "Mac'e ulaşılamadı")
        #expect(share.isUploaded)
        #expect(share.failedCount == 1)
        #expect(ShareDelivery.step(for: share) == .message(conversationId: nil, text: "Bunlarla post yap", assetIds: ["a1"], clientMessageId: "share-s1"))
        share.destination = .media
        #expect(ShareDelivery.step(for: share) == ShareDelivery.Step.none)
        share.destination = .slot(contentId: "c1", version: 3, slide: 1, layerId: "photo")
        #expect(ShareDelivery.step(for: share) == .fillSlot(contentId: "c1", version: 3, slide: 1, layerId: "photo", assetId: "a1", mimeType: "image/jpeg"))
        share.record(tag: "share-s1-0", assetId: nil, failure: nil)
        guard case .failed = ShareDelivery.step(for: share) else { Issue.record("expected failed"); return }
        #expect(ShareDelivery.conversationTitle(text: "", count: 3) == "Paylaşılan 3 dosya")
        #expect(ShareDelivery.conversationTitle(text: "Hasat\nikinci", count: 1) == "Hasat")
    }

    @Test func theInboxFinishesSharesAfterTheExtensionIsGone() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-shares-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let inbox = ShareInbox(directory: folder)
        let share = PendingShare(id: "s2", brandId: "b1", destination: .media, items: [.init(tag: "share-s2-0", filename: "v.mov", mimeType: "video/quicktime")], createdAt: Self.t0)
        try inbox.save(share)
        try FileManager.default.createDirectory(at: inbox.uploadsDirectory, withIntermediateDirectories: true)
        let body = inbox.uploadsDirectory.appendingPathComponent(APIClient.bodyFileName(forTag: "share-s2-0"))
        try Data([1]).write(to: body)
        #expect(inbox.readyToDeliver().isEmpty)

        let finished = FinishedBackgroundUpload(tag: "share-s2-0", status: 201, body: try Fixture.data("asset"), error: nil)
        let updated = try #require(inbox.record(finished))
        #expect(updated.items[0].assetId == "01a1e449-ba6c-7000-83fb-72e2f7172518")
        #expect(!FileManager.default.fileExists(atPath: body.path))
        #expect(inbox.readyToDeliver().map(\.id) == ["s2"])
        #expect(inbox.record(FinishedBackgroundUpload(tag: "other", status: 201, body: Data(), error: nil)) == nil)

        let refused = FinishedBackgroundUpload(tag: "x", status: 413, body: Self.json(#"{"error":{"code":"payload_too_large","message":"too big"}}"#), error: nil)
        #expect(refused.asset == nil)
        #expect(refused.failure != nil)

        var delivered = updated
        delivered.deliveredAt = Self.t0
        try inbox.save(delivered)
        let stale = PendingShare(id: "s3", brandId: "b1", destination: .media, createdAt: Self.t0.addingTimeInterval(-3 * 24 * 3600))
        try inbox.save(stale)
        let fresh = PendingShare(id: "s4", brandId: "b1", destination: .media, createdAt: Self.t0)
        try inbox.save(fresh)
        inbox.prune(now: Self.t0)
        #expect(inbox.all().map(\.id) == ["s4"])
    }

    @Test func shareDeliverySendsTheMessageOnce() async throws {
        let (api, host) = client { request, _ in
            switch request.url!.path {
            case "/api/conversations":
                return .init(status: 201, body: Self.json(#"{"id":"conv-1","brandId":"b1","title":"t","status":"active","activeRunId":null,"lastSeq":0,"lastActivityAt":"2026-11-16T12:00:00Z","createdAt":"2026-11-16T12:00:00Z","updatedAt":"2026-11-16T12:00:00Z"}"#))
            default:
                return .init(status: 500, body: Self.json(#"{"error":{"code":"internal_error","message":"stop"}}"#))
            }
        }
        var share = PendingShare(id: "s5", brandId: "b1", destination: .conversation(id: nil, message: ""), items: [.init(tag: "share-s5-0", filename: "a.jpg", mimeType: "image/jpeg", assetId: "a1")])
        await #expect(throws: (any Error).self) { _ = try await ShareDelivery.deliver(share, client: api) }
        let recorded = StubURLProtocol.recorded(host: host)
        let message = try #require(recorded.first { $0.0.url?.path == "/api/conversations/conv-1/messages" })
        let body = try #require(JSONSerialization.jsonObject(with: message.1) as? [String: Any])
        #expect(body["clientMessageId"] as? String == "share-s5")
        #expect((body["attachments"] as? [[String: Any]])?.first?["assetId"] as? String == "a1")
        #expect(body["text"] == nil)
        share.destination = .media
        #expect(try await ShareDelivery.deliver(share, client: api) == .media)
    }

    @Test func onlyEmptySlotsOfEditablePostsAreOffered() throws {
        let html = #"<main data-artboard><div data-layer="photo" data-type="slot" data-slot-state="empty" data-slot-ratio="4:5" data-slot-label="Ürün"></div><div data-layer="full" data-type="slot" data-slot-state="filled"></div></main>"#
        let version = ContentVersion(id: "v2", contentId: "c1", version: 2, contentHash: "h", createdAt: Self.t0, updatedAt: Self.t0, slides: [
            Slide(html: "<main></main>", width: 1080, height: 1350, renderedAssetId: "r1"),
            Slide(html: html, width: 1080, height: 1350),
        ])
        var content = Self.content("c1", status: .draft, version: 2, title: "Hasat")
        let targets = SlotTarget.targets(content: content, version: version)
        #expect(targets.count == 1)
        #expect(targets[0].slot.layerId == "photo")
        #expect(targets[0].slotLabel == "2. kare · Ürün (4:5)")
        #expect(targets[0].thumbnailAssetId == "r1")
        content.status = .published
        #expect(SlotTarget.targets(content: content, version: version).isEmpty)
        content.status = .draft
        content.type = .reel
        #expect(SlotTarget.targets(content: content, version: version).isEmpty)
        content.type = .post
        content.currentVersion = ContentVersionRef(id: "v3", version: 3, contentHash: "h")
        #expect(SlotTarget.targets(content: content, version: version).isEmpty)
    }
}
