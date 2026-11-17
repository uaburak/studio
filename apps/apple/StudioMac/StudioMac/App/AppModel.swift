import AppKit
import Foundation
import Observation
import StudioKit

/// What the detail column shows.
enum Route: Hashable {
    case newChat
    case conversation(EntityID)
    case posts
    case calendar
    case media
}

/// Sidebar list selection (native `List(selection:)`).
enum SidebarItem: Hashable {
    case posts
    case calendar
    case media
    case conversation(EntityID)
}

/// What the right panel shows. Claude Code style: each top bar icon opens its own pane, and the
/// pane's title and actions sit in the top bar above the panel.
enum RightPanelPane: String, CaseIterable, Codable, Sendable {
    /// Ortam, Kullanım, Bağlam, Hesaplar.
    case details
    /// Background jobs (Claude Code's "Background tasks").
    case jobs

    var title: String {
        switch self {
        case .details: "Ayrıntılar"
        case .jobs: "Arka plan işleri"
        }
    }
}

/// The top bar's mode pill (Claude Code's Chat / Code).
enum AppMode: CaseIterable, Equatable, Sendable {
    case chat
    case posts

    var title: String {
        switch self {
        case .chat: "Sohbet"
        case .posts: "Postlar"
        }
    }

    var symbol: String {
        switch self {
        case .chat: "bubble.left"
        case .posts: "square.grid.2x2"
        }
    }

    var help: String {
        switch self {
        case .chat: "Sohbet: son sohbete dön ya da yeni sohbet (⌘N)"
        case .posts: "Postlar (⇧⌘P)"
        }
    }

    /// The mode a screen belongs to (Takvim and Medya belong to neither).
    static func of(_ route: Route) -> AppMode? {
        switch route {
        case .newChat, .conversation: .chat
        case .posts: .posts
        case .calendar, .media: nil
        }
    }
}

struct BrandProfileTarget: Equatable {
    var brandId: EntityID
    var startAnalysis: Bool = false
}

/// Root state of the window. Talks to StudioKit services only.
@MainActor
@Observable
final class AppModel {
    let settings: AppSettings
    private(set) var conversationService: any ConversationService
    private(set) var dataService: any StudioDataService
    /// True when the services are the in-memory sample.
    private(set) var isSample: Bool

    // Data
    var brands: [Brand] = []
    /// Archived brands (not in the sidebar; restorable from brand settings).
    var archivedBrands: [Brand] = []
    var accounts: [SocialAccount] = []
    var conversations: [Conversation] = []
    var jobBoard = JobBoard()
    /// A notification clicked before the brands loaded (see `openNotice`).
    @ObservationIgnored private(set) var pendingNotice: NoticeDestination?
    var loadError: String?
    /// The typed error behind `loadError` (drives the connection banner).
    private(set) var loadAPIError: StudioAPIError?
    var isLoading = false

    // Navigation
    private(set) var route: Route = .newChat {
        didSet { persistSession() }
    }
    private var back: [Route] = []
    private var forward: [Route] = []
    var sidebarPresented = true {
        didSet { persistSession() }
    }
    var inspectorPresented = true {
        didSet { persistSession() }
    }
    /// The right panel's pane (top bar icons switch it).
    var inspectorPane: RightPanelPane = .details {
        didSet { persistSession() }
    }
    /// The right panel's "expand" (wider) state, from its header in the top bar.
    var inspectorExpanded = false
    /// "Bitenleri temizle": finished jobs up to this moment leave the jobs pane.
    var jobsClearedAt: Date?
    /// The conversation shown last (the mode pill's Sohbet goes back to it).
    private(set) var lastConversationId: EntityID?
    var expandedBrands: Set<EntityID> = []
    /// Brand for a new chat and the posts screen.
    var currentBrandId: EntityID? {
        didSet { persistSession() }
    }
    var searchPresented = false
    /// Settings open as an in-window sheet, not a separate window.
    var settingsPresented = false
    /// Section the settings sheet shows next (deep link); the sheet consumes it.
    var settingsRequestedSection: SettingsSection?
    var newBrandPresented = false
    /// Older entry point (inspector): opens the brand settings on the profile or kit tab.
    var brandProfileTarget: BrandProfileTarget? {
        get { nil }
        set {
            guard let target = newValue else { return }
            openBrandSettings(target.brandId, tab: target.startAnalysis ? .kit : .profile, startAnalysis: target.startAnalysis)
        }
    }
    /// Brand settings sheet (general, kit, profile, accounts).
    var brandSettingsTarget: BrandSettingsTarget?
    /// First-run flow sheet.
    var onboardingPresented = false
    let onboarding: OnboardingModel
    var accountConnectTarget: AccountConnectTarget?
    var aiGeneratorTarget: AIGeneratorTarget?
    /// The last sidebar navigation came from the keyboard (do not steal focus).
    private(set) var navigatedByKeyboard = false
    /// Last selected model / effort across the app (used by Start screen and new conversations).
    private(set) var lastAgentChoice: AgentChoice

