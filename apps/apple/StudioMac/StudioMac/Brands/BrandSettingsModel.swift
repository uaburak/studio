import AppKit
import Foundation
import Observation
import StudioKit

/// Tabs of the brand settings sheet.
enum BrandSettingsTab: Int, CaseIterable {
    case general, kit, profile, accounts

    var title: String {
        switch self {
        case .general: "Genel"
        case .kit: "Marka kiti"
        case .profile: "Profil"
        case .accounts: "Hesaplar"
        }
    }
}

/// Which brand's settings are open, on which tab.
struct BrandSettingsTarget: Equatable {
    var brandId: EntityID
    var tab: BrandSettingsTab = .general
    /// Start `brand.analyze` as soon as the kit allows it (the inspector's "AI analizi").
    var startAnalysis = false
}

/// Languages offered for a brand's content (BCP 47 tags the contract accepts).
enum BrandLanguage {
    static let options: [(tag: String, label: String)] = [
        ("tr", "Türkçe"), ("en", "İngilizce"), ("de", "Almanca"), ("fr", "Fransızca"),
        ("es", "İspanyolca"), ("it", "İtalyanca"), ("ar", "Arapça"), ("ru", "Rusça"),
    ]

    static func label(_ tag: String) -> String {
        options.first { $0.tag == tag }?.label ?? tag
    }
}

/// State behind the brand settings sheet: brand fields, the brand kit (uploads,
/// palette, autosave), profile versions with the editor, `brand.analyze`
/// progress and the brand's social accounts.
@MainActor
@Observable
final class BrandSettingsModel {
    unowned let app: AppModel
    let brandId: EntityID
    var tab: BrandSettingsTab

    // MARK: Brand

    private(set) var brand: Brand?
    var nameDraft = ""
    var slugDraft = ""
    var languageDraft = "tr"
    private(set) var isSavingBrand = false
    private(set) var isArchiving = false
    var generalMessage: String?
    var generalError: String?

    // MARK: Kit

    enum SaveState: Equatable {
        case idle
        case pending
        case saving
        case saved
        case failed(String)
    }

    struct Upload: Identifiable, Equatable {
        let id = UUID()
        var filename: String
        var slot: Slot
        var progress: Double
        var error: String?

        enum Slot: Equatable { case logo, font, sample }
    }

    private(set) var kit: BrandKit
    private(set) var assets: [EntityID: Asset] = [:]
    private(set) var uploads: [Upload] = []
    private(set) var kitSave: SaveState = .idle
    var kitError: String?
    private var kitSaveTask: Task<Void, Never>?
    /// Debounce for typing (0 in tests).
    var saveDelay: Duration = .milliseconds(700)

    // MARK: Profiles

    private(set) var profiles: [BrandProfile] = []
    private(set) var selectedVersion: Int?
    var draft = ProfileDraft()
    private(set) var isSavingProfile = false
    private(set) var isApproving = false
    var profileMessage: String?
    var profileError: String?

    // MARK: Analysis

    enum Analysis: Equatable {
        case idle
        case starting
        case running(jobId: EntityID, progress: Double?, message: String?)
        case succeeded(version: Int?)
        case failed(String)
    }

    private(set) var analysis: Analysis = .idle
    private var analysisTask: Task<Void, Never>?
    /// Poll interval while a `brand.analyze` job runs (short in tests).
    var pollInterval: Duration = .milliseconds(1500)

    // MARK: Accounts

    private(set) var accounts: [SocialAccount] = []
    var accountsError: String?
    private(set) var savingPlatform: Platform?

    // MARK: Loading

    private(set) var isLoading = false
    private(set) var loadError: String?

    init(app: AppModel, brandId: EntityID, tab: BrandSettingsTab = .general) {
        self.app = app
        self.brandId = brandId
        self.tab = tab
        self.kit = .empty(brandId)
        if let known = app.brand(brandId) ?? app.archivedBrands.first(where: { $0.id == brandId }) {
            adopt(known)
        }
    }

