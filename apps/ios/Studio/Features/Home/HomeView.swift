import SwiftUI

/// Brand switcher, Mac status, what needs attention, what is coming up.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var model = HomeModel()
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            RequiresBrand { brand in
                List {
                    Section {
                        MacStatusView()
                    }

                    Section {
                        Button {
                            app.selectedTab = .compose
                        } label: {
                            Label("Yeni brif yaz", systemImage: "square.and.pencil")
                                .font(.headline)
                        }
                        .accessibilityIdentifier("homeCompose")
                    }

                    if let error = model.review.error, model.review.value != nil {
                        StaleDataBanner(error: error).listRowInsets(EdgeInsets())
                    }

                    Section("Onay bekleyenler") {
                        switch model.review.phase {
                        case .loading:
                            ProgressView()
                        case .failed(let error):
                            InlineError(error: error) { await model.load(app: app, brandId: brand.id) }
                        case .loaded(let items) where items.isEmpty:
                            Text("Onay bekleyen içerik yok.").foregroundStyle(.secondary)
                        case .loaded(let items):
                            ForEach(items) { content in
                                NavigationLink(value: content) { ContentRow(content: content) }
                            }
                        }
                    }

                    Section("Son işler") {
                        let recent = Array(app.jobs.jobs.prefix(3))
                        if recent.isEmpty {
                            Text("Henüz iş yok.").foregroundStyle(.secondary)
                        } else {
                            ForEach(recent) { job in
                                Button { app.selectedTab = .jobs } label: { JobRow(job: job) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }

                    Section("Yaklaşan paylaşımlar") {
                        switch model.upcoming.phase {
                        case .loading:
                            ProgressView()
                        case .failed(let error):
                            InlineError(error: error) { await model.load(app: app, brandId: brand.id) }
                        case .loaded(let items) where items.isEmpty:
                            Text("Zamanlanmış paylaşım yok.").foregroundStyle(.secondary)
                        case .loaded(let items):
                            ForEach(items.prefix(3)) { schedule in
                                Button { app.selectedTab = .calendar } label: {
                                    ScheduleRow(schedule: schedule, title: model.titles[schedule.contentId])
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .refreshable {
                    await model.load(app: app, brandId: brand.id)
                    await app.jobs.pollOnce()
                }
                .task(id: "\(brand.id)-\(app.contentRevision)") {
                    await model.load(app: app, brandId: brand.id)
                }
                .navigationDestination(for: Content.self) { content in
                    ContentDetailView(contentId: content.id)
                }
            }
            .navigationTitle("Studio")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { BrandSwitcher() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Ayarlar")
                    .accessibilityIdentifier("settingsButton")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }
}

@MainActor
@Observable
final class HomeModel {
    var review = Loadable<[Content]>()
    var upcoming = Loadable<[Schedule]>()
    var titles: [String: String] = [:]

    func load(app: AppModel, brandId: String) async {
        review.begin()
        upcoming.begin()
        let api = app.api
        do {
            async let draft = api.contents(brandId: brandId, status: .inReview, limit: 5)
            async let drafts = api.contents(brandId: brandId, status: .draft, limit: 5)
            let items = try await (draft.items + drafts.items).filter { $0.currentVersion != nil }
            review.succeed(items.sorted { $0.updatedAt > $1.updatedAt })
        } catch {
            review.fail(APIError.from(error))
        }
        do {
            let page = try await api.schedules(brandId: brandId, status: .pending, from: .now, limit: 5)
            upcoming.succeed(page.items)
            titles = await ContentTitles.fetch(ids: page.items.map(\.contentId), api: api, known: titles)
        } catch {
            upcoming.fail(error)
        }
    }
}

/// Small inline error inside a list section.
struct InlineError: View {
    let error: APIError
    var retry: () async -> Void

    var body: some View {
        HStack {
            Label(error.isOffline ? "Çevrimdışı" : error.title, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            Spacer()
            Button("Tekrar dene") { Task { await retry() } }
                .buttonStyle(.borderless)
        }
    }
}

/// Looks up content titles for schedule rows (schedules carry only the id).
enum ContentTitles {
    static func fetch(ids: [String], api: APIClient, known: [String: String]) async -> [String: String] {
        var titles = known
        for id in Set(ids) where titles[id] == nil {
            if let content = try? await api.content(id: id) {
                titles[id] = content.title
            }
        }
        return titles
    }
}
