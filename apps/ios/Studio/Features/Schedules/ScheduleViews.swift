import SwiftUI

/// Pick a date/time (device time zone) and accounts; sends UTC to the API.
struct ScheduleSheet: View {
    let accounts: [SocialAccount]
    var submit: (Date, [SocialAccount]) async -> [String: APIError]
    @State private var date = ScheduleTime.truncatedToMinute(Date.now.addingTimeInterval(3600))
    @State private var selected: Set<String> = []
    @State private var saving = false
    @State private var failures: [String: APIError] = [:]
    @Environment(\.dismiss) private var dismiss

    private let timeZone = TimeZone.current

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Paylaşım zamanı", selection: $date,
                               in: Date.now.addingTimeInterval(ScheduleTime.minimumLead)...,
                               displayedComponents: [.date, .hourAndMinute])
                        .datePickerStyle(.graphical)
                        .environment(\.timeZone, timeZone)
                        .accessibilityIdentifier("scheduleDatePicker")
                } footer: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Saat dilimi: \(ScheduleTime.zoneDescription(timeZone, at: date))")
                        Text("Sunucuya gidecek (UTC): \(ScheduleTime.utcString(ScheduleTime.truncatedToMinute(date)))")
                            .font(.caption.monospaced())
                    }
                }

                Section {
                    if accounts.isEmpty {
                        Text("Bu içeriğin platformlarında bağlı bir hesap yok. Hesapları web panosundan ekleyin.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(accounts) { account in
                        Toggle(isOn: Binding(
                            get: { selected.contains(account.id) },
                            set: { if $0 { selected.insert(account.id) } else { selected.remove(account.id) } })
                        ) {
                            VStack(alignment: .leading) {
                                Text(account.handle)
                                Text("\(account.platform.label) · \(account.status.label)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Hesaplar")
                }

                if !failures.isEmpty {
                    Section("Zamanlanamayanlar") {
                        ForEach(failures.keys.sorted(), id: \.self) { handle in
                            VStack(alignment: .leading) {
                                Text(handle).font(.headline)
                                Text(failures[handle]?.localizedDescription ?? "").font(.footnote).foregroundStyle(.red)
                            }
                        }
                    }
                }
                if let problem = ScheduleTime.validate(ScheduleTime.truncatedToMinute(date)) {
                    Section { Text(problem.localizedDescription).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Zamanla")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Zamanla") { Task { await save() } }
                            .disabled(selected.isEmpty || ScheduleTime.validate(ScheduleTime.truncatedToMinute(date)) != nil)
                            .accessibilityIdentifier("confirmSchedule")
                    }
                }
            }
            .onAppear {
                if accounts.count == 1, let only = accounts.first { selected = [only.id] }
            }
        }
    }

    private func save() async {
        saving = true
        let chosen = accounts.filter { selected.contains($0.id) }
        failures = await submit(ScheduleTime.truncatedToMinute(date), chosen)
        saving = false
        if failures.isEmpty { dismiss() }
    }
}

/// Calendar tab: schedules of the selected brand grouped by day (device time zone).
struct ScheduleListView: View {
    @Environment(AppModel.self) private var app
    @State private var model = ScheduleListModel()
    @State private var cancelling: Schedule?
    @State private var actionError: APIError?

