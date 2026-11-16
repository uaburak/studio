import SwiftUI

/// Review one content item: slides, versions, caption, approve, schedule.
struct ContentDetailView: View {
    let contentId: String
    @Environment(AppModel.self) private var app
    @State private var model: ContentDetailModel
    @State private var slideIndex = 0
    @State private var viewerOpen = false
    @State private var editingCaption = false
    @State private var scheduling = false
    @State private var cancelling: Schedule?

    init(contentId: String) {
        self.contentId = contentId
        _model = State(initialValue: ContentDetailModel(contentId: contentId))
    }

    var body: some View {
        LoadableView(loadable: model.content, retry: { await model.load(api: app.api) }) {
            EmptyView()
        } content: { content in
            List {
                header(content)
                previewSection(content)
                captionSection(content)
                actionsSection(content)
                schedulesSection(content)
                versionsSection(content)
                Section("Brif") {
                    Text(content.brief.isEmpty ? "—" : content.brief)
                        .font(.callout)
                        .textSelection(.enabled)
                }
            }
            .refreshable { await model.load(api: app.api) }
        }
        .navigationTitle(model.content.value?.title ?? "İçerik")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: app.api) }
        .onChange(of: app.jobs.lastFinished) { _, job in
            // A generation/render for this content finished on the Mac: fetch the new version.
            if job?.contentId == contentId { Task { await model.load(api: app.api) } }
        }
        .fullScreenCover(isPresented: $viewerOpen) {
            SlideViewer(slides: model.shown.value?.slides ?? [], index: slideIndex)
                .environment(app)
        }
        .sheet(isPresented: $editingCaption) {
            if let content = model.content.value {
                CaptionEditor(content: content) { caption in
                    let saved = await model.saveCaption(caption, api: app.api)
                    if saved { app.contentDidChange() }
                    return saved
                }
            }
        }
        .sheet(isPresented: $scheduling) {
            ScheduleSheet(accounts: model.schedulableAccounts) { date, accounts in
                let failures = await model.schedule(at: date, accounts: accounts, api: app.api)
                app.contentDidChange()
                return failures
            }
        }
        .confirmationDialog("Zamanlama iptal edilsin mi?", isPresented: Binding(
            get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }),
            titleVisibility: .visible, presenting: cancelling
        ) { schedule in
            Button("Zamanlamayı iptal et", role: .destructive) {
                Task {
                    await model.cancelSchedule(schedule, api: app.api)
                    app.contentDidChange()
                }
            }
        } message: { schedule in
            Text("\(Formatting.dateTime(schedule.scheduledAt)) · \(schedule.platform.label)")
        }
        .alert(model.actionError?.title ?? "", isPresented: Binding(
            get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
        ) {
            Button("Tamam", role: .cancel) {}
        } message: {
            Text(model.actionError?.localizedDescription ?? "")
        }
    }

    // MARK: Sections

    private func header(_ content: Content) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(content.title).font(.title3.bold())
                HStack(spacing: 6) {
                    StatusBadge(content.status)
                    Label(content.type.label, systemImage: content.type.symbol)
                        .font(.caption).foregroundStyle(.secondary)
                    PlatformChips(platforms: content.targetPlatforms)
                }
                if let approval = content.approval {
                    Text("Onaylanan sürüm: \(ContentHash.short(approval.contentHash)) · \(Formatting.dateTime(approval.approvedAt))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func previewSection(_ content: Content) -> some View {
        Section {
            if content.currentVersion == nil {
                ContentUnavailableView {
                    Label("Henüz sürüm yok", systemImage: "hourglass")
                } description: {
                    Text(app.jobs.macOnline == true
                         ? "Mac üretimi bitirdiğinde ilk sürüm burada görünecek."
                         : "Mac çevrimdışı. Üretim, Mac açılınca başlayacak.")
                }
            } else {
                switch model.shown.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                case .failed(let error):
                    InlineError(error: error) {
                        if let number = content.currentVersion?.version { await model.show(version: number, api: app.api) }
                    }
                case .loaded(let version):
                    SlideCarousel(slides: version.slides, index: $slideIndex) { viewerOpen = true }
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                    if version.slides.allSatisfy({ $0.renderedAssetId == nil }) {
                        Label("Render hattı henüz tamamlanmadı; slayt görselleri Mac render ettiğinde gelecek.",
                              systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            if let version = model.shown.value {
                Text("Sürüm \(version.version)\(model.isShowingCurrentVersion ? " (güncel)" : "") · \(version.slideCount) slayt")
            } else {
                Text("Önizleme")
            }
        }
        .onChange(of: model.shown.value?.id) { _, _ in slideIndex = 0 }
    }

    private func captionSection(_ content: Content) -> some View {
        Section {
            Text(content.caption.isEmpty ? "Açıklama yok." : content.caption)
                .foregroundStyle(content.caption.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
            if content.status.allowsCaptionEdit {
                Button("Açıklamayı düzenle", systemImage: "pencil") { editingCaption = true }
                    .accessibilityIdentifier("editCaption")
            }
        } header: {
            Text("Açıklama")
        }
    }

    @ViewBuilder
    private func actionsSection(_ content: Content) -> some View {
        Section {
            switch model.approval {
            case .verifying, .approving:
                HStack { ProgressView(); Text("Onaylanıyor…").foregroundStyle(.secondary) }
            case .confirming(let version, let hash):
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sürüm \(version) onaylansın mı?").font(.headline)
                    Text("Slaytlar telefonda doğrulandı (hash \(ContentHash.short(hash))). Onaydan sonra zamanlayabilirsiniz.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        Button("Onayla") { Task { await model.confirmApproval(api: app.api); app.contentDidChange() } }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("confirmApprove")
                        Button("Vazgeç") { model.dismissApproval() }
                            .buttonStyle(.bordered)
                    }
                }
            case .outdated(let message):
                VStack(alignment: .leading, spacing: 6) {
                    Label(message, systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                    Button("Tamam") { model.dismissApproval() }.buttonStyle(.borderless)
                }
            case .failed(let error):
                VStack(alignment: .leading, spacing: 6) {
                    Label(error.title, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    Text(error.localizedDescription).font(.footnote).foregroundStyle(.secondary)
                    Button("Tamam") { model.dismissApproval() }.buttonStyle(.borderless)
                }
            case .idle:
                if content.status.isApprovable && content.currentVersion != nil {
                    Button {
                        Task { await model.beginApproval(api: app.api) }
                    } label: {
                        Label(model.isShowingCurrentVersion ? "Bu sürümü onayla" : "Önce güncel sürümü görüntüleyin",
                              systemImage: "checkmark.seal")
                    }
                    .disabled(!model.canApprove)
                    .accessibilityIdentifier("approveButton")
                }
            }
            if content.status.isSchedulable {
                Button("Zamanla", systemImage: "calendar.badge.plus") { scheduling = true }
                    .accessibilityIdentifier("scheduleButton")
            }
            if content.status == .draft && content.currentVersion != nil {
                Button("İncelemeye gönder", systemImage: "tray.and.arrow.up") {
                    Task { await model.transition(to: .inReview, api: app.api); app.contentDidChange() }
                }
            }
            if content.status == .approved {
                Button("Onayı geri çek", systemImage: "arrow.uturn.backward", role: .destructive) {
                    Task { await model.transition(to: .draft, api: app.api); app.contentDidChange() }
                }
            }
        } header: {
            Text("İşlemler")
        } footer: {
            if content.status == .scheduled {
                Text("Yeni bir sürüm ya da açıklama değişikliği onayı kaldırır ve bekleyen zamanlamaları iptal eder.")
            }
        }
        .disabled(model.isWorking)
    }

    @ViewBuilder
    private func schedulesSection(_ content: Content) -> some View {
        if let schedules = model.schedules.value, !schedules.isEmpty {
            Section("Zamanlamalar") {
                ForEach(schedules) { schedule in
                    ScheduleRow(schedule: schedule, title: nil,
                                account: model.accounts.first { $0.id == schedule.socialAccountId })
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
        }
    }

    @ViewBuilder
    private func versionsSection(_ content: Content) -> some View {
        if let versions = model.versions.value, versions.count > 0 {
            Section("Sürümler") {
                ForEach(versions) { version in
                    Button {
                        Task { await model.show(version: version.version, api: app.api) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Sürüm \(version.version)\(version.id == content.currentVersion?.id ? " · güncel" : "")")
                                    .font(.body.weight(.medium))
                                Text("\(version.origin.label) · \(version.slideCount) slayt · \(Formatting.dateTime(version.createdAt))")
                                    .font(.caption).foregroundStyle(.secondary)
                                if let note = version.note, !note.isEmpty {
                                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            Spacer()
                            if model.shown.value?.id == version.id {
                                Image(systemName: "eye").foregroundStyle(.tint).accessibilityLabel("Gösteriliyor")
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// Caption editor. Warns when saving will drop the approval.
struct CaptionEditor: View {
    let content: Content
    var save: (String) async -> Bool
    @State private var text: String
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    static let limit = 10_000

    init(content: Content, save: @escaping (String) async -> Bool) {
        self.content = content
        self.save = save
        _text = State(initialValue: content.caption)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Açıklama", text: $text, axis: .vertical)
                        .lineLimit(6...20)
                        .accessibilityIdentifier("captionField")
                } footer: {
                    HStack {
                        if content.status.captionEditRevokesApproval {
                            Text("Kaydedince onay kalkar ve bekleyen zamanlamalar iptal edilir.")
                                .foregroundStyle(.orange)
                        }
                        Spacer()
                        Text("\(text.count) / \(Self.limit)")
                            .monospacedDigit()
                            .foregroundStyle(text.count > Self.limit ? .red : .secondary)
                    }
                }
            }
            .navigationTitle("Açıklama")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Kaydet") {
                            Task {
                                saving = true
                                if await save(text) { dismiss() }
                                saving = false
                            }
                        }
                        .disabled(text == content.caption || text.count > Self.limit)
                        .accessibilityIdentifier("saveCaption")
                    }
                }
            }
        }
    }
}
