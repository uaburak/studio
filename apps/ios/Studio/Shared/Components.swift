import SwiftUI

// MARK: - State views

/// Loading / error / empty / content switch for a `Loadable`.
struct LoadableView<Value, Content: View, Empty: View>: View {
    let loadable: Loadable<Value>
    var isEmpty: (Value) -> Bool = { _ in false }
    var retry: () async -> Void
    @ViewBuilder var empty: () -> Empty
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch loadable.phase {
        case .loading:
            ProgressView("Yükleniyor…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let error):
            ErrorStateView(error: error, retry: retry)
        case .loaded(let value):
            if isEmpty(value) {
                empty()
            } else {
                content(value)
            }
        }
    }
}

/// Full-screen error with a retry button. Offline gets its own wording and icon.
struct ErrorStateView: View {
    let error: APIError
    var retry: (() async -> Void)?
    @Environment(AppModel.self) private var app

    var body: some View {
        ContentUnavailableView {
            Label(error.isOffline ? "Çevrimdışı" : error.title,
                  systemImage: error.isOffline ? "wifi.slash" : "exclamationmark.triangle")
        } description: {
            VStack(spacing: 6) {
                Text(error.localizedDescription)
                if error.isOffline {
                    Text("Sunucu: \(app.configuration.baseURL.absoluteString)")
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
        } actions: {
            if let retry {
                Button("Tekrar dene") { Task { await retry() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

/// Thin banner above content that is still shown from the last successful load.
struct StaleDataBanner: View {
    let error: APIError

    var body: some View {
        Label {
            Text(error.isOffline ? "Çevrimdışı — son yüklenen veriler gösteriliyor" : error.title)
        } icon: {
            Image(systemName: error.isOffline ? "wifi.slash" : "exclamationmark.triangle")
        }
        .font(.footnote.weight(.medium))
        .padding(.vertical, 6)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
        .background(.yellow.opacity(0.25))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Badges

struct StatusBadge: View {
    let text: String
    let tint: Color
    var symbol: String?

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(tint)
        .background(tint.opacity(0.15), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Durum: \(text)")
    }
}

extension StatusBadge {
    init(_ status: ContentStatus) { self.init(text: status.label, tint: status.tint) }
    init(_ status: JobStatus) { self.init(text: status.label, tint: status.tint, symbol: status.symbol) }
    init(_ status: ScheduleStatus) { self.init(text: status.label, tint: status.tint) }
}

struct PlatformChips: View {
    let platforms: [Platform]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(platforms) { platform in
                Text(platform.shortLabel)
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Platformlar: " + platforms.map(\.label).joined(separator: ", "))
    }
}

// MARK: - Mac presence

/// "Mac çevrimiçi / çevrimdışı" with queue length and stream health.
struct MacStatusView: View {
    @Environment(AppModel.self) private var app
    var compact = false

    var body: some View {
        let jobs = app.jobs
        let presence = jobs.presence
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(dotColor(presence))
                .frame(width: 12, height: 12)
                .padding(.top, 4)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title(presence)).font(.headline)
                if let detail = detail(presence) {
                    Text(detail).font(.subheadline).foregroundStyle(.secondary)
                }
                if !compact {
                    Text(streamText(jobs))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("macStatus")
    }

    private func dotColor(_ presence: WorkerPresence?) -> Color {
        guard let presence else { return .gray }
        return presence.online ? .green : .red
    }

    private func title(_ presence: WorkerPresence?) -> String {
        guard let presence else { return "Mac durumu bilinmiyor" }
        return presence.online ? "Mac çevrimiçi" : "Mac çevrimdışı"
    }

    private func detail(_ presence: WorkerPresence?) -> String? {
        guard let presence else { return nil }
        var parts: [String] = []
        if presence.online {
            if let job = presence.currentJobs.first {
                let progress = job.progress.map { " · \(Formatting.percent($0))" } ?? ""
                parts.append("Çalışıyor: \(job.type.label)\(progress)")
            }
        } else if let last = presence.lastSeenAt {
            parts.append("Son görülme \(Formatting.relative(last))")
        } else {
            parts.append("İşler Mac açılınca işlenecek")
        }
        parts.append(presence.queueLength == 0 ? "Sıra boş" : "Sırada \(presence.queueLength) iş")
        return parts.joined(separator: " · ")
    }

    private func streamText(_ jobs: JobsStore) -> String {
        switch jobs.streamState {
        case .open: return "Canlı bağlantı açık"
        case .connecting: return "Canlı bağlantı kuruluyor…"
        case .waiting(_, let delay):
            let seconds = Int(delay.seconds.rounded(.up))
            return jobs.isPolling
                ? "Canlı bağlantı yok; \(seconds) sn sonra yeniden denenecek, arada yoklanıyor"
                : "Bağlantı koptu; \(seconds) sn sonra yeniden denenecek"
        case .idle: return "Canlı bağlantı kapalı"
        }
    }
}

// MARK: - Brand switcher

struct BrandSwitcher: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            Picker("Marka", selection: Binding(
                get: { app.selectedBrandId },
                set: { app.select(brandId: $0) }
            )) {
                ForEach(app.activeBrands) { brand in
                    Text(brand.name).tag(Optional(brand.id))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(app.selectedBrand?.name ?? "Marka seç")
                    .font(.headline)
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
        }
        .disabled(app.activeBrands.isEmpty)
        .accessibilityLabel("Marka: \(app.selectedBrand?.name ?? "seçilmedi")")
        .accessibilityHint("Başka bir marka seçmek için dokunun")
        .accessibilityIdentifier("brandSwitcher")
    }
}

/// Wraps a tab's content: shows a "no brand" state until a brand is selected.
struct RequiresBrand<Content: View>: View {
    @Environment(AppModel.self) private var app
    @ViewBuilder var content: (Brand) -> Content

    var body: some View {
        if let brand = app.selectedBrand {
            content(brand)
        } else if let error = app.brands.error, app.brands.value == nil {
            ErrorStateView(error: error) { await app.loadBrands() }
        } else if app.brands.value == nil {
            ProgressView("Markalar yükleniyor…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label("Henüz marka yok", systemImage: "tag")
            } description: {
                Text("Markaları web panosundan ekleyin; burada otomatik görünür.")
            } actions: {
                Button("Yenile") { Task { await app.loadBrands() } }
            }
        }
    }
}
