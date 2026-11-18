import StudioKit
import SwiftUI
import UIKit
import WidgetKit

// The Studio widget (N22): how many posts wait for approval, the next scheduled publishes and
// the posts whose publishing failed, across every brand. Home screen (small, medium, large) and
// lock screen (circular, rectangular, inline). The timeline provider reads the paired Mac with
// the shared device token (LAN, then the tunnel) and keeps the last answer for when the Mac is
// asleep. WidgetKit is SwiftUI only; the app itself is UIKit.

@main
struct StudioWidgetBundle: WidgetBundle {
    var body: some Widget {
        StudioWidget()
    }
}

struct StudioWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: StudioWidgetKind.main, provider: StudioTimelineProvider()) { entry in
            StudioWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Studio")
        .description("Onay bekleyen postlar, sıradaki yayın ve dikkat isteyenler.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Timeline

struct StudioEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    /// Thumbnails of the upcoming rows, by asset id.
    let thumbnails: [EntityID: UIImage]
    /// Why the numbers are not fresh (not paired, Mac not reachable); nil when they are.
    let problem: String?

    static let sample = StudioEntry(
        date: Date(),
        snapshot: WidgetSnapshot(
            fetchedAt: Date(), approvalCount: 3,
            upcoming: [
                .init(id: "s1", contentId: "c1", title: "Hasat zamanı", brandId: "b1", brandName: "Marka",
                      platforms: [.instagram], scheduledAt: Date().addingTimeInterval(3 * 3600)),
            ]),
        thumbnails: [:], problem: nil)
}

struct StudioTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> StudioEntry { .sample }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (StudioEntry) -> Void) {
        if context.isPreview {
            completion(.sample)
            return
        }
        // The gallery and transitions: the cached numbers at once.
        completion(StudioWidgetLoader.cached())
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<StudioEntry>) -> Void) {
        Task {
            let entry = await StudioWidgetLoader.load()
            completion(Timeline(entries: [entry], policy: .after(WidgetSnapshot.nextRefresh(after: entry.date, snapshot: entry.snapshot))))
        }
    }
}

enum StudioWidgetLoader {
    static var container: StudioSharedContainer { .current }

    static func cached(problem: String? = nil) -> StudioEntry {
        let cache = WidgetSnapshotCache.standard(container: container)
        let snapshot = cache.load()
        return StudioEntry(date: Date(), snapshot: snapshot, thumbnails: thumbnails(snapshot, cache), problem: problem)
    }

    /// Ask the Mac; on failure, the last answer with the reason.
    static func load() async -> StudioEntry {
        let cache = WidgetSnapshotCache.standard(container: container)
        let store = SharedDeviceTokenStore.standard(container: container)
        let manual = container.sharedDefaults.flatMap { SharedSettingsKeys.manualRemoteURL(in: $0) }
        let connected: (client: APIClient, credential: DeviceCredential)
        do {
            connected = try await PairedMac.connect(store: store, manual: manual)
        } catch {
            return cached(problem: error.message)
        }
        do {
            let name = connected.credential.routes?.macName ?? connected.credential.serverName
            let (snapshot, thumbnailData) = try await WidgetSnapshotFetcher.fetch(client: connected.client, macName: name)
            try? cache.save(snapshot, thumbnails: thumbnailData)
            return StudioEntry(date: Date(), snapshot: snapshot, thumbnails: thumbnails(snapshot, cache), problem: nil)
        } catch {
            let apiError = StudioAPIError.from(error)
            if case .unauthorized = apiError { return cached(problem: "Mac bu iPhone'u artık tanımıyor. Studio'yu açıp yeniden bağla.") }
            return cached(problem: "Mac'ten okunamadı.")
        }
    }