    func stop() {
        analysisTask?.cancel()
        kitSaveTask?.cancel()
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        let data = app.dataService
        do {
            async let kitCall = data.brandKit(brandId: brandId)
            async let assetsCall = data.assets(brandId: brandId, kind: nil)
            async let profilesCall = data.brandProfiles(brandId: brandId)
            async let accountsCall = data.socialAccounts(brandId: brandId)
            async let jobsCall = data.jobs(brandId: brandId)
            if brand == nil {
                let all = try await data.brands() + data.archivedBrands()
                if let found = all.first(where: { $0.id == brandId }) { adopt(found) }
            }
            let loadedKit = try await kitCall
            if kitSave == .idle { kit = loadedKit }
            assets = Dictionary(try await assetsCall.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            applyProfiles(try await profilesCall)
            accounts = try await accountsCall
            loadError = nil
            // A brand.analyze still running (sheet reopened, app relaunched): follow it again.
            if case .idle = analysis,
               let running = try await jobsCall.first(where: { $0.type == .brandAnalyze && $0.status.isActive }) {
                track(running)
            }
        } catch {
            loadError = AppModel.describe(error)
        }
    }

    private func adopt(_ brand: Brand) {
        self.brand = brand
        nameDraft = brand.name
        slugDraft = brand.slug
        languageDraft = brand.defaultLanguage
    }

    // MARK: General

    var isArchived: Bool { brand?.status == .archived }

    var generalDirty: Bool {
        guard let brand else { return false }
        return nameDraft.trimmingCharacters(in: .whitespacesAndNewlines) != brand.name
            || slugDraft.trimmingCharacters(in: .whitespacesAndNewlines) != brand.slug
            || languageDraft != brand.defaultLanguage
    }

    /// nil when the general fields can be saved, else why not.
    var generalProblem: String? {
        let name = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Marka adı boş olamaz." }
        if name.count > 120 { return "Marka adı en fazla 120 karakter olabilir." }
        let slug = slugDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if slug != Brand.slugify(slug) || slug.count < 2 {
            return "Kısa ad yalnızca küçük harf, rakam ve tek tire içerebilir (en az 2 karakter)."
        }
        return nil
    }

    func saveGeneral() async {
        guard let brand, generalDirty, generalProblem == nil, !isSavingBrand else { return }
        isSavingBrand = true
        defer { isSavingBrand = false }
        let name = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = slugDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let updated = try await app.dataService.updateBrand(brand.id, BrandUpdate(
                name: name == brand.name ? nil : name,
                slug: slug == brand.slug ? nil : slug,
                defaultLanguage: languageDraft == brand.defaultLanguage ? nil : languageDraft
            ))
            adopt(updated)
            app.brandChanged(updated)
            generalError = nil
            generalMessage = "Kaydedildi."
        } catch {
            generalError = AppModel.describe(error)
        }
    }

    func archive() async {
        guard !isArchiving, brand?.status == .active else { return }
        isArchiving = true
        defer { isArchiving = false }
        do {
            let updated = try await app.archiveBrand(brandId)
            adopt(updated)
            generalError = nil
            generalMessage = "Marka arşivlendi. Postları ve geçmişi korunuyor; istediğinde geri yükleyebilirsin."
        } catch {
            generalError = AppModel.describe(error)
        }
    }

    func restore() async {
        guard !isArchiving, brand?.status == .archived else { return }
        isArchiving = true
        defer { isArchiving = false }
        do {
            let updated = try await app.restoreBrand(brandId)
            adopt(updated)
            generalError = nil
            generalMessage = "Marka geri yüklendi."
        } catch {
            generalError = AppModel.describe(error)
        }
    }

    // MARK: Kit edits

    func asset(_ id: EntityID) -> Asset? { assets[id] }

    var isUploading: Bool { uploads.contains { $0.error == nil } }

