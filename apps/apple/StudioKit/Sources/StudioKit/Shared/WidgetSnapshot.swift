import Foundation

/// What the Studio widget shows (N22): posts waiting for approval, the next scheduled publishes
/// and posts whose publishing failed, across every brand. Built from the API by the widget's
/// timeline provider and cached in the App Group (or the widget's own folder) for when the Mac
/// cannot be reached.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public struct Upcoming: Codable, Sendable, Equatable, Identifiable {
        /// The first schedule's id.
        public var id: EntityID
        public var contentId: EntityID
        public var title: String
        public var brandId: EntityID
        public var brandName: String
        /// Every platform it goes to at that time.
        public var platforms: [Platform]
        public var scheduledAt: Date
        /// The first rendered slide (or the Reels cover), for medium / large.
        public var thumbnailAssetId: EntityID?

        public init(
            id: EntityID, contentId: EntityID, title: String, brandId: EntityID, brandName: String,
            platforms: [Platform], scheduledAt: Date, thumbnailAssetId: EntityID? = nil
        ) {
            self.id = id
            self.contentId = contentId
            self.title = title
            self.brandId = brandId
            self.brandName = brandName
            self.platforms = platforms
            self.scheduledAt = scheduledAt
            self.thumbnailAssetId = thumbnailAssetId
        }
    }

    /// A post that needs the owner (its publishing failed).
    public struct Attention: Codable, Sendable, Equatable, Identifiable {
        /// The content id.
        public var id: EntityID
        public var title: String
        public var brandId: EntityID
        public var brandName: String
        public var at: Date?
        /// Why, in Turkish (the publisher's last error, shortened).
        public var reason: String

        public init(id: EntityID, title: String, brandId: EntityID, brandName: String, at: Date?, reason: String) {
            self.id = id
            self.title = title
            self.brandId = brandId
            self.brandName = brandName
            self.at = at
            self.reason = reason
        }
    }

    public var fetchedAt: Date
    public var macName: String?
    public var approvalCount: Int
    /// The brand of every waiting post, when they all belong to one (the tap opens its list).
    public var approvalBrandId: EntityID?
    public var upcoming: [Upcoming]
    public var attention: [Attention]
    public var attentionCount: Int

    public init(
        fetchedAt: Date, macName: String? = nil, approvalCount: Int = 0, approvalBrandId: EntityID? = nil,
        upcoming: [Upcoming] = [], attention: [Attention] = [], attentionCount: Int? = nil
    ) {
        self.fetchedAt = fetchedAt
        self.macName = macName
        self.approvalCount = approvalCount
        self.approvalBrandId = approvalBrandId
        self.upcoming = upcoming
        self.attention = attention
        self.attentionCount = attentionCount ?? attention.count
    }

    public var nextPublish: Upcoming? { upcoming.first }

    /// At most this many upcoming and failed posts are kept (the large widget shows three).
    public static let listLimit = 3

    /// Every number from the Mac's lists (pure; tested).
    public static func build(
        brands: [Brand], approvable: [Content], failed: [Content], pendingSchedules: [Schedule],
        failedSchedules: [Schedule], contents: [EntityID: Content], macName: String? = nil, now: Date
    ) -> WidgetSnapshot {
        let names = Dictionary(brands.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        func brandName(_ id: EntityID) -> String { names[id] ?? "Marka" }

        // Waiting for approval: a version to approve, not in the trash.
        let waiting = approvable.filter { $0.status.isApprovable && $0.currentVersion != nil && $0.deletedAt == nil }
        let waitingBrands = Set(waiting.map(\.brandId))

        // Next publishes: one row per post and time (its platforms together), soonest first.
        var groups: [String: Upcoming] = [:]
        for schedule in pendingSchedules where schedule.status == .pending && schedule.scheduledAt >= now.addingTimeInterval(-60) {
            let key = "\(schedule.contentId)|\(Int(schedule.scheduledAt.timeIntervalSince1970))"
            if var group = groups[key] {
                if !group.platforms.contains(schedule.platform) { group.platforms.append(schedule.platform) }
                groups[key] = group
                continue
            }
            let content = contents[schedule.contentId]
            groups[key] = Upcoming(
                id: schedule.id, contentId: schedule.contentId, title: displayTitle(content?.title),
                brandId: schedule.brandId, brandName: brandName(schedule.brandId), platforms: [schedule.platform],
                scheduledAt: schedule.scheduledAt)
        }
        let upcoming = groups.values.sorted { ($0.scheduledAt, $0.id) < ($1.scheduledAt, $1.id) }

        // Needs attention: posts whose publishing failed (the latest failed schedule says why).
        var lastFailure: [EntityID: Schedule] = [:]
        for schedule in failedSchedules where schedule.status == .failed {
            if let seen = lastFailure[schedule.contentId], seen.updatedAt >= schedule.updatedAt { continue }
            lastFailure[schedule.contentId] = schedule
        }
        let attention = failed.filter { $0.status == .failed && $0.deletedAt == nil }.map { content -> Attention in
            let schedule = lastFailure[content.id]
            return Attention(
                id: content.id, title: displayTitle(content.title), brandId: content.brandId, brandName: brandName(content.brandId),
                at: schedule?.updatedAt ?? content.updatedAt, reason: shortReason(schedule?.lastError))
        }.sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }

        return WidgetSnapshot(
            fetchedAt: now, macName: macName, approvalCount: waiting.count,
            approvalBrandId: waitingBrands.count == 1 ? waitingBrands.first : nil,
            upcoming: Array(upcoming.prefix(listLimit)), attention: Array(attention.prefix(listLimit)),
            attentionCount: attention.count)
    }

    static func displayTitle(_ title: String?) -> String {
        let text = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? "Adsız post" : text
    }

    static func shortReason(_ error: String?) -> String {
        guard let line = error?.split(whereSeparator: \.isNewline).first?.trimmingCharacters(in: .whitespaces), !line.isEmpty else {
            return "Yayınlanamadı"
        }
        return line.count > 90 ? String(line.prefix(89)) + "…" : line
    }

    // MARK: Freshness and refresh

    /// Older than this, the widget says when it last reached the Mac.
    public static let staleAfter: TimeInterval = 45 * 60
    /// How often the widget asks the Mac (WidgetKit may stretch it).
    public static let refreshInterval: TimeInterval = 20 * 60

    public func isStale(now: Date) -> Bool { now.timeIntervalSince(fetchedAt) > Self.staleAfter }

    /// When to fetch again: in 20 minutes, or a minute after the next publish when that is
    /// sooner (the row then moves on), never sooner than 5 minutes.
    public static func nextRefresh(after now: Date, snapshot: WidgetSnapshot?) -> Date {
        var next = now.addingTimeInterval(refreshInterval)
        if let publish = snapshot?.nextPublish?.scheduledAt.addingTimeInterval(60), publish > now, publish < next {
            next = publish
        }
        return max(next, now.addingTimeInterval(5 * 60))
    }

    /// The tap target of the whole widget: the waiting posts, else the failures, else the
    /// calendar.
    public var primaryLink: StudioLink {
        if approvalCount > 0 { return .approvals(brandId: approvalBrandId) }
        if attentionCount > 0 { return .failures(brandId: attention.first?.brandId) }
        if let next = nextPublish { return .post(next.contentId) }
        return .calendar(brandId: nil)
    }
}