    var body: some View {
        NavigationStack {
            RequiresBrand { brand in
                VStack(spacing: 0) {
                    Picker("Görünüm", selection: $model.scope) {
                        Text("Yaklaşan").tag(ScheduleListModel.Scope.upcoming)
                        Text("Tümü").tag(ScheduleListModel.Scope.all)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.bottom, 8)

                    if let error = model.items.error, model.items.value != nil {
                        StaleDataBanner(error: error)
                    }

                    LoadableView(
                        loadable: model.items, isEmpty: { $0.isEmpty },
                        retry: { await model.load(api: app.api, brandId: brand.id) }
                    ) {
                        ContentUnavailableView(
                            "Zamanlanmış paylaşım yok", systemImage: "calendar",
                            description: Text("Onaylanan bir içeriği İnceleme sekmesinden zamanlayabilirsiniz."))
                    } content: { items in
                        scheduleList(items)
                    }
                    .refreshable { await model.load(api: app.api, brandId: brand.id) }
                }
                .task(id: "\(brand.id)-\(model.scope)-\(app.contentRevision)") {
                    await model.load(api: app.api, brandId: brand.id)
                }
            }
            .navigationTitle("Takvim")
            .navigationDestination(for: String.self) { id in ContentDetailView(contentId: id) }
            .toolbar { ToolbarItem(placement: .topBarLeading) { BrandSwitcher() } }
            .confirmationDialog("Zamanlama iptal edilsin mi?", isPresented: Binding(
                get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }),
                titleVisibility: .visible, presenting: cancelling
            ) { schedule in
                Button("Zamanlamayı iptal et", role: .destructive) {
                    Task {
                        do {
                            _ = try await app.api.cancelSchedule(id: schedule.id)
                            app.contentDidChange()
                        } catch {
                            actionError = APIError.from(error)
                        }
                    }
                }
            } message: { schedule in
                Text("\(Formatting.dateTime(schedule.scheduledAt)) · \(schedule.platform.label)")
            }
            .alert(actionError?.title ?? "", isPresented: Binding(
                get: { actionError != nil }, set: { if !$0 { actionError = nil } })
            ) {
                Button("Tamam", role: .cancel) {}
            } message: {
                Text(actionError?.localizedDescription ?? "")
            }
        }
    }
}

extension ScheduleListView {
    fileprivate func scheduleList(_ items: [Schedule]) -> some View {
        List {
            ForEach(ScheduleListModel.groupByDay(items, timeZone: .current), id: \.day) { group in
                Section(Formatting.day(group.day)) {
                    ForEach(group.items) { schedule in
                        scheduleLink(schedule)
                    }
                }
            }
        }
    }

    private func scheduleLink(_ schedule: Schedule) -> some View {
        NavigationLink(value: schedule.contentId) {
            ScheduleRow(schedule: schedule, title: model.titles[schedule.contentId],
                        account: model.accounts[schedule.socialAccountId])
        }
        .swipeActions {
            if schedule.status == .pending {
                Button("İptal et", role: .destructive) { cancelling = schedule }
            }
        }
        .accessibilityAction(named: "Zamanlamayı iptal et") {
            if schedule.status == .pending { cancelling = schedule }
        }
    }
}

@MainActor
@Observable
final class ScheduleListModel {
    enum Scope: Hashable { case upcoming, all }

    var scope: Scope = .upcoming
    var items = Loadable<[Schedule]>()
    private(set) var titles: [String: String] = [:]
    private(set) var accounts: [String: SocialAccount] = [:]

    func load(api: APIClient, brandId: String) async {
        items.begin()
        do {
            let page: Page<Schedule>
            switch scope {
            case .upcoming:
                page = try await api.schedules(brandId: brandId, status: .pending, from: .now)
            case .all:
                page = try await api.schedules(brandId: brandId)
            }
            items.succeed(page.items)
            if let list = try? await api.socialAccounts(brandId: brandId) {
                accounts = Dictionary(uniqueKeysWithValues: list.items.map { ($0.id, $0) })
            }
            titles = await ContentTitles.fetch(ids: page.items.map(\.contentId), api: api, known: titles)
        } catch {
            items.fail(error)
        }
    }

    struct DayGroup: Equatable {
        var day: Date
        var items: [Schedule]
    }

    /// Groups by local calendar day, days and items in time order.
    nonisolated static func groupByDay(_ schedules: [Schedule], timeZone: TimeZone) -> [DayGroup] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let grouped = Dictionary(grouping: schedules) { calendar.startOfDay(for: $0.scheduledAt) }
        return grouped.keys.sorted().map { day in
            DayGroup(day: day, items: grouped[day]!.sorted { $0.scheduledAt < $1.scheduledAt })
        }
    }
}

struct ScheduleRow: View {
    let schedule: Schedule
    var title: String?
    var account: SocialAccount?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading) {
                Text(Formatting.time(schedule.scheduledAt)).font(.headline.monospacedDigit())
                Text(schedule.platform.label).font(.caption).foregroundStyle(.secondary)
            }
            .frame(minWidth: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                if let title { Text(title).font(.body).lineLimit(2) }
                Text(account?.handle ?? Formatting.dateTime(schedule.scheduledAt))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            StatusBadge(schedule.status)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Formatting.dateTime(schedule.scheduledAt)), \(schedule.platform.label), \(title ?? ""), \(schedule.status.label)")
    }
}