    /// Upload picked files into the kit (logos, fonts or sample posts). Files over a list's limit are refused.
    func addFiles(_ urls: [URL], to slot: Upload.Slot) async {
        var room: Int = switch slot {
        case .logo: BrandKit.maxLogos - kit.logos.count
        case .font: BrandKit.maxFonts - kit.fonts.count
        case .sample: BrandKit.maxSamples - kit.samples.count - uploads.filter { $0.slot == .sample && $0.error == nil }.count
        }
        var skipped = 0
        var files: [UploadFile] = []
        for url in urls {
            guard room > 0 else { skipped += 1; continue }
            room -= 1
            do {
                files.append(try BrandKitFiles.upload(from: url, slot: slot.kitSlot))
            } catch {
                uploads.append(Upload(filename: url.lastPathComponent, slot: slot, progress: 0, error: AppModel.describe(error)))
            }
        }
        // Upload in parallel; each finished file joins the kit in pick order of completion.
        let tasks = files.map { file in
            Task { @MainActor [weak self] in await self?.upload(file, slot: slot) }
        }
        for task in tasks { await task.value }
        if skipped > 0 {
            kitError = switch slot {
            case .sample: "En fazla \(BrandKit.maxSamples) örnek post eklenebilir; \(skipped) dosya eklenmedi."
            case .logo: "En fazla \(BrandKit.maxLogos) logo eklenebilir; \(skipped) dosya eklenmedi."
            case .font: "En fazla \(BrandKit.maxFonts) font eklenebilir; \(skipped) dosya eklenmedi."
            }
        }
    }

    /// Upload one prepared file and add it to the kit.
    func upload(_ file: UploadFile, slot: Upload.Slot) async {
        let item = Upload(filename: file.filename, slot: slot, progress: 0)
        uploads.append(item)
        do {
            let asset = try await app.dataService.uploadAsset(file, brandId: brandId, kind: slot.kitSlot.assetKind) { [weak self] value in
                Task { @MainActor in self?.setUploadProgress(item.id, value) }
            }
            assets[asset.id] = asset
            uploads.removeAll { $0.id == item.id }
            switch slot {
            case .logo:
                let background: BrandKitLogoBackground = Self.looksLikeNegativeLogo(file.filename) ? .dark : (kit.logos.isEmpty ? .any : .light)
                kit.logos.append(BrandKitLogo(assetId: asset.id, background: background))
            case .font:
                let family = BrandKitRules.familyGuess(fromFilename: file.filename)
                let role: BrandKitFontRole = kit.fonts.isEmpty ? .any : .text
                kit.fonts.append(BrandKitFont(assetId: asset.id, family: family, role: role))
            case .sample:
                kit.samples.append(BrandKitSample(assetId: asset.id))
            }
            scheduleKitSave(immediately: true)
        } catch {
            if let index = uploads.firstIndex(where: { $0.id == item.id }) {
                uploads[index].error = AppModel.describe(error)
            }
        }
    }

    private func setUploadProgress(_ id: UUID, _ value: Double) {
        if let index = uploads.firstIndex(where: { $0.id == id }) { uploads[index].progress = value }
    }

    func dismissUploadError(_ id: UUID) {
        uploads.removeAll { $0.id == id }
    }