extension TurkishFormat {
    /// `Bugün 14:00`, `Yarın 09:30`, `4 Kas 10:00` (the widget's publish times).
    public static func relativeDayTime(_ date: Date, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let time = String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date))
        if calendar.isDate(date, inSameDayAs: now) { return "Bugün \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) { return "Yarın \(time)" }
        return "\(shortDay(date, timeZone: timeZone)) \(time)"
    }

    /// `14:05` today, else `4 Kas 14:05` (when the widget last reached the Mac).
    public static func clockOrDay(_ date: Date, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        let text = relativeDayTime(date, now: now, timeZone: timeZone)
        return text.hasPrefix("Bugün ") ? String(text.dropFirst(6)) : text
    }
}

/// The widget's kind (the app reloads it by this name).
public enum StudioWidgetKind {
    public static let main = "StudioWidget"
}

// MARK: - Fetch and cache

public enum WidgetSnapshotFetcher {
    /// Everything the widget shows, from the paired Mac, with small thumbnails (asset id → JPEG /
    /// WebP bytes) for the next publishes.
    public static func fetch(client: APIClient, macName: String?, now: Date = Date(), thumbnailWidth: Int = 240) async throws -> (WidgetSnapshot, [EntityID: Data]) {
        async let brands = client.brands()
        async let drafts = client.contents(status: .draft)
        async let reviews = client.contents(status: .inReview)
        async let failed = client.contents(status: .failed)
        async let pending = client.schedules(status: .pending, from: now.addingTimeInterval(-60))
        async let failedSchedules = client.schedules(status: .failed, from: now.addingTimeInterval(-30 * 24 * 3600))

        let loadedPending = try await pending
        let soonest = Array(Set(loadedPending.sorted { $0.scheduledAt < $1.scheduledAt }.map(\.contentId)).prefix(8))
        var contents: [EntityID: Content] = [:]
        await withTaskGroup(of: Content?.self) { group in
            for id in soonest { group.addTask { try? await client.content(id) } }
            for await content in group { if let content { contents[content.id] = content } }
        }
        var snapshot = WidgetSnapshot.build(
            brands: try await brands, approvable: try await drafts + reviews, failed: (try? await failed) ?? [],
            pendingSchedules: loadedPending, failedSchedules: (try? await failedSchedules) ?? [],
            contents: contents, macName: macName, now: now)

        // Thumbnails of the rows that show one (the first rendered slide / the Reels cover).
        var thumbnails: [EntityID: Data] = [:]
        for index in snapshot.upcoming.indices {
            let row = snapshot.upcoming[index]
            guard let ref = contents[row.contentId]?.currentVersion,
                  let version = try? await client.contentVersion(contentId: row.contentId, version: ref.version),
                  let assetId = version.slides.lazy.compactMap(\.renderedAssetId).first else { continue }
            snapshot.upcoming[index].thumbnailAssetId = assetId
            if let data = try? await client.assetThumbnailData(assetId, width: thumbnailWidth) { thumbnails[assetId] = data }
        }
        return (snapshot, thumbnails)
    }
}

