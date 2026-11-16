import SwiftUI

/// Contents of the selected brand, filterable by status, paged.
struct ContentListView: View {
    @Environment(AppModel.self) private var app
    @State private var model = ContentListModel()
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            RequiresBrand { brand in
                VStack(spacing: 0) {
                    Picker("Durum", selection: $model.filter) {
                        ForEach(ContentListModel.Filter.allCases) { filter in
                            Text(filter.label).tag(filter)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("statusFilter")

                    if let error = model.items.error, model.items.value != nil {
                        StaleDataBanner(error: error)
                    }

                    LoadableView(
                        loadable: model.items, isEmpty: { $0.isEmpty },
                        retry: { await model.reload(api: app.api, brandId: brand.id) }
                    ) {
                        ContentUnavailableView(
                            "İçerik yok", systemImage: "rectangle.stack",
                            description: Text(model.filter == .all
                                              ? "Yeni sekmesinden bir brif gönderin."
                                              : "Bu durumda içerik yok."))
                    } content: { items in
                        List {
                            ForEach(items) { content in
                                NavigationLink(value: content.id) { ContentRow(content: content) }
                                    .onAppear {
                                        if content.id == items.last?.id {
                                            Task { await model.loadMore(api: app.api, brandId: brand.id) }
                                        }
                                    }
                            }
                            if model.isLoadingMore {
                                HStack { Spacer(); ProgressView(); Spacer() }
                            }
                        }
                        .listStyle(.plain)
                    }
                    .refreshable { await model.reload(api: app.api, brandId: brand.id) }
                }
                .task(id: "\(brand.id)-\(model.filter.rawValue)-\(app.contentRevision)") {
                    await model.reload(api: app.api, brandId: brand.id)
                }
            }
            .navigationTitle("İnceleme")
            .navigationDestination(for: String.self) { id in
                ContentDetailView(contentId: id)
            }
            .toolbar { ToolbarItem(placement: .topBarLeading) { BrandSwitcher() } }
            .onChange(of: app.pendingContentId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                app.pendingContentId = nil
            }
        }
    }
}

@MainActor
@Observable
final class ContentListModel {
    enum Filter: String, CaseIterable, Identifiable {
        case all, review, approved, scheduled, draft

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "Tümü"
            case .review: "İncelemede"
            case .approved: "Onaylı"
            case .scheduled: "Zamanlı"
            case .draft: "Taslak"
            }
        }

        var status: ContentStatus? {
            switch self {
            case .all: nil
            case .review: .inReview
            case .approved: .approved
            case .scheduled: .scheduled
            case .draft: .draft
            }
        }
    }

    var filter: Filter = .all
    var items = Loadable<[Content]>()
    private(set) var nextCursor: String?
    private(set) var isLoadingMore = false

    func reload(api: APIClient, brandId: String) async {
        items.begin()
        do {
            let page = try await api.contents(brandId: brandId, status: filter.status)
            items.succeed(page.items)
            nextCursor = page.nextCursor
        } catch {
            items.fail(error)
        }
    }

    func loadMore(api: APIClient, brandId: String) async {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.contents(brandId: brandId, status: filter.status, cursor: cursor)
            items.succeed((items.value ?? []) + page.items)
            nextCursor = page.nextCursor
        } catch {
            items.fail(error)
        }
    }
}

struct ContentRow: View {
    let content: Content

    private var versionLine: String {
        let version = content.currentVersion.map { "Sürüm \($0.version)" } ?? "Sürüm yok"
        return "\(version) · \(Formatting.relative(content.updatedAt))"
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: content.type.symbol)
                .font(.title2)
                .frame(width: 40, height: 50)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(content.title).font(.body.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    StatusBadge(content.status)
                    Text(content.type.label).font(.caption).foregroundStyle(.secondary)
                    PlatformChips(platforms: content.targetPlatforms)
                }
                Text(versionLine).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("contentRow")
    }
}