    static func looksLikeNegativeLogo(_ filename: String) -> Bool {
        filename.range(of: #"(white|beyaz|negatif|negative|dark|koyu|inverse)"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    func removeLogo(_ assetId: EntityID) { kit.logos.removeAll { $0.assetId == assetId }; scheduleKitSave(immediately: true) }
    /// Fonts are keyed by `BrandKitFont.key` (a system font has no file).
    func removeFont(_ key: String) { kit.fonts.removeAll { $0.key == key }; scheduleKitSave(immediately: true) }
    func removeSample(_ assetId: EntityID) { kit.samples.removeAll { $0.assetId == assetId }; scheduleKitSave(immediately: true) }

    func setLogoBackground(_ assetId: EntityID, _ background: BrandKitLogoBackground) {
        guard let index = kit.logos.firstIndex(where: { $0.assetId == assetId }) else { return }
        kit.logos[index].background = background
        scheduleKitSave(immediately: true)
    }

    func setFontFamily(_ key: String, _ family: String) {
        guard let index = kit.fonts.firstIndex(where: { $0.key == key }) else { return }
        kit.fonts[index].family = family
        scheduleKitSave()
    }

    func setFontRole(_ key: String, _ role: BrandKitFontRole) {
        guard let index = kit.fonts.firstIndex(where: { $0.key == key }) else { return }
        kit.fonts[index].role = role
        scheduleKitSave(immediately: true)
    }

    func setFontLicense(_ key: String, _ note: String) {
        guard let index = kit.fonts.firstIndex(where: { $0.key == key }) else { return }
        kit.fonts[index].licenseNote = note
        scheduleKitSave()
    }

    func setSampleCaption(_ assetId: EntityID, _ caption: String) {
        guard let index = kit.samples.firstIndex(where: { $0.assetId == assetId }) else { return }
        let trimmed = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        kit.samples[index].caption = trimmed.isEmpty ? nil : caption
        scheduleKitSave()
    }

    /// Add a palette colour with a free name (`accent`, `accent-2`, …).
    func addColor(hex: String = "#FF6A00") {
        guard kit.palette.count < BrandKit.maxColors else {
            kitError = "En fazla \(BrandKit.maxColors) renk eklenebilir."
            return
        }
        let preferred = ["accent", "ink", "paper", "mist", "accent-deep", "graphite", "stone"]
        let used = Set(kit.palette.map(\.name))
        let name = preferred.first { !used.contains($0) } ?? (1...99).map { "renk-\($0)" }.first { !used.contains($0) } ?? "renk"
        kit.palette.append(BrandKitColor(name: name, hex: BrandKitRules.normalizedHex(hex) ?? "#FF6A00"))
        scheduleKitSave(immediately: true)
    }

    func setColorHex(at index: Int, _ hex: String) {
        guard kit.palette.indices.contains(index) else { return }
        kit.palette[index].hex = BrandKitRules.normalizedHex(hex) ?? hex
        scheduleKitSave()
    }

    func setColorName(at index: Int, _ name: String) {
        guard kit.palette.indices.contains(index) else { return }
        kit.palette[index].name = BrandKitRules.colorName(name) ?? name
        scheduleKitSave()
    }

    func setColorUse(at index: Int, _ use: String) {
        guard kit.palette.indices.contains(index) else { return }
        let trimmed = use.trimmingCharacters(in: .whitespacesAndNewlines)
        kit.palette[index].use = trimmed.isEmpty ? nil : trimmed
        scheduleKitSave()
    }

    func removeColor(at index: Int) {
        guard kit.palette.indices.contains(index) else { return }
        kit.palette.remove(at: index)
        scheduleKitSave(immediately: true)
    }

    func setNotes(_ notes: String) {
        kit.notes = String(notes.prefix(10_000))
        scheduleKitSave()
    }

    /// What blocks saving the kit (bad colour, duplicate name, bad family), or nil.
    var kitProblem: String? {
        var names = Set<String>()
        for color in kit.palette {
            if BrandKitRules.normalizedHex(color.hex) == nil { return "\(color.name): renk #RRGGBB biçiminde olmalı." }
            if BrandKitRules.colorName(color.name) != color.name { return "Renk adı küçük harf, rakam ve tireden oluşmalı (\(color.name))." }
            if !names.insert(color.name).inserted { return "\(color.name) adı iki kez kullanılmış." }
        }
        for font in kit.fonts where !BrandKitRules.isValidFamily(font.family) {
            return "Font adı yalnızca harf, rakam, boşluk ve tire içerebilir (\(font.family.isEmpty ? "boş" : font.family))."
        }
        return nil
    }

    func scheduleKitSave(immediately: Bool = false) {
        kitSaveTask?.cancel()
        kitSave = .pending
        let delay = immediately ? Duration.zero : saveDelay
        kitSaveTask = Task { @MainActor [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard let self, !Task.isCancelled else { return }
            await self.performKitSave()
        }
    }

    /// Save now (before analysis, on close). Returns false when the kit could not be saved.
    @discardableResult
    func saveKitNow() async -> Bool {
        kitSaveTask?.cancel()
        kitSaveTask = nil
        if kitSave == .saved || kitSave == .idle { return true }
        return await performKitSave()
    }

    @discardableResult
    private func performKitSave() async -> Bool {
        if let problem = kitProblem {
            kitSave = .failed(problem)
            return false
        }
        kitSave = .saving
        do {
            let saved = try await app.dataService.saveBrandKit(brandId: brandId, kit.put)
            // Keep edits typed while the request was in flight.
            if kitSave == .saving {
                kit.updatedAt = saved.updatedAt
                kitSave = .saved
            }
            return true
        } catch {
            // Replaced by a newer save (two quick changes): that one reports the state.
            if AppModel.isCancellation(error) { return false }
            kitSave = .failed(AppModel.describe(error))
            return false
        }
    }

    // MARK: Analysis

    var isAnalyzing: Bool {
        switch analysis {
        case .starting, .running: true
        default: false
        }
    }

    /// Why "Profili çıkar" is disabled, or nil.
    var analysisBlocker: String? {
        if isArchived { return "Arşivlenmiş markada profil çıkarılamaz." }
        if let blocker = kit.analysisBlocker { return blocker }
        if isUploading { return "Yüklemeler bitince profil çıkarılabilir." }
        if let problem = kitProblem { return problem }
        if !app.isSample, app.presence?.online != true { return "Arka plan çalışmıyor; Studio hazır olunca profil çıkarılabilir." }
        return nil
    }

    func startAnalysis() async {
        guard !isAnalyzing, analysisBlocker == nil else { return }
        analysis = .starting
        guard await saveKitNow() else {
            analysis = .failed(kitError ?? {
                if case .failed(let message) = kitSave { return message }
                return "Marka kiti kaydedilemedi."
            }())
            return
        }
        do {
            let job = try await app.dataService.analyzeBrand(brandId: brandId, notes: nil)
            track(job)
        } catch {
            analysis = .failed(AppModel.describe(error))
        }
    }

    func cancelAnalysis() async {
        guard case .running(let jobId, _, _) = analysis else { return }
        do {
            _ = try await app.dataService.cancelJob(jobId)
        } catch {
            profileError = AppModel.describe(error)
        }
    }

    /// Follow a `brand.analyze` job: the live job feed when it has it, else polling.
    func track(_ job: Job) {
        analysisTask?.cancel()
        apply(job)
        guard job.status.isActive else {
            // Already finished (fast backend, or reopened after it ended): show the result.
            if job.status == .succeeded {
                analysisTask = Task { @MainActor [weak self] in await self?.analysisSucceeded(job) }
            }
            return
        }
        let jobId = job.id
        let interval = pollInterval
        analysisTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                // Hold the model only between sleeps, so a closed sheet ends the loop.
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                let latest: Job?
                if let live = self.app.jobBoard.jobs.first(where: { $0.id == jobId }), live.status.isTerminal {
                    latest = live
                } else {
                    latest = try? await self.app.dataService.job(jobId)
                }
                guard let latest else { continue }
                self.apply(latest)
                if latest.status.isTerminal {
                    if latest.status == .succeeded { await self.analysisSucceeded(latest) }
                    return
                }
            }
        }
    }

    private func apply(_ job: Job) {
        switch job.status {
        case .queued:
            let waiting = app.presence?.online == true ? "Sırada bekliyor…" : "Arka plan hazır olunca başlayacak."
            analysis = .running(jobId: job.id, progress: nil, message: waiting)
        case .running:
            analysis = .running(jobId: job.id, progress: job.progress, message: job.progressMessage ?? "Çalışıyor…")
        case .succeeded:
            analysis = .succeeded(version: Self.version(of: job))
        case .failed:
            analysis = .failed(job.error.map { "Profil çıkarılamadı: \($0)" } ?? "Profil çıkarılamadı.")
        case .cancelled:
            analysis = .failed("Profil çıkarma iptal edildi.")
        case .unknown:
            break
        }
    }

    static func version(of job: Job) -> Int? {
        job.output?["version"]?.doubleValue.map { Int($0) }
    }

    private func analysisSucceeded(_ job: Job) async {
        do {
            applyProfiles(try await app.dataService.brandProfiles(brandId: brandId))
            if let version = Self.version(of: job) ?? profiles.first?.version {
                select(version)
            }
            tab = .profile
            profileMessage = "Yeni taslak hazır. Gözden geçir, düzenle ve onayla."
        } catch {
            profileError = AppModel.describe(error)
        }
    }

    // MARK: Profiles

    private func applyProfiles(_ list: [BrandProfile]) {
        profiles = list.sorted { $0.version > $1.version }
        if let selectedVersion, profiles.contains(where: { $0.version == selectedVersion }) {
            // Keep the user's edits of the selected draft.
            return
        }
        select(profiles.first(where: \.isCurrent)?.version ?? profiles.first?.version)
    }

    var selectedProfile: BrandProfile? {
        profiles.first { $0.version == selectedVersion }
    }

    var currentProfile: BrandProfile? { profiles.first(where: \.isCurrent) }

    var isEditable: Bool { selectedProfile?.status == .draft }

    var draftDirty: Bool {
        guard let selectedProfile else { return false }
        return draft.differs(from: selectedProfile)
    }

    func select(_ version: Int?) {
        selectedVersion = version
        if let profile = selectedProfile {
            draft = ProfileDraft(profile)
        } else {
            draft = ProfileDraft()
        }
        profileError = nil
    }

    var tokenRows: [ProfileTokens.Row] { ProfileTokens.rows(draft.tokens) }

    /// Change one token; returns the reason when the value is refused.
    @discardableResult
    func setToken(_ row: ProfileTokens.Row, to value: String) -> String? {
        guard isEditable else { return "Onaylı sürüm değiştirilemez; önce yeni taslak oluştur." }
        do {
            draft.tokens = try ProfileTokens.setting(draft.tokens, path: row.path, kind: row.kind, value: value)
            return nil
        } catch {
            return error.message
        }
    }

    func setAllowedNumbers(_ text: String) {
        guard isEditable else { return }
        draft.facts.allowedNumbers = ProfileFacts.numbers(from: text)
    }

    func setStatements(_ text: String) {
        guard isEditable else { return }
        draft.facts.statements = ProfileFacts.lines(from: text)
    }

    func setForbidden(_ text: String) {
        guard isEditable else { return }
        draft.facts.forbidden = ProfileFacts.lines(from: text)
    }

    /// Save the selected draft's edits.
    func saveDraft() async {
        guard let profile = selectedProfile, profile.status == .draft, !isSavingProfile else { return }
        isSavingProfile = true
        defer { isSavingProfile = false }
        do {
            let saved = try await app.dataService.updateBrandProfile(
                brandId: brandId, version: profile.version,
                BrandProfileUpdate(tokens: draft.tokens, designRules: draft.designRules, voice: draft.voice)
            )
            replace(saved)
            draft = ProfileDraft(saved)
            profileError = nil
            profileMessage = "v\(saved.version) taslağı kaydedildi."
        } catch {
            profileError = AppModel.describe(error)
        }
    }

    /// A new draft that starts from the selected version (approved versions are immutable).
    func newDraftFromSelected() async {
        guard !isSavingProfile else { return }
        isSavingProfile = true
        defer { isSavingProfile = false }
        do {
            let tokens = draft.tokens.isEmpty ? ProfileTokens.starter(kit: kit, brand: brand) : draft.tokens
            let created = try await app.dataService.createBrandProfile(
                brandId: brandId,
                BrandProfileCreate(tokens: tokens, designRules: draft.designRules, voice: draft.voice)
            )
            profiles.insert(created, at: 0)
            profiles.sort { $0.version > $1.version }
            select(created.version)
            profileError = nil
            profileMessage = "v\(created.version) taslağı oluşturuldu."
        } catch {
            profileError = AppModel.describe(error)
        }
    }

    /// Approve the selected version (saving a draft's edits first). It becomes the current profile.
    func approveSelected() async {
        guard let profile = selectedProfile, !isApproving, !profile.isCurrent else { return }
        isApproving = true
        defer { isApproving = false }
        do {
            if profile.status == .draft, draftDirty {
                let saved = try await app.dataService.updateBrandProfile(
                    brandId: brandId, version: profile.version,
                    BrandProfileUpdate(tokens: draft.tokens, designRules: draft.designRules, voice: draft.voice)
                )
                replace(saved)
            }
            let approved = try await app.dataService.approveBrandProfile(brandId: brandId, version: profile.version)
            applyProfiles(try await app.dataService.brandProfiles(brandId: brandId))
            select(approved.version)
            profileError = nil
            profileMessage = profile.status == .draft
                ? "v\(approved.version) onaylandı; artık üretimde bu profil kullanılıyor."
                : "v\(approved.version) yeniden geçerli profil yapıldı."
        } catch {
            profileError = AppModel.describe(error)
        }
    }

    private func replace(_ profile: BrandProfile) {
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[index] = profile
        }
    }