/// The last snapshot on disk (`snapshot.json` + `thumb-<asset id>` files).
public struct WidgetSnapshotCache: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The App Group's `Widget` folder, else this process's own caches folder.
    public static func standard(container: StudioSharedContainer = .current) -> WidgetSnapshotCache {
        let folder = container.directory("Widget")
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("StudioWidget", isDirectory: true)
        return WidgetSnapshotCache(directory: folder)
    }

    private var snapshotURL: URL { directory.appendingPathComponent("snapshot.json") }

    private func thumbnailURL(_ assetId: EntityID) -> URL {
        let safe = assetId.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? Character($0) : "_" }
        return directory.appendingPathComponent("thumb-\(String(safe))")
    }

    public func load() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: snapshotURL) else { return nil }
        return try? StudioJSON.decoder().decode(WidgetSnapshot.self, from: data)
    }

    public func thumbnail(_ assetId: EntityID?) -> Data? {
        guard let assetId else { return nil }
        return try? Data(contentsOf: thumbnailURL(assetId))
    }

    /// Save the snapshot and its thumbnails; thumbnails no row uses any more are deleted.
    public func save(_ snapshot: WidgetSnapshot, thumbnails: [EntityID: Data]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (id, data) in thumbnails { try? data.write(to: thumbnailURL(id), options: .atomic) }
        try StudioJSON.encoder().encode(snapshot).write(to: snapshotURL, options: .atomic)
        let keep = Set(snapshot.upcoming.compactMap(\.thumbnailAssetId).map { thumbnailURL($0).lastPathComponent })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix("thumb-") && !keep.contains(name) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}

// MARK: - Reaching the paired Mac from an extension

/// Finds the paired Mac without Bonjour (the widget and the share sheet have little time): the
/// last answering address and the LAN addresses, then the tunnel and the manual address.
public enum PairedMac {
    public enum Failure: Error, Equatable, Sendable {
        /// No pairing this process can read (not paired, or the shared Keychain is missing).
        case notPaired
        /// No address answered.
        case notFound

        public var message: String {
            switch self {
            case .notPaired: "Studio'yu aç ve iPhone'u Mac'e bağla."
            case .notFound: "Mac'e ulaşılamıyor. Mac uykuda ya da başka bir ağda olabilir."
            }
        }
    }

    public static func connect(
        store: any DeviceTokenStore, manual: URL? = nil,
        connector: MacConnector = MacConnector(localTimeout: .seconds(2), remoteTimeout: .seconds(6), remoteHeadStart: .milliseconds(800)),
        session: URLSession = .shared
    ) async throws(Failure) -> (client: APIClient, credential: DeviceCredential) {
        guard let credential = try? store.load() else { throw .notPaired }
        let candidates = MacRoutePlanner.candidates(lastKnown: credential.serverURL, routes: credential.routes, manual: manual)
        guard let found = await connector.firstReachable(candidates, macId: credential.macId) else { throw .notFound }
        if found.url != credential.serverURL { try? PairingClient(store: store).updateServerURL(found.url) }
        return (APIClient(baseURL: found.url, auth: DeviceTokenAuth(store: store), session: session), credential)
    }
}
