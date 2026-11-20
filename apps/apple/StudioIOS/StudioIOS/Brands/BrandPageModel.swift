import CoreText
import Observation
import StudioKit
import UIKit

/// Everything one brand's page shows and changes, as on the Mac's brand page: the brand itself
/// (name, short name, language, archive), its kit (saved a moment after each change), profile
/// versions, skills, check and special-day settings, products and templates. The page and the
/// pages it pushes share one model, so a change shows everywhere at once.
@MainActor
@Observable
final class BrandPageModel {
    enum SaveState: Hashable {
        case idle, saving, saved
        case failed(String)
    }

    @ObservationIgnored weak var app: IOSAppModel?
    let brandId: EntityID
    /// Kept here too: an archived brand is not in the app's list.
    private(set) var brand: Brand?
    private(set) var kit: BrandKit?
    private(set) var kitError: String?
    private(set) var profiles: [BrandProfile] = []
    private(set) var skills: [BrandSkill] = []
    private(set) var skillsError: String?
    private(set) var templates: [ContentTemplate] = []
    private(set) var templatesError: String?
    private(set) var checks: BrandCheckSettings?
    private(set) var planning: BrandPlanningSettings?
    /// The brand's font files, for their names.
    private(set) var fontAssets: [EntityID: Asset] = [:]
    let products: IOSProductsModel
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    var error: String?
    /// The kit's save-as-you-go state, said at the top of Kit.
    private(set) var kitSave: SaveState = .idle
    private(set) var settingsSave: SaveState = .idle
    /// Files being uploaded into the kit.
    private(set) var uploads = 0
    /// Font faces read from the kit's font files (nil while loading or when they cannot be read).
    private(set) var fontFaces: [EntityID: UIFontDescriptor] = [:]
    @ObservationIgnored private var fontsTried: Set<EntityID> = []
    @ObservationIgnored private var kitTask: Task<Void, Never>?
    @ObservationIgnored private var pendingKit: BrandKitPut?
    @ObservationIgnored private var checksTask: Task<Void, Never>?
    @ObservationIgnored private var planningTask: Task<Void, Never>?
    /// Jobs of this brand that were running when last seen (their end reloads what they wrote).
    @ObservationIgnored private var runningJobs: [EntityID: JobType] = [:]

    init(app: IOSAppModel, brandId: EntityID) {
        self.app = app
        self.brandId = brandId
        self.brand = app.brand(brandId)
        self.products = IOSProductsModel(app: app, brandId: brandId)
    }

    var service: (any StudioDataService)? { app?.dataService }

    var overview: BrandOverview? {
        guard let brand else { return nil }
        return BrandOverview(brand: brand, kit: kit, profile: BrandOverview.cardProfile(profiles), accounts: app?.accounts ?? [])
    }

    var isCurrent: Bool { app?.currentBrandId == brandId }
    var isArchived: Bool { brand?.status == .archived }

    /// The draft newer than the approved profile (waiting for approval).
    var waitingDraft: BrandProfile? {
        let current = profiles.first { $0.isCurrent }
        return profiles.filter { $0.status == .draft && $0.version > (current?.version ?? 0) }.max { $0.version < $1.version }
    }

    // MARK: Loading