    // MARK: Accounts

    func account(for platform: Platform) -> SocialAccount? {
        accounts.first { $0.platform == platform && $0.status != .disabled }
    }

    /// Normalised display handle: `@mtmagro` for Instagram, as typed for pages.
    static func normalizedHandle(_ raw: String, platform: Platform) -> String {
        var handle = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if platform == .instagram, !handle.isEmpty, !handle.hasPrefix("@") { handle = "@" + handle }
        return String(handle.prefix(100))
    }

    /// Register (or rename) the brand's account on a platform. Connecting it is a separate step.
    func saveHandle(_ raw: String, for platform: Platform) async {
        let handle = Self.normalizedHandle(raw, platform: platform)
        guard savingPlatform == nil else { return }
        savingPlatform = platform
        defer { savingPlatform = nil }
        do {
            if let existing = account(for: platform) {
                guard !handle.isEmpty, existing.handle != handle else { return }
                let updated = try await app.dataService.updateSocialAccount(existing.id, SocialAccountUpdate(handle: handle))
                if let index = accounts.firstIndex(where: { $0.id == updated.id }) { accounts[index] = updated }
            } else {
                guard !handle.isEmpty else { return }
                let created = try await app.dataService.createSocialAccount(SocialAccountCreate(brandId: brandId, platform: platform, handle: handle))
                accounts.append(created)
            }
            accountsError = nil
            await app.refreshAccounts()
        } catch {
            accountsError = AppModel.describe(error)
        }
    }

    /// Stop using an account (kept for history as `disabled`).
    func disableAccount(_ id: EntityID) async {
        do {
            let updated = try await app.dataService.updateSocialAccount(id, SocialAccountUpdate(status: .disabled))
            if let index = accounts.firstIndex(where: { $0.id == updated.id }) { accounts[index] = updated }
            accountsError = nil
            await app.refreshAccounts()
        } catch {
            accountsError = AppModel.describe(error)
        }
    }
}

private extension BrandSettingsModel.Upload.Slot {
    var kitSlot: BrandKitFiles.Slot {
        switch self {
        case .logo: .logo
        case .font: .font
        case .sample: .sample
        }
    }
}