    static func thumbnails(_ snapshot: WidgetSnapshot?, _ cache: WidgetSnapshotCache) -> [EntityID: UIImage] {
        var out: [EntityID: UIImage] = [:]
        for row in snapshot?.upcoming ?? [] {
            guard let id = row.thumbnailAssetId, let data = cache.thumbnail(id), let image = UIImage(data: data) else { continue }
            out[id] = image.preparingThumbnail(of: CGSize(width: 160, height: 200)) ?? image
        }
        return out
    }
}

// MARK: - Views

struct StudioWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StudioEntry

    var body: some View {
        switch family {
        case .accessoryCircular: CircularView(entry: entry)
        case .accessoryRectangular: RectangularView(entry: entry)
        case .accessoryInline: InlineView(entry: entry)
        case .systemMedium: MediumView(entry: entry)
        case .systemLarge, .systemExtraLarge: LargeView(entry: entry)
        default: SmallView(entry: entry)
        }
    }
}

private extension StudioEntry {
    var approvals: Int { snapshot?.approvalCount ?? 0 }
    var failures: Int { snapshot?.attentionCount ?? 0 }
    var next: WidgetSnapshot.Upcoming? { snapshot?.nextPublish }
    var primaryURL: URL { (snapshot?.primaryLink ?? .calendar(brandId: nil)).url }
    var approvalsURL: URL { StudioLink.approvals(brandId: snapshot?.approvalBrandId).url }
    var failuresURL: URL { StudioLink.failures(brandId: snapshot?.attention.first?.brandId).url }

    /// "Son: 14:05" when the numbers are old or the Mac did not answer.
    var footnote: String? {
        guard let snapshot else { return problem }
        if problem != nil || snapshot.isStale(now: date) {
            return "Son: \(TurkishFormat.clockOrDay(snapshot.fetchedAt, now: date))"
        }
        return nil
    }
}

private struct ApprovalsBlock: View {
    let count: Int
    var big: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(count)")
                .font(.system(size: big ? 40 : 30, weight: .bold, design: .rounded))
                .foregroundStyle(count > 0 ? Color.primary : Color.secondary)
                .contentTransition(.numericText())
            Text("post onay bekliyor")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }
}

private struct FailureLine: View {
    let count: Int

    var body: some View {
        Label(count == 1 ? "1 yayın başarısız" : "\(count) yayın başarısız", systemImage: "exclamationmark.triangle.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.red)
            .lineLimit(1)
    }
}

private struct NextLine: View {
    let next: WidgetSnapshot.Upcoming
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(TurkishFormat.relativeDayTime(next.scheduledAt, now: now))
                .font(.caption.weight(.semibold))
            Text(next.brandName)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
    }
}

private struct ProblemView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "laptopcomputer.slash")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct Footnote: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }
}

private struct SmallView: View {
    let entry: StudioEntry

