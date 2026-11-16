import Foundation
import Observation
import StudioKit

/// Steps of the first-run flow.
enum OnboardingStep: String, CaseIterable {
    case welcome, claude, server, brand, done

    var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    var title: String {
        switch self {
        case .welcome: "Hoş geldin"
        case .claude: "Claude hesabı"
        case .server: "Mac sunucusu"
        case .brand: "İlk marka"
        case .done: "Hazır"
        }
    }
}

/// First-run flow (welcome → Claude account → Mac server → first brand → done).
///
/// Shown automatically after the first load when there is no brand or Claude is
/// signed out, unless it was completed or skipped. Skipping keeps the step, so
/// "Yardım → Başlangıç rehberi" resumes where it stopped. Completion is final:
/// it never opens by itself again.
@MainActor
@Observable
final class OnboardingModel {
    static let completedKey = "studio.onboarding.completed"
    static let skippedKey = "studio.onboarding.skipped"
    static let stepKey = "studio.onboarding.step"

    weak var app: AppModel?
    private let defaults: UserDefaults

    private(set) var step: OnboardingStep {
        didSet { defaults.set(step.rawValue, forKey: Self.stepKey) }
    }
    private(set) var isCompleted: Bool {
        didSet { defaults.set(isCompleted, forKey: Self.completedKey) }
    }
    private(set) var isSkipped: Bool {
        didSet { defaults.set(isSkipped, forKey: Self.skippedKey) }
    }

    // Claude
    private(set) var fetchedClaude: ClaudeAccount?
    private(set) var claudeReachable: Bool?
    private(set) var isSigningIn = false
    private(set) var isRefreshingClaude = false
    var claudeError: String?
    private var loginTask: Task<Void, Never>?
    /// How often the sign-in is polled, and for how long (the CLI waits at most 10 minutes).
    var pollInterval: Duration = .seconds(2)
    var loginTimeout: Duration = .seconds(600)

