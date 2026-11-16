import PhotosUI
import SwiftUI

/// Write a brief, pick type and platforms, attach media, send to the Mac.
struct ComposeView: View {
    @Environment(AppModel.self) private var app
    @State private var model = ComposeModel()
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var briefFocused: Bool

    var body: some View {
        NavigationStack {
            RequiresBrand { brand in
                switch model.phase {
                case .submitted(let content, let job):
                    SubmittedView(content: content, job: job) { model.reset() }
                default:
                    form(brand: brand)
                }
            }
            .navigationTitle("Yeni brif")
            .toolbar { ToolbarItem(placement: .topBarLeading) { BrandSwitcher() } }
            .onChange(of: app.selectedBrandId) { _, _ in
                // Uploaded assets belong to the previous brand.
                model.clearAttachments()
            }
        }
    }

    @ViewBuilder
    private func form(brand: Brand) -> some View {
        @Bindable var model = model
        Form {
            Section {
                TextField("Ne üretilsin? Konu, ton, çağrı, tarih…", text: $model.brief, axis: .vertical)
                    .lineLimit(5...14)
                    .focused($briefFocused)
                    .textInputAutocapitalization(.sentences)
                    .accessibilityLabel("Brif")
                    .accessibilityIdentifier("briefField")
            } header: {
                Text("Brif")
            } footer: {
                Text("Klavyedeki mikrofonla dikte edebilirsiniz. Marka: \(brand.name)")
            }

            Section {
                TextField("Başlık (isteğe bağlı)", text: $model.title)
                    .accessibilityIdentifier("titleField")
            } footer: {
                if model.title.trimmingCharacters(in: .whitespaces).isEmpty, !model.resolvedTitle.isEmpty {
                    Text("Başlık boş kalırsa: “\(model.resolvedTitle)”")
                }
            }

            Section("İçerik türü") {
                Picker("Tür", selection: $model.type) {
                    ForEach(ContentType.knownCases) { type in
                        Text(type.label).tag(type)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("typePicker")
            }

            Section("Platformlar") {
                ForEach(Platform.knownCases) { platform in
                    Toggle(platform.label, isOn: Binding(
                        get: { model.platforms.contains(platform) },
                        set: { on in
                            if on { model.platforms.insert(platform) } else { model.platforms.remove(platform) }
                        }))
                }
            }

            Section {
                ForEach(model.attachments) { attachment in
                    AttachmentRow(attachment: attachment) {
                        model.retryUpload(attachment.id, api: app.api, brandId: brand.id)
                    } remove: {
                        model.remove(attachment.id)
                    }
                }
                PhotosPicker(selection: $pickerItems, maxSelectionCount: 10,
                             matching: .any(of: [.images, .videos])) {
                    Label("Fotoğraf ya da video ekle", systemImage: "photo.on.rectangle.angled")
                }
                .accessibilityIdentifier("attachButton")
            } header: {
                Text("Ekler")
            } footer: {
                Text("Fotoğraflar JPEG'e çevrilir (en fazla 20 MB); videolar MP4/MOV, en fazla 50 MB.")
            }

            Section {
                if case .jobFailed(_, let error) = model.phase {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("İçerik oluşturuldu ama üretim işi kuyruğa eklenemedi.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        Text(error.localizedDescription).font(.footnote).foregroundStyle(.secondary)
                        Button("Üretimi yeniden dene") { Task { await model.retryJob(api: app.api) } }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    Button {
                        briefFocused = false
                        Task {
                            await model.submit(api: app.api, brandId: brand.id)
                            if case .submitted = model.phase { app.contentDidChange() }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if model.phase == .submitting {
                                ProgressView()
                            } else {
                                Label("Mac'e gönder", systemImage: "paperplane.fill").font(.headline)
                            }
                            Spacer()
                        }
                    }
                    .disabled(!model.canSubmit)
                    .accessibilityIdentifier("submitButton")
                }
            } footer: {
                if let message = model.validationMessage, !model.trimmedBrief.isEmpty || model.isUploading {
                    Text(message)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            importItems(items, brandId: brand.id)
            pickerItems = []
        }
        .alert(failedTitle, isPresented: Binding(
            get: { if case .failed = model.phase { true } else { false } },
            set: { if !$0 { model.dismissError() } })
        ) {
            Button("Tamam", role: .cancel) { model.dismissError() }
        } message: {
            if case .failed(let error) = model.phase { Text(error.localizedDescription) }
        }
    }

    private var failedTitle: String {
        if case .failed(let error) = model.phase { return error.title }
        return ""
    }

    private func importItems(_ items: [PhotosPickerItem], brandId: String) {
        let api = app.api
        for item in items {
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            let id = model.addPlaceholder(isVideo: isVideo)
            Task {
                do {
                    let imported = try await MediaImport.load(item)
                    model.prepared(id, imported, api: api, brandId: brandId)
                } catch {
                    model.preparationFailed(id, message: error.localizedDescription)
                }
            }
        }
    }
}

private struct AttachmentRow: View {
    let attachment: ComposeModel.Attachment
    var retry: () -> Void
    var remove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                if let thumbnail = attachment.thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Image(systemName: attachment.isVideo ? "video" : "photo").foregroundStyle(.secondary)
                }
            }
            .frame(width: 52, height: 52)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(attachment.isVideo ? "Video" : "Fotoğraf").font(.subheadline.weight(.medium))
                switch attachment.state {
                case .preparing:
                    Text("Hazırlanıyor…").font(.caption).foregroundStyle(.secondary)
                case .uploading(let fraction):
                    ProgressView(value: fraction)
                    Text("Yükleniyor \(Formatting.percent(fraction))").font(.caption).foregroundStyle(.secondary)
                case .uploaded(let asset):
                    Label("Yüklendi · \(Formatting.bytes(asset.bytes))", systemImage: "checkmark.circle.fill")
                        .font(.caption).foregroundStyle(.green)
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.red).lineLimit(3)
                }
            }
            Spacer()
            if case .failed = attachment.state, attachment.file != nil {
                Button("Yeniden dene", action: retry).buttonStyle(.borderless).font(.caption)
            }
            Button(role: .destructive, action: remove) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Eki kaldır")
        }
        .accessibilityElement(children: .contain)
    }
}

/// Confirmation after a submit: the job is queued; says plainly whether the Mac will pick it up now.
private struct SubmittedView: View {
    let content: Content
    let job: Job
    var newBrief: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let live = app.jobs.jobs.first { $0.id == job.id } ?? job
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Kuyruğa eklendi", systemImage: "checkmark.seal.fill")
                        .font(.title2.bold())
                        .foregroundStyle(.green)
                    Text(content.title).font(.headline)
                    HStack {
                        StatusBadge(live.status)
                        Text(content.type.label).font(.caption).foregroundStyle(.secondary)
                        PlatformChips(platforms: content.targetPlatforms)
                    }
                    if app.jobs.macOnline == false {
                        Text("Mac şu an çevrimdışı. İş sırada bekliyor; Mac açılınca üretilecek.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("submittedCard")
            }
            Section { MacStatusView(compact: true) }
            Section {
                Button("İşi izle") { app.selectedTab = .jobs }
                Button("İçeriği aç") {
                    app.pendingContentId = content.id
                    app.selectedTab = .review
                }
                Button("Yeni brif", action: newBrief)
                    .accessibilityIdentifier("newBriefButton")
            }
        }
    }
}