    var body: some View {
        Group {
            if entry.snapshot == nil, let problem = entry.problem {
                ProblemView(text: problem)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ApprovalsBlock(count: entry.approvals)
                    Spacer(minLength: 0)
                    if entry.failures > 0 {
                        FailureLine(count: entry.failures)
                    } else if let next = entry.next {
                        NextLine(next: next, now: entry.date)
                    } else {
                        Text("Zamanlanmış yayın yok")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Footnote(text: entry.footnote)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .widgetURL(entry.primaryURL)
    }
}

private struct Thumbnail: View {
    let image: UIImage?
    var width: CGFloat = 52

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "photo").foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.quaternary)
            }
        }
        .frame(width: width, height: width * 1.25)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct UpcomingRow: View {
    let row: WidgetSnapshot.Upcoming
    let image: UIImage?
    let now: Date

    var body: some View {
        Link(destination: StudioLink.post(row.contentId).url) {
            HStack(spacing: 10) {
                Thumbnail(image: image, width: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.caption.weight(.semibold)).lineLimit(1)
                    Text("\(TurkishFormat.relativeDayTime(row.scheduledAt, now: now)) · \(row.brandName)")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct MediumView: View {
    let entry: StudioEntry

    var body: some View {
        if entry.snapshot == nil, let problem = entry.problem {
            ProblemView(text: problem).widgetURL(entry.primaryURL)
        } else {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Link(destination: entry.approvalsURL) { ApprovalsBlock(count: entry.approvals) }
                    Spacer(minLength: 0)
                    if entry.failures > 0 {
                        Link(destination: entry.failuresURL) { FailureLine(count: entry.failures) }
                    }
                    Footnote(text: entry.footnote)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                if let next = entry.next {
                    Link(destination: StudioLink.post(next.contentId).url) {
                        HStack(alignment: .top, spacing: 8) {
                            Thumbnail(image: next.thumbnailAssetId.flatMap { entry.thumbnails[$0] })
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Sıradaki yayın").font(.caption2).foregroundStyle(.secondary)
                                Text(next.title).font(.caption.weight(.semibold)).lineLimit(2)
                                Text(TurkishFormat.relativeDayTime(next.scheduledAt, now: entry.date)).font(.caption2.weight(.medium))
                                Text(next.brandName).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Sıradaki yayın").font(.caption2).foregroundStyle(.secondary)
                        Text("Zamanlanmış yayın yok").font(.caption)
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
    }
}

private struct LargeView: View {
    let entry: StudioEntry

    var body: some View {
        if entry.snapshot == nil, let problem = entry.problem {
            ProblemView(text: problem).widgetURL(entry.primaryURL)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Link(destination: entry.approvalsURL) {
                    HStack(alignment: .firstTextBaseline) {
                        ApprovalsBlock(count: entry.approvals, big: false)
                        Spacer()
                        Footnote(text: entry.footnote)
                    }
                }
                Divider()
                Text("Sıradaki yayınlar").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if let upcoming = entry.snapshot?.upcoming, !upcoming.isEmpty {
                    ForEach(upcoming) { row in
                        UpcomingRow(row: row, image: row.thumbnailAssetId.flatMap { entry.thumbnails[$0] }, now: entry.date)
                    }
                } else {
                    Text("Zamanlanmış yayın yok").font(.caption).foregroundStyle(.secondary)
                }
                if let attention = entry.snapshot?.attention, !attention.isEmpty {
                    Divider()
                    Link(destination: entry.failuresURL) {
                        VStack(alignment: .leading, spacing: 6) {
                            FailureLine(count: entry.failures)
                            ForEach(attention) { item in
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
                                    Text("\(item.brandName) · \(item.reason)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct CircularView: View {
    let entry: StudioEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Text(entry.snapshot == nil ? "–" : "\(entry.approvals)")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                Text("onay").font(.system(size: 10))
            }
        }
        .widgetURL(entry.approvalsURL)
    }
}

private struct RectangularView: View {
    let entry: StudioEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if entry.snapshot == nil, let problem = entry.problem {
                Text("Studio").font(.headline)
                Text(problem).font(.caption2).lineLimit(2)
            } else {
                Text("\(entry.approvals) onay bekliyor").font(.headline).lineLimit(1)
                if let next = entry.next {
                    Text("Sıradaki: \(TurkishFormat.relativeDayTime(next.scheduledAt, now: entry.date))").font(.caption2).lineLimit(1)
                }
                if entry.failures > 0 {
                    Text(entry.failures == 1 ? "1 yayın başarısız" : "\(entry.failures) yayın başarısız").font(.caption2.weight(.semibold)).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(entry.primaryURL)
    }
}

private struct InlineView: View {
    let entry: StudioEntry

    var body: some View {
        if entry.snapshot == nil {
            Text("Studio: bağlı değil")
        } else if let next = entry.next {
            Text("\(entry.approvals) onay · \(TurkishFormat.relativeDayTime(next.scheduledAt, now: entry.date))")
        } else {
            Text("\(entry.approvals) post onay bekliyor")
        }
    }
}