    // Screens
    private(set) var conversationModels: [EntityID: ConversationModel] = [:]
    let newChat: NewChatModel
    let posts: PostsModel
    let calendar: CalendarModel
    /// Publishing path, publish log feed and notifications (P3).
    let publishing: PublishingModel
    let media: MediaModel
    let images: ImageStore
    var detail: PostDetailModel?
    var banner: String?
    /// Global search over brands, conversations and every brand's posts.
    let search: SearchModel
    /// The embedded Mac server, when this app runs it (nil: remote server or sample data).
    weak var host: LocalHost? {
        didSet { phonePairing.host = isSample ? nil : host }
    }
    /// "iPhone'u bağla": the QR offer and the paired iPhones (Settings → Cihazlar, start screen).
    let phonePairing = PhonePairingModel()
    /// The start screen's "iPhone'u bağla" card was put off for this session ("Sonra").
    var phonePairingHintDismissed = false
    /// The connection banner the owner closed; it comes back when the issue changes.
    var dismissedIssue: ConnectionIssue?
    private let sessionStore: SessionStore
    /// Off until the saved session was restored, so loading does not overwrite it.
    private var sessionTracking = false

    private var feedTask: Task<Void, Never>?
    let pendingImages = PendingSlotImageStore()

    init(settings: AppSettings, conversationService: (any ConversationService)? = nil, dataService: (any StudioDataService)? = nil) {
        self.settings = settings
        self.lastAgentChoice = settings.agentChoices.last
        if let conversationService, let dataService {
            self.conversationService = conversationService
            self.dataService = dataService
            isSample = conversationService is SampleBackend
        } else if settings.useSampleData {
            let sample = SampleBackend()
            self.conversationService = sample
            self.dataService = sample
            isSample = true
        } else {
            let client = settings.makeClient()
            self.conversationService = RemoteConversationService(client: client)
            self.dataService = RemoteStudioDataService(client: client)
            isSample = false
        }
        images = ImageStore()
        search = SearchModel()
        // Sample data keeps its own session so a demo run does not move the real app's screen.
        let sampleSession = (conversationService.map { $0 is SampleBackend } ?? false) || (conversationService == nil && settings.useSampleData)
        sessionStore = SessionStore(defaults: settings.defaults, key: sampleSession ? SessionStore.key + ".sample" : SessionStore.key)
        onboarding = OnboardingModel(defaults: settings.defaults)
        newChat = NewChatModel()
        posts = PostsModel()
        calendar = CalendarModel()
        publishing = PublishingModel(defaults: settings.defaults)
        media = MediaModel()
        images.app = self
        search.app = self
        onboarding.app = self
        newChat.app = self
        posts.app = self
        calendar.app = self
        publishing.app = self
        media.app = self
        if let saved = sessionStore.load() {
            sidebarPresented = saved.sidebarPresented
            inspectorPresented = saved.inspectorPresented
            inspectorPane = saved.pane
        }
    }