    // First brand
    var brandName = "" {
        didSet {
            if !slugEdited { brandSlug = Brand.slugify(brandName) }
        }
    }
    var brandSlug = ""
    var slugEdited = false
    var brandLanguage = "tr"
    var instagramHandle = ""
    private(set) var isCreatingBrand = false
    var brandError: String?
    private(set) var createdBrandId: EntityID?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        step = OnboardingStep(rawValue: defaults.string(forKey: Self.stepKey) ?? "") ?? .welcome
        isCompleted = defaults.bool(forKey: Self.completedKey)
        isSkipped = defaults.bool(forKey: Self.skippedKey)
    }

    // MARK: Presentation

    /// After the app's first load: open by itself when there is something to set up.
    func appDidLoad() async {
        guard let app, !app.isSample, !isCompleted, !isSkipped, !app.onboardingPresented else { return }
        if app.loadError != nil { return }
        await refreshClaudeStatus()
        if Self.needsSetup(brandCount: app.brands.count, claude: claude?.status) {
            app.onboardingPresented = true
        }
    }

    /// Nothing to set up when there is a brand and Claude is signed in (or its state is unknown yet).
    static func needsSetup(brandCount: Int, claude: ClaudeAccountStatus?) -> Bool {
        if brandCount == 0 { return true }
        switch claude {
        case .signedOut?, .notInstalled?, .error?: return true
        default: return false
        }
    }

    /// From the Help menu: resume where it stopped (or start over after completion).
    func reopen(at target: OnboardingStep? = nil) {
        if isCompleted || step == .done { step = .welcome }
        if let target { step = target }
        claudeError = nil
        brandError = nil
        app?.onboardingPresented = true
        Task { await refreshClaudeStatus() }
    }

    /// "Şimdilik geç": close without finishing; it will not open by itself again.
    func skip() {
        loginTask?.cancel()
        isSkipped = true
        app?.onboardingPresented = false
    }

    /// "Bitir": done for good.
    func finish() {
        loginTask?.cancel()
        isCompleted = true
        step = .done
        app?.onboardingPresented = false
    }

    func go(to next: OnboardingStep) {
        step = next
        if next == .claude || next == .server { Task { await refreshClaudeStatus() } }
    }

    func advance() {
        guard let next = OnboardingStep.allCases.first(where: { $0.index == step.index + 1 }) else { return }
        go(to: next)
    }

    func goBack() {
        guard let previous = OnboardingStep.allCases.first(where: { $0.index == step.index - 1 }) else { return }
        go(to: previous)
    }

    // MARK: Claude

    /// Live presence first (it updates on its own), then the last fetched report.
    var claude: ClaudeAccount? {
        app?.presence?.claude ?? fetchedClaude
    }

    var workerOnline: Bool {
        app?.presence?.online == true || claudeReachable == true
    }

    var isClaudeReady: Bool { claude?.status == .signedIn }

    func refreshClaudeStatus() async {
        guard let app else { return }
        do {
            let control = try await app.dataService.claudeControl()
            fetchedClaude = control.account
            claudeReachable = control.online
        } catch {
            claudeReachable = false
        }
    }

    /// Ask the worker to read `claude auth status` again.
    func recheckClaude() async {
        guard let app, !isRefreshingClaude else { return }
        isRefreshingClaude = true
        defer { isRefreshingClaude = false }
        do {
            let control = try await app.dataService.claudeRefresh()
            fetchedClaude = control.account ?? fetchedClaude
            claudeReachable = control.online
            claudeError = nil
            try? await Task.sleep(for: .milliseconds(600))
            await refreshClaudeStatus()
        } catch {
            claudeError = AppModel.describe(error)
        }
    }

    /// "Claude'a giriş yap": the worker runs `claude auth login --claudeai` (the browser opens on
    /// this Mac); poll until it reports `signed_in`, fails or times out.
    func startClaudeLogin() async {
        guard let app, !isSigningIn else { return }
        isSigningIn = true
        claudeError = nil
        do {
            let control = try await app.dataService.claudeLogin()
            fetchedClaude = control.account ?? fetchedClaude
            claudeReachable = control.online
        } catch {
            isSigningIn = false
            claudeError = Self.describeLoginError(error)
            return
        }
        loginTask?.cancel()
        loginTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = ContinuousClock.now + self.loginTimeout
            var sawSigningIn = false
            while !Task.isCancelled, ContinuousClock.now < deadline {
                try? await Task.sleep(for: self.pollInterval)
                if Task.isCancelled { break }
                await self.refreshClaudeStatus()
                switch self.claude?.status {
                case .signedIn?:
                    self.isSigningIn = false
                    return
                case .signingIn?:
                    sawSigningIn = true
                case .signedOut?, .error?, .notInstalled?:
                    // The CLI finished without signing in (closed browser, error).
                    if sawSigningIn {
                        self.isSigningIn = false
                        self.claudeError = self.claude?.detail ?? "Giriş tamamlanmadı. Yeniden dene."
                        return
                    }
                default:
                    break
                }
            }
            if !Task.isCancelled, self.isSigningIn {
                self.isSigningIn = false
                self.claudeError = "Giriş 10 dakika içinde tamamlanmadı. Yeniden dene."
            }
        }
    }

    func cancelClaudeLogin() {
        loginTask?.cancel()
        isSigningIn = false
    }

    static func describeLoginError(_ error: any Error) -> String {
        if let api = error as? StudioAPIError, api.code == .conflict {
            return "Mac worker bağlı değil. Mac sunucusu çalışınca tekrar dene."
        }
        if let api = error as? StudioAPIError, api.code == .forbidden {
            return "Giriş yalnızca bu Mac'ten başlatılabilir."
        }
        return AppModel.describe(error)
    }

    // MARK: First brand

    var existingBrand: Brand? {
        if let createdBrandId, let made = app?.brand(createdBrandId) { return made }
        return app?.brands.first
    }

    /// Why "Markayı oluştur" is disabled, or nil.
    var brandProblem: String? {
        let name = brandName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Marka adını yaz." }
        if brandSlug.count < 2 || brandSlug != Brand.slugify(brandSlug) {
            return "Kısa ad yalnızca küçük harf, rakam ve tire içerebilir."
        }
        return nil
    }

    func createBrand() async {
        guard let app, brandProblem == nil, !isCreatingBrand else { return }
        isCreatingBrand = true
        defer { isCreatingBrand = false }
        do {
            let brand = try await app.createNewBrand(
                name: brandName.trimmingCharacters(in: .whitespacesAndNewlines),
                slug: brandSlug,
                language: brandLanguage
            )
            createdBrandId = brand.id
            brandError = nil
            let handle = BrandSettingsModel.normalizedHandle(instagramHandle, platform: .instagram)
            if !handle.isEmpty {
                do {
                    _ = try await app.dataService.createSocialAccount(SocialAccountCreate(brandId: brand.id, platform: .instagram, handle: handle))
                    await app.refreshAccounts()
                } catch {
                    brandError = "Marka oluşturuldu ama Instagram hesabı eklenemedi: \(AppModel.describe(error))"
                }
            }
            go(to: .done)
        } catch {
            brandError = AppModel.describe(error)
        }
    }

    /// Done: open the new brand's kit so the profile can be extracted.
    func openBrandKit() {
        guard let brand = existingBrand else { return }
        finish()
        app?.openBrandSettings(brand.id, tab: .kit)
    }
}