    func load() async {
        guard let service else { return }
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        if brand == nil { brand = app?.brand(brandId) }
        if brand == nil {
            let archived = (try? await service.archivedBrands()) ?? []
            brand = archived.first { $0.id == brandId }
        }
        let id = brandId
        async let kitResult = Self.result { try await service.brandKit(brandId: id) }
        async let profilesResult = Self.result { try await service.brandProfiles(brandId: id) }
        async let skillsResult = Self.result { try await service.brandSkills(brandId: id) }
        async let templatesResult = Self.result { try await service.templates(brandId: id) }
        async let checksResult = Self.result { try await service.checkSettings(brandId: id) }
        async let planningResult = Self.result { try await service.planningSettings(brandId: id) }
        async let fontsResult = Self.result { try await service.assets(brandId: id, kind: .font) }
        switch await kitResult {
        case .success(let loaded):
            // A change waiting to be saved stays on screen.
            if pendingKit == nil { kit = loaded }
            kitError = nil
        case .failure(let failure):
            if Self.isNotFound(failure) { kit = .empty(brandId) } else { kitError = "Marka kiti okunamadı: \(IOSAppModel.describe(failure))" }
        }
        switch await profilesResult {
        case .success(let loaded):
            profiles = loaded.sorted { $0.version > $1.version }
            error = nil
        case .failure(let failure):
            error = IOSAppModel.describe(failure)
        }
        switch await skillsResult {
        case .success(let loaded): skills = loaded; skillsError = nil
        case .failure(let failure): skillsError = IOSAppModel.describe(failure)
        }
        switch await templatesResult {
        case .success(let loaded): templates = loaded; templatesError = nil
        case .failure(let failure): templatesError = IOSAppModel.describe(failure)
        }
        if case .success(let loaded) = await checksResult, checksTask == nil { checks = loaded }
        if case .success(let loaded) = await planningResult, planningTask == nil { planning = loaded }
        if case .success(let loaded) = await fontsResult { fontAssets = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
        await products.load()
        loadFontFaces()
    }

    private static func result<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async -> Result<T, any Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    private static func isNotFound(_ error: any Error) -> Bool {
        if case .server(let status, _, _, _)? = error as? StudioAPIError { return status == 404 }
        return false
    }

    /// Reloads what a finished analysis or skill draft wrote.
    func jobsChanged(_ jobs: [Job]) {
        let mine = jobs.filter { $0.brandId == brandId && ($0.type == .brandAnalyze || $0.type == .brandSkillDraft) }
        let running = Dictionary(mine.filter { !$0.status.isTerminal }.map { ($0.id, $0.type) }, uniquingKeysWith: { a, _ in a })
        let ended = runningJobs.filter { running[$0.key] == nil }
        runningJobs = running
        guard !ended.isEmpty else { return }
        Task { await self.reload(profiles: ended.values.contains(.brandAnalyze), skills: ended.values.contains(.brandSkillDraft)) }
    }

    private func reload(profiles reloadProfiles: Bool, skills reloadSkills: Bool) async {
        guard let service else { return }
        if reloadProfiles, let loaded = try? await service.brandProfiles(brandId: brandId) {
            profiles = loaded.sorted { $0.version > $1.version }
            if pendingKit == nil, let loadedKit = try? await service.brandKit(brandId: brandId) { kit = loadedKit }
        }
        if reloadSkills, let loaded = try? await service.brandSkills(brandId: brandId) { skills = loaded }
    }

    func runningJob(_ type: JobType) -> Job? {
        app?.jobBoard.jobs.first { $0.type == type && $0.brandId == brandId && !$0.status.isTerminal }
    }

    // MARK: Brand

    @discardableResult
    func updateBrand(_ input: BrandUpdate) async -> String? {
        guard let service, let app else { return nil }
        do {
            let saved = try await service.updateBrand(brandId, input)
            brand = saved
            // The app's list holds the active brands.
            if saved.status == .archived {
                app.brands.removeAll { $0.id == saved.id }
                // The current brand went to the archive: another one takes its place.
                if app.currentBrandId == saved.id, let next = app.brands.first { app.selectBrand(next.id) }
            } else if let index = app.brands.firstIndex(where: { $0.id == saved.id }) {
                app.brands[index] = saved
            } else {
                app.brands.append(saved)
            }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    /// "AI ile analiz et": a `brand.analyze` job; its draft profile arrives for approval.
    func analyze() async -> String? {
        guard let service, let brand else { return nil }
        if let blocker = BrandOverview.analysisBlocker(brand: brand, kit: kit, workerOnline: app?.isOnline == true || app?.isSample == true) {
            return blocker
        }
        do {
            let job = try await service.analyzeBrand(brandId: brandId, notes: nil)
            if !job.status.isTerminal { runningJobs[job.id] = .brandAnalyze } else { await reload(profiles: true, skills: false) }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    // MARK: Kit (saved as you go)

    /// Change the kit; it is saved a moment after the last change (as on the Mac).
    func changeKit(_ change: (inout BrandKit) -> Void) {
        var next = kit ?? .empty(brandId)
        change(&next)
        kit = next
        let put = next.put
        if let problem = BrandKitRules.problem(put) {
            kitSave = .failed(problem)
            pendingKit = nil
            return
        }
        pendingKit = put
        kitSave = .saving
        kitTask?.cancel()
        kitTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await self?.saveKit()
        }
    }

    /// Saves a waiting change now (leaving the page).
    func flushKit() {
        guard pendingKit != nil else { return }
        kitTask?.cancel()
        Task { await saveKit() }
    }

    private func saveKit() async {
        guard let service, let put = pendingKit else { return }
        pendingKit = nil
        do {
            let saved = try await service.saveBrandKit(brandId: brandId, put)
            if pendingKit == nil { kit = saved }
            kitSave = .saved
        } catch {
            kitSave = .failed(IOSAppModel.describe(error))
        }
    }

    /// Uploads files into the kit as logos, fonts or sample posts.
    func upload(_ files: [UploadFile], kind: AssetKind) async {
        guard let service else { return }
        uploads += files.count
        for file in files {
            defer { uploads -= 1 }
            do {
                let asset = try await service.uploadAsset(file, brandId: brandId, kind: kind) { _ in }
                switch kind {
                case .logo:
                    let background: BrandKitLogoBackground = BrandKitRules.looksLikeNegativeLogo(file.filename) ? .dark : .any
                    changeKit { $0.logos.append(BrandKitLogo(assetId: asset.id, background: background)) }
                case .font:
                    fontAssets[asset.id] = asset
                    changeKit { $0.fonts.append(BrandKitFont(assetId: asset.id, family: BrandKitRules.familyGuess(fromFilename: file.filename))) }
                    loadFontFaces()
                default:
                    changeKit { kit in
                        guard kit.samples.count < BrandKit.maxSamples else { return }
                        kit.samples.append(BrandKitSample(assetId: asset.id))
                    }
                }
            } catch {
                kitSave = .failed("\(file.filename): \(IOSAppModel.describe(error))")
            }
        }
    }

    // MARK: Fonts in their face

    /// Reads the kit's font files so their names can be drawn in them.
    func loadFontFaces() {
        guard let app else { return }
        for font in kit?.fonts ?? [] {
            guard let id = font.assetId, !font.isSystem, !fontsTried.contains(id) else { continue }
            fontsTried.insert(id)
            Task {
                guard let data = await app.images.data(id) else { return }
                if let descriptor = CTFontManagerCreateFontDescriptorFromData(data as CFData) {
                    self.fontFaces[id] = descriptor as UIFontDescriptor
                }
            }
        }
    }

    /// The font to draw a kit font's name in: its file, the family when this iPhone has it,
    /// else nil (the app's font, with a note).
    func face(_ font: BrandKitFont, size: CGFloat) -> UIFont? {
        if let id = font.assetId, let descriptor = fontFaces[id] { return UIFont(descriptor: descriptor, size: size) }
        return Self.installedFace(font.family, size: size)
    }

    /// A family this iPhone has (system fonts like Avenir Next, Helvetica Neue, Futura).
    static func installedFace(_ family: String, size: CGFloat) -> UIFont? {
        let wanted = family.trimmingCharacters(in: .whitespaces).lowercased()
        guard let match = UIFont.familyNames.first(where: { $0.lowercased() == wanted }) else { return nil }
        return UIFont(descriptor: UIFontDescriptor(fontAttributes: [.family: match]), size: size)
    }

    func fileName(_ font: BrandKitFont) -> String? {
        font.assetId.flatMap { fontAssets[$0]?.originalFilename }
    }

    // MARK: Profiles

    func createProfile(_ input: BrandProfileCreate) async -> Result<BrandProfile, BrandFormProblem> {
        guard let service else { return .failure(BrandFormProblem("Bağlantı yok.")) }
        do {
            let made = try await service.createBrandProfile(brandId: brandId, input)
            profiles = ((try? await service.brandProfiles(brandId: brandId)) ?? profiles + [made]).sorted { $0.version > $1.version }
            return .success(made)
        } catch {
            return .failure(BrandFormProblem(IOSAppModel.describe(error)))
        }
    }

    func updateProfile(_ version: Int, _ input: BrandProfileUpdate) async -> String? {
        guard let service else { return nil }
        do {
            let saved = try await service.updateBrandProfile(brandId: brandId, version: version, input)
            profiles = profiles.map { $0.version == saved.version ? saved : $0 }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    func approveProfile(_ version: Int) async -> String? {
        guard let service else { return nil }
        do {
            _ = try await service.approveBrandProfile(brandId: brandId, version: version)
            if let loaded = try? await service.brandProfiles(brandId: brandId) { profiles = loaded.sorted { $0.version > $1.version } }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    // MARK: Skills

    func saveSkill(_ skill: BrandSkill?, name: String, description: String, body: String, note: String) async -> Result<BrandSkill, BrandFormProblem> {
        guard let service else { return .failure(BrandFormProblem("Bağlantı yok.")) }
        let others = skills.filter { $0.id != skill?.id }.map(\.name)
        if let problem = BrandSkillRules.problem(name: name, description: description, body: body, otherNames: others) {
            return .failure(BrandFormProblem(problem))
        }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let saved: BrandSkill
            if let skill {
                saved = try await service.updateBrandSkill(brandId: brandId, id: skill.id, BrandSkillUpdate(
                    name: name.trimmingCharacters(in: .whitespaces), description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    body: body, note: trimmedNote.isEmpty ? nil : trimmedNote))
            } else {
                saved = try await service.createBrandSkill(brandId: brandId, BrandSkillCreate(
                    name: name.trimmingCharacters(in: .whitespaces), description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    body: body, note: trimmedNote.isEmpty ? nil : trimmedNote))
            }
            put(saved)
            return .success(saved)
        } catch {
            return .failure(BrandFormProblem(IOSAppModel.describe(error)))
        }
    }

    func put(_ skill: BrandSkill) {
        if let index = skills.firstIndex(where: { $0.id == skill.id }) { skills[index] = skill } else { skills.append(skill) }
    }

    func setSkill(_ skill: BrandSkill, enabled: Bool) async -> String? {
        guard let service else { return nil }
        put({ var s = skill; s.enabled = enabled; return s }())
        do {
            put(try await service.updateBrandSkill(brandId: brandId, id: skill.id, BrandSkillUpdate(enabled: enabled)))
            return nil
        } catch {
            put(skill)
            return IOSAppModel.describe(error)
        }
    }

    func deleteSkill(_ skill: BrandSkill) async -> String? {
        guard let service else { return nil }
        do {
            try await service.deleteBrandSkill(brandId: brandId, id: skill.id)
            skills.removeAll { $0.id == skill.id }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    func draftSkill(focus: String) async -> String? {
        guard let service, let brand else { return nil }
        if let blocker = BrandSkillRules.draftBlocker(archived: brand.status == .archived, workerOnline: app?.isOnline == true || app?.isSample == true, count: skills.count) {
            return blocker
        }
        do {
            let job = try await service.draftBrandSkill(brandId: brandId, focus: focus)
            if job.status.isTerminal { await reload(profiles: false, skills: true) } else { runningJobs[job.id] = .brandSkillDraft }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    // MARK: Templates

    func updateTemplate(_ template: ContentTemplate, _ input: ContentTemplateUpdate) async -> String? {
        guard let service, !input.isEmpty else { return nil }
        do {
            let saved = try await service.updateTemplate(template.id, input)
            templates = templates.map { $0.id == saved.id ? saved : $0 }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    func deleteTemplate(_ template: ContentTemplate) async -> String? {
        guard let service else { return nil }
        do {
            try await service.deleteTemplate(template.id)
            templates.removeAll { $0.id == template.id }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    func useTemplate(_ template: ContentTemplate, _ input: TemplateUse) async -> Result<TemplateUseResult, BrandFormProblem> {
        guard let service else { return .failure(BrandFormProblem("Bağlantı yok.")) }
        do {
            let result = try await service.useTemplate(template.id, input)
            if let index = templates.firstIndex(where: { $0.id == template.id }) { templates[index].useCount += 1 }
            Task { await app?.posts.load() }
            return .success(result)
        } catch {
            return .failure(BrandFormProblem(IOSAppModel.describe(error)))
        }
    }

    // MARK: Settings (saved as you go)

    func changeChecks(_ change: (inout BrandCheckSettings) -> Void) {
        var next = checks ?? BrandCheckSettings(brandId: brandId)
        change(&next)
        checks = next
        settingsSave = .saving
        checksTask?.cancel()
        let put = next.put
        checksTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled, let self, let service = self.service else { return }
            do {
                let saved = try await service.saveCheckSettings(brandId: self.brandId, put)
                self.checks = saved
                self.settingsSave = .saved
            } catch {
                self.settingsSave = .failed(IOSAppModel.describe(error))
            }
            self.checksTask = nil
        }
    }

    func changePlanning(tags: Set<SectorTag>, disabled: Set<SpecialDayCategory>) {
        var next = planning ?? BrandPlanningSettings(brandId: brandId)
        next.sectorTags = SectorTag.knownCases.filter { tags.contains($0) }
        next.disabledCategories = SpecialDayCategory.knownCases.filter { disabled.contains($0) }
        // Shown as the owner's from now on (the API stamps `updatedAt`).
        next.updatedAt = next.updatedAt ?? Date()
        planning = next
        settingsSave = .saving
        planningTask?.cancel()
        let put = BrandPlanningSettingsPut(tags: tags, disabled: disabled)
        planningTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled, let self, let service = self.service else { return }
            do {
                self.planning = try await service.savePlanningSettings(brandId: self.brandId, put)
                self.settingsSave = .saved
            } catch {
                self.settingsSave = .failed(IOSAppModel.describe(error))
            }
            self.planningTask = nil
        }
    }

    // MARK: Accounts

    func check(_ account: SocialAccount) async -> String? {
        guard let service, let app else { return nil }
        do {
            let checked = try await service.checkSocialAccount(id: account.id, SocialAccountCheckInput(live: true))
            app.accounts = app.accounts.map { $0.id == checked.id ? checked : $0 }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }

    func disconnect(_ account: SocialAccount) async -> String? {
        guard let service, let app else { return nil }
        do {
            let saved = try await service.disconnectSocialAccount(id: account.id)
            app.accounts = app.accounts.map { $0.id == saved.id ? saved : $0 }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }
}