    /// Rebuild the services after the server address or access key changed.
    func reconnect(reload: Bool = true) {
        guard !isSample else { return }
        let client = settings.makeClient()
        conversationService = RemoteConversationService(client: client)
        dataService = RemoteStudioDataService(client: client)
        resetConversations()
        images.clear()
        search.invalidate()
        if reload { Task { await load() } }
    }

    /// Stop every open conversation stream (the services changed); views build fresh models.
    func resetConversations() {
        conversationModels.values.forEach { $0.stop() }
        conversationModels = [:]
    }

    // MARK: Loading

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let brands = dataService.brands()
            async let accounts = dataService.socialAccounts(brandId: nil)
            async let conversations = conversationService.conversations()
            self.brands = try await brands
            self.accounts = try await accounts
            self.conversations = try await conversations
            loadError = nil
            loadAPIError = nil
            if currentBrandId == nil || !self.brands.contains(where: { $0.id == currentBrandId }) {
                currentBrandId = self.conversations.first?.brandId ?? self.brands.first?.id
            }
            if expandedBrands.isEmpty, let brand = currentBrandId { expandedBrands = [brand] }
        } catch {
            loadError = Self.describe(error)
            loadAPIError = StudioAPIError.from(error)
        }
        startJobFeed()
        publishing.start()
        // At launch the app delegate opens it after the session is restored.
        if sessionTracking { openPendingNotice() }
        await refreshArchivedBrands()
        await onboarding.appDidLoad()
    }

    func refreshArchivedBrands() async {
        if let list = try? await dataService.archivedBrands() { archivedBrands = list }
    }

    func refreshConversations() async {
        if let list = try? await conversationService.conversations() { conversations = list }
    }

    func refreshAccounts() async {
        if let list = try? await dataService.socialAccounts(brandId: nil) { accounts = list }
    }

    @discardableResult
    func createNewBrand(name: String, slug: String? = nil, language: String = "tr") async throws -> Brand {
        let created = try await dataService.createBrand(BrandCreate(name: name, slug: slug, defaultLanguage: language))
        brands.append(created)
        selectBrand(created.id)
        return created
    }

    // MARK: Brands

    /// Switch the working brand: new chats, posts, calendar and media follow it.
    func selectBrand(_ id: EntityID) {
        guard brands.contains(where: { $0.id == id }) else { return }
        let changed = currentBrandId != id
        currentBrandId = id
        expandedBrands.insert(id)
        newChat.updatePlaceholder()
        guard changed else { return }
        switch route {
        case .posts: Task { await posts.load() }
        case .calendar: Task { await calendar.load() }
        case .media: Task { await media.load() }
        case .newChat, .conversation: break
        }
    }

    func openBrandSettings(_ id: EntityID, tab: BrandSettingsTab = .general, startAnalysis: Bool = false) {
        brandSettingsTarget = BrandSettingsTarget(brandId: id, tab: tab, startAnalysis: startAnalysis)
    }

    /// A brand was renamed or its language changed.
    func brandChanged(_ brand: Brand) {
        if let index = brands.firstIndex(where: { $0.id == brand.id }) { brands[index] = brand }
        if let index = archivedBrands.firstIndex(where: { $0.id == brand.id }) { archivedBrands[index] = brand }
        newChat.updatePlaceholder()
    }

    /// Archive (brands are never deleted). The sidebar drops it; another brand becomes current.
    @discardableResult
    func archiveBrand(_ id: EntityID) async throws -> Brand {
        let updated = try await dataService.updateBrand(id, BrandUpdate(status: .archived))
        brands.removeAll { $0.id == id }
        archivedBrands.removeAll { $0.id == id }
        archivedBrands.insert(updated, at: 0)
        expandedBrands.remove(id)
        if currentBrandId == id {
            currentBrandId = nil
            if let next = sidebarBrands.first?.id { selectBrand(next) } else { newChat.updatePlaceholder() }
        }
        return updated
    }

    @discardableResult
    func restoreBrand(_ id: EntityID) async throws -> Brand {
        let updated = try await dataService.updateBrand(id, BrandUpdate(status: .active))
        archivedBrands.removeAll { $0.id == id }
        if !brands.contains(where: { $0.id == id }) { brands.append(updated) }
        if currentBrandId == nil { selectBrand(id) }
        return updated
    }

    private func startJobFeed() {
        feedTask?.cancel()
        let stream = dataService.jobFeed()
        feedTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.jobBoard.apply(event)
                if case .message(.jobUpdated(let job)) = event {
                    self.publishing.jobChanged(job)
                    if job.type == .contentGenerate || job.type == .contentRender {
                        self.posts.jobChanged(job)
                        if self.detail?.content.id == job.contentId, job.status.isTerminal {
                            Task { await self.detail?.reloadVersionsAndContent() }
                        }
                    } else if job.type == .imageGenerate {
                        self.media.jobChanged(job)
                        // An AI picture generated for a post's slot lands as a new version of that post.
                        if job.status.isTerminal, let target = job.payload["targetContentId"]?.stringValue {
                            Task { await self.posts.load() }
                            if self.detail?.content.id == target {
                                Task { await self.detail?.reloadVersionsAndContent() }
                            }
                        }
                    } else if job.type == .schedulePublish, job.status.isTerminal {
                        Task { await self.calendar.load() }
                    }
                }
            }
        }
    }

    func stopFeeds() {
        feedTask?.cancel()
        conversationModels.values.forEach { $0.stop() }
    }

    static func describe(_ error: any Error) -> String {
        (error as? StudioAPIError)?.errorDescription ?? error.localizedDescription
    }

    /// A request that ended because its task was cancelled (a newer one replaced it): not an
    /// error to show ("İptal edildi.").
    static func isCancellation(_ error: any Error) -> Bool {
        if Task.isCancelled { return true }
        if case .cancelled = StudioAPIError.from(error) { return true }
        return false
    }

    // MARK: Derived

    var presence: WorkerPresence? { jobBoard.presence }
    var isOnline: Bool { presence?.online == true }

    /// The owner's name: Settings → Görünüm → "Adın", else the name of the Claude account
    /// signed in on this Mac (read from Claude Code's local profile by the worker).
    var ownerName: String? {
        let typed = settings.ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return presence?.claude?.greetingName
    }

    func brand(_ id: EntityID?) -> Brand? { brands.first { $0.id == id } }
    func accounts(of brandId: EntityID?) -> [SocialAccount] {
        accounts.filter { $0.brandId == brandId }.sorted { $0.platform.order < $1.platform.order }
    }

    func conversations(of brandId: EntityID) -> [Conversation] {
        conversations.filter { $0.brandId == brandId }
    }

    var unbrandedConversations: [Conversation] { conversations.filter { $0.brandId == nil } }

    /// Brands in sidebar order: the current one first, then by recent activity.
    var sidebarBrands: [Brand] {
        let activity = Dictionary(grouping: conversations, by: { $0.brandId ?? "" }).mapValues { $0.map(\.lastActivityAt).max() ?? .distantPast }
        return brands.sorted { a, b in
            (activity[a.id] ?? .distantPast, b.name) > (activity[b.id] ?? .distantPast, a.name)
        }
    }

    var routeBrandId: EntityID? {
        switch route {
        case .conversation(let id): conversations.first { $0.id == id }?.brandId ?? currentBrandId
        default: currentBrandId
        }
    }

    var title: String {
        switch route {
        case .newChat: "Yeni sohbet"
        case .posts: "Postlar"
        case .calendar: "Takvim"
        case .media: "Medya"
        case .conversation(let id): conversations.first { $0.id == id }?.displayTitle ?? "Sohbet"
        }
    }

    // MARK: Navigation

    var sidebarSelection: SidebarItem? {
        get {
            switch route {
            case .posts: .posts
            case .calendar: .calendar
            case .media: .media
            case .conversation(let id): .conversation(id)
            case .newChat: nil
            }
        }
        set {
            // Arrow keys in the sidebar keep the focus there; a click moves it to the composer.
            navigatedByKeyboard = NSApp.currentEvent?.type == .keyDown
            switch newValue {
            case .posts: navigate(to: .posts)
            case .calendar: navigate(to: .calendar)
            case .media: navigate(to: .media)
            case .conversation(let id): navigate(to: .conversation(id))
            case nil: break
            }
        }
    }

    func navigate(to next: Route) {
        guard next != route else { return }
        back.append(route)
        forward.removeAll()
        route = next
        didNavigate()
    }

    var canGoBack: Bool { !back.isEmpty }
    var canGoForward: Bool { !forward.isEmpty }

    func goBack() {
        guard let previous = back.popLast() else { return }
        forward.append(route)
        route = previous
        didNavigate()
    }

    func goForward() {
        guard let next = forward.popLast() else { return }
        back.append(route)
        route = next
        didNavigate()
    }

    private func didNavigate() {
        detail = nil
        if case .conversation(let id) = route {
            lastConversationId = id
            if let brand = conversations.first(where: { $0.id == id })?.brandId {
                currentBrandId = brand
                expandedBrands.insert(brand)
            }
        }
    }

    // MARK: Top bar: modes and the right panel's panes

    /// The mode pill's selection (nil on Takvim and Medya).
    var mode: AppMode? { AppMode.of(route) }

    /// Sohbet: back to the last conversation (or a new chat); Postlar: the posts board.
    func switchMode(_ next: AppMode) {
        guard mode != next else { return }
        switch next {
        case .chat:
            if let id = lastConversationId, conversations.contains(where: { $0.id == id }) {
                navigate(to: .conversation(id))
            } else {
                startNewChat()
            }
        case .posts:
            navigate(to: .posts)
        }
    }

    /// A top bar icon: opens its pane, or closes the panel when that pane is already open.
    func togglePanel(_ pane: RightPanelPane) {
        if inspectorPresented && inspectorPane == pane {
            inspectorPresented = false
        } else {
            inspectorPane = pane
            inspectorPresented = true
        }
    }

    /// The pane's "×" in the top bar.
    func closePanel() {
        inspectorPresented = false
    }

    func toggleInspectorExpanded() {
        inspectorExpanded.toggle()
    }

    /// "Bitenleri temizle" in the jobs pane's header (the jobs stay on the server).
    func clearFinishedJobs(now: Date = Date()) {
        jobsClearedAt = now
    }

    /// The jobs the jobs pane lists for the working brand (finished ones for a day, until cleared).
    func panelJobs(now: Date = Date()) -> JobsPaneContent {
        JobsPaneContent.make(jobs: jobBoard.jobs, brandId: routeBrandId, clearedAt: jobsClearedAt, now: now)
    }

    /// `--route posts` or `--route "conversation:Kasım planı"`: open a screen at launch
    /// (used by scripts/capture-live.sh to screenshot the live app).
    func applyLaunchRoute() {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--route"), index + 1 < args.count else { return }
        let value = args[index + 1]
        if value == "posts" {
            navigate(to: .posts)
        } else if value == "calendar" {
            navigate(to: .calendar)
        } else if value == "media" {
            navigate(to: .media)
        } else if value.hasPrefix("conversation:") {
            let title = String(value.dropFirst("conversation:".count))
            if let match = conversations.first(where: { $0.title == title }) { navigate(to: .conversation(match.id)) }
        }
    }

    func startNewChat() {
        navigate(to: .newChat)
        newChat.focusRequest += 1
    }

    func conversationModel(_ id: EntityID) -> ConversationModel {
        if let existing = conversationModels[id] { return existing }
        let model = ConversationModel(id: id, app: self)
        conversationModels[id] = model
        model.start()
        return model
    }

    func toggleSidebar() {
        sidebarPresented.toggle()
    }

    func toggleInspector() {
        inspectorPresented.toggle()
    }

    func saveAgentChoice(_ choice: AgentChoice, for conversationId: EntityID?) {
        settings.agentChoices.save(choice, for: conversationId)
        lastAgentChoice = choice
    }

    func toggleBrand(_ id: EntityID) {
        if expandedBrands.contains(id) { expandedBrands.remove(id) } else { expandedBrands.insert(id) }
    }

    /// Called by a conversation when the server renamed it or touched it.
    /// Rename from the sidebar, the top bar or the chat (no conversation stream is needed).
    @discardableResult
    func renameConversation(_ id: EntityID, to title: String) async -> Bool {
        do {
            conversationChanged(try await conversationService.renameConversation(id, title: title))
            return true
        } catch {
            banner = "Sohbet yeniden adlandırılamadı: \(Self.describe(error))"
            return false
        }
    }

    /// Archive: the conversation leaves the sidebar and its stream stops. Only when it is the
    /// one on screen does the app move to a new chat (archiving from the sidebar keeps the screen).
    @discardableResult
    func archiveConversation(_ id: EntityID) async -> Bool {
        do {
            _ = try await conversationService.archiveConversation(id)
        } catch {
            banner = "Sohbet arşivlenemedi: \(Self.describe(error))"
            return false
        }
        conversations.removeAll { $0.id == id }
        if lastConversationId == id { lastConversationId = nil }
        if route == .conversation(id) { startNewChat() }
        conversationModels.removeValue(forKey: id)?.stop()
        return true
    }

    func conversationChanged(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.insert(conversation, at: 0)
        }
        conversations.sort { $0.lastActivityAt > $1.lastActivityAt }
    }

    func show(error: any Error) {
        banner = Self.describe(error)
    }

    /// Persisting is on (after `restoreSession`); exposed for tests.
    var isTrackingSession: Bool { sessionTracking }

    // MARK: Session (window state restoration)

    var sessionSnapshot: SessionSnapshot {
        SessionSnapshot(route: route, brandId: currentBrandId, sidebarPresented: sidebarPresented, inspectorPresented: inspectorPresented, inspectorPane: inspectorPane)
    }

    private func persistSession() {
        guard sessionTracking else { return }
        sessionStore.save(sessionSnapshot)
    }

    /// After the first load: reopen the brand and screen the app showed last time (a missing
    /// conversation or brand falls back gracefully), then keep saving changes.
    func restoreSession() {
        defer { sessionTracking = true }
        // The owner may already have moved while the server was starting: their choice wins.
        guard let saved = sessionStore.load(), route == .newChat, back.isEmpty else { return }
        if let brand = saved.brand(existing: brands.map(\.id)) {
            currentBrandId = brand
            expandedBrands.insert(brand)
            newChat.updatePlaceholder()
        }
        let restored = saved.route(existingConversations: Set(conversations.map(\.id)))
        guard restored != route else { return }
        // Not a navigation: the history starts empty.
        route = restored
        if case .conversation(let id) = restored {
            lastConversationId = id
            if let brand = conversations.first(where: { $0.id == id })?.brandId {
                currentBrandId = brand
                expandedBrands.insert(brand)
            }
        }
    }

    // MARK: Connection & server status

    /// The most important problem with the Mac server right now (nil: all good or unknown).
    var connectionIssue: ConnectionIssue? {
        ConnectionIssue.evaluate(isSample: isSample, hostStatus: host?.status, loadError: loadAPIError, presence: presence)
    }

    /// The issue the banner shows (the owner can close it until it changes).
    var visibleConnectionIssue: ConnectionIssue? {
        guard let issue = connectionIssue, issue != dismissedIssue else { return nil }
        return issue
    }

    var serverStatus: ServerStatusSummary {
        ServerStatusSummary.make(isSample: isSample, issue: connectionIssue, presence: presence)
    }

    func perform(_ action: ConnectionIssue.Action) {
        switch action {
        case .retry:
            dismissedIssue = nil
            Task { await load() }
        case .restartHost:
            guard let host else { return }
            Task {
                await host.restart()
                if let url = host.apiURL { settings.hostAPIURL = url }
                reconnect()
            }
        case .openSettings:
            openSettings(connectionIssue?.settingsSection)
        case .signInClaude:
            onboarding.reopen(at: .claude)
        }
    }

    /// Opens the settings sheet on `section` (nil: the last section shown). Works while it is open too.
    func openSettings(_ section: SettingsSection? = nil) {
        settingsRequestedSection = section
        settingsPresented = true
    }

    // MARK: Brand switching (⌘1…⌘9, title menu)

    /// A new chat with attached images is tied to its brand: switching would orphan them.
    func canSwitchBrand(to id: EntityID) -> Bool {
        guard id != currentBrandId else { return true }
        if route == .newChat, !newChat.composer.drafts.isEmpty { return false }
        return true
    }

    /// `index` is 0-based in sidebar order (the order the Marka menu lists).
    @discardableResult
    func switchToBrand(at index: Int) -> Bool {
        let list = brandMenuOrder
        guard list.indices.contains(index) else { return false }
        return switchToBrand(list[index].id)
    }

    /// Select the brand; a conversation of another brand gives way to a new chat in this one.
    @discardableResult
    func switchToBrand(_ id: EntityID) -> Bool {
        guard brands.contains(where: { $0.id == id }), canSwitchBrand(to: id) else { return false }
        selectBrand(id)
        if case .conversation(let conversationId) = route,
           conversations.first(where: { $0.id == conversationId })?.brandId != id {
            startNewChat()
        }
        return true
    }

    /// Stable order for ⌘1…⌘9: alphabetical, so shortcuts do not move with activity.
    var brandMenuOrder: [Brand] {
        brands.sorted {
            $0.name.compare($1.name, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: TurkishFormat.locale) == .orderedAscending
        }
    }

    // MARK: Search & refresh

    /// Open a post from anywhere (search, notifications): switch to its brand and the posts screen.
    func openPost(contentId: EntityID, brandId: EntityID) async {
        if brandId != currentBrandId { selectBrand(brandId) }
        navigate(to: .posts)
        if posts.loadedBrandId != brandId || posts.card(contentId) == nil {
            // The brand switch (or the posts screen) may start a newer load: wait for that one.
            await posts.loadLatest()
        }
        guard let card = posts.card(contentId) else {
            banner = "Post bulunamadı; silinmiş ya da başka bir markaya taşınmış olabilir."
            return
        }
        detail = PostDetailModel(app: self, card: card, sourceFrame: .zero)
    }

    /// A clicked notification (the window is already in front): open the post it is about.
    /// One that arrives before the brands loaded (Studio launched by the click) waits for them.
    func openNotice(_ destination: NoticeDestination) {
        switch destination {
        case .post(let contentId, let brandId):
            guard !brands.isEmpty else {
                pendingNotice = destination
                return
            }
            let brand = brandId.flatMap { id in brands.contains { $0.id == id } ? id : nil } ?? currentBrandId
            guard let brand else { return }
            Task { await openPost(contentId: contentId, brandId: brand) }
        case .accounts:
            openSettings(.accounts)
        case .link, .app:
            break
        }
    }

    /// Opens a notification that was clicked while the app was still loading.
    func openPendingNotice() {
        guard let pending = pendingNotice, !brands.isEmpty else { return }
        pendingNotice = nil
        openNotice(pending)
    }

    /// ⌘R: reload what the current screen shows (and the sidebar).
    func reloadCurrentScreen() async {
        search.invalidate()
        switch route {
        case .posts: await posts.load()
        case .calendar: await calendar.load()
        case .media: await media.load()
        case .newChat, .conversation: break
        }
        await load()
    }
}

extension Platform {
    var order: Int {
        switch self {
        case .instagram: 0
        case .facebook: 1
        case .linkedin: 2
        case .unknown: 3
        }
    }
}
