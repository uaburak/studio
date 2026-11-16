import SwiftUI

/// Live job list for the selected brand, Mac presence, cancel.
struct JobsView: View {
    @Environment(AppModel.self) private var app
    @State private var pendingCancel: Job?
    @State private var actionError: APIError?

    var body: some View {
        NavigationStack {
            RequiresBrand { _ in
                let store = app.jobs
                List {
                    Section { MacStatusView() }

                    if store.streamState != .open, let error = store.pollError {
                        StaleDataBanner(error: error).listRowInsets(EdgeInsets())
                    }

                    if store.jobs.isEmpty {
                        Section {
                            if store.lastUpdated == nil {
                                HStack { ProgressView(); Text("İşler yükleniyor…").foregroundStyle(.secondary) }
                            } else {
                                ContentUnavailableView(
                                    "Henüz iş yok", systemImage: "tray",
                                    description: Text("Yeni sekmesinden bir brif gönderdiğinizde üretim işi burada görünür."))
                            }
                        }
                    }

                    if !store.activeJobs.isEmpty {
                        Section("Etkin") {
                            ForEach(store.activeJobs) { job in row(job) }
                        }
                    }
                    if !store.finishedJobs.isEmpty {
                        Section("Biten") {
                            ForEach(store.finishedJobs) { job in row(job) }
                        }
                    }
                }
                .refreshable { await store.pollOnce() }
                .navigationDestination(for: Job.self) { job in
                    JobDetailView(jobId: job.id)
                }
            }
            .navigationTitle("İşler")
            .toolbar { ToolbarItem(placement: .topBarLeading) { BrandSwitcher() } }
            .confirmationDialog(
                "İş iptal edilsin mi?", isPresented: Binding(
                    get: { pendingCancel != nil }, set: { if !$0 { pendingCancel = nil } }),
                titleVisibility: .visible, presenting: pendingCancel
            ) { job in
                Button("İşi iptal et", role: .destructive) { Task { await cancel(job) } }
                Button("Vazgeç", role: .cancel) {}
            } message: { job in
                Text(job.status == .running
                     ? "Mac işi durdurup onayladığında iptal tamamlanır."
                     : "Sıradaki iş hemen iptal edilir.")
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

    private func row(_ job: Job) -> some View {
        NavigationLink(value: job) { JobRow(job: job) }
            .swipeActions {
                if job.isCancellable {
                    Button("İptal et", role: .destructive) { pendingCancel = job }
                }
            }
            .contextMenu {
                if job.isCancellable {
                    Button("İptal et", systemImage: "xmark.circle", role: .destructive) { pendingCancel = job }
                }
            }
            .accessibilityAction(named: "İptal et") {
                if job.isCancellable { pendingCancel = job }
            }
    }

    private func cancel(_ job: Job) async {
        do {
            try await app.jobs.cancel(job)
        } catch {
            actionError = error
        }
    }
}

struct JobRow: View {
    let job: Job

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(job.displayTitle).font(.body.weight(.medium)).lineLimit(2)
                Spacer()
                StatusBadge(job.status)
            }
            HStack(spacing: 6) {
                Text(job.type.label)
                Text("·")
                Text(Formatting.relative(job.createdAt))
                if job.cancelRequestedAt != nil && job.status == .running {
                    Text("· İptal istendi").foregroundStyle(.orange)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if job.status == .running {
                ProgressView(value: job.progress ?? 0)
                    .accessibilityLabel("İlerleme")
                    .accessibilityValue(Formatting.percent(job.progress ?? 0))
                if let message = job.progressMessage, !message.isEmpty {
                    Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            if job.status == .failed, let error = job.error {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(3)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("jobRow")
    }
}

struct JobDetailView: View {
    let jobId: String
    @Environment(AppModel.self) private var app
    @State private var fetched = Loadable<Job>()

    /// Live version from the stream when available.
    private var job: Job? { app.jobs.jobs.first { $0.id == jobId } ?? fetched.value }

    var body: some View {
        Group {
            if let job {
                Form {
                    Section {
                        LabeledContent("Durum") { StatusBadge(job.status) }
                        LabeledContent("Tür", value: job.type.label)
                        if job.status == .running {
                            LabeledContent("İlerleme", value: Formatting.percent(job.progress ?? 0))
                            if let message = job.progressMessage { Text(message).foregroundStyle(.secondary) }
                        }
                        if let attempts = job.attempts, let max = job.maxAttempts {
                            LabeledContent("Deneme", value: "\(attempts) / \(max)")
                        }
                        if let worker = job.workerId { LabeledContent("Worker", value: worker) }
                    }
                    Section("Zamanlar") {
                        LabeledContent("Oluşturuldu", value: Formatting.dateTime(job.createdAt))
                        if let started = job.startedAt { LabeledContent("Başladı", value: Formatting.dateTime(started)) }
                        if let finished = job.finishedAt { LabeledContent("Bitti", value: Formatting.dateTime(finished)) }
                        if let cancel = job.cancelRequestedAt {
                            LabeledContent("İptal istendi", value: Formatting.dateTime(cancel))
                        }
                    }
                    if let error = job.error {
                        Section("Hata") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                    }
                    if let brief = job.payload["brief"]?.stringValue, !brief.isEmpty {
                        Section("Brif") { Text(brief) }
                    }
                    if let output = job.output, !output.isEmpty {
                        Section("Çıktı") {
                            Text(JSONValue.object(output).prettyPrinted)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                    if job.contentId != nil {
                        Section {
                            Button("İçeriği aç") {
                                app.pendingContentId = job.contentId
                                app.selectedTab = .review
                            }
                        }
                    }
                }
            } else {
                LoadableView(loadable: fetched, retry: load) { EmptyView() } content: { _ in EmptyView() }
            }
        }
        .navigationTitle(job?.displayTitle ?? "İş")
        .navigationBarTitleDisplayMode(.inline)
        .task { if app.jobs.jobs.first(where: { $0.id == jobId }) == nil { await load() } }
    }

    private func load() async {
        fetched.begin()
        do { fetched.succeed(try await app.api.job(id: jobId)) } catch { fetched.fail(error) }
    }
}
