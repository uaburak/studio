import Foundation
import Observation
import StudioKit
import UIKit

/// Settings kept on the phone (UserDefaults + the paired device token in the Keychain).
@MainActor
@Observable
final class IOSAppSettings {
    nonisolated static let appearanceKey = "studio.ios.appearance"
    nonisolated static let remoteEnabledKey = "studio.ios.useRemoteURL"
    nonisolated static let remoteURLKey = "studio.ios.remoteURL"
    nonisolated static let sampleKey = "StudioSampleData"
    nonisolated static let brandKey = "studio.ios.brand"
    nonisolated static let noticePrefix = "studio.ios.notices."
    nonisolated static let lastBackgroundKey = "studio.ios.notices.lastCheck"
    nonisolated static let ownerNameKey = "studio.ios.ownerName"
    nonisolated static let defaultRemoteURLString = "https://social.burakkoc.net"

    @ObservationIgnored let defaults: UserDefaults
    @ObservationIgnored let tokenStore: any DeviceTokenStore
    let useSampleData: Bool
    @ObservationIgnored let agentStore: AgentSelectionStore

    var appearance: IOSAppearancePreference {
        didSet { defaults.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// When true, connects through the Remote Control tunnel with the paired Bearer token.
    var useRemoteControlURL: Bool {
        didSet { defaults.set(useRemoteControlURL, forKey: Self.remoteEnabledKey) }
    }

    var remoteURLString: String {
        didSet { defaults.set(remoteURLString, forKey: Self.remoteURLKey) }
    }

    /// The owner's first name for the home greeting ("" = guess from the paired Mac's name).
    var ownerName: String {
        didSet { defaults.set(ownerName, forKey: Self.ownerNameKey) }
    }

    /// Bumped when the Keychain credential changes (pairing, forgetting), so views refresh.
    private(set) var credentialRevision = 0

    /// Notification switches per category (all on by default).
    private(set) var noticeCategories: [ActivityNotice.Category: Bool] = [:]

    init(
        defaults: UserDefaults = .standard,
        tokenStore: any DeviceTokenStore = KeychainDeviceTokenStore(),
        useSampleData: Bool? = nil
    ) {
        self.defaults = defaults
        self.tokenStore = tokenStore
        self.agentStore = AgentSelectionStore(defaults: defaults, prefix: "studio.ios.agent")
        self.appearance = IOSAppearancePreference(rawValue: defaults.string(forKey: Self.appearanceKey) ?? "") ?? .system
        self.useRemoteControlURL = defaults.bool(forKey: Self.remoteEnabledKey)
        self.remoteURLString = defaults.string(forKey: Self.remoteURLKey) ?? Self.defaultRemoteURLString
        self.ownerName = defaults.string(forKey: Self.ownerNameKey) ?? ""
        let launchSample = ProcessInfo.processInfo.arguments.drop { $0 != "-StudioSampleData" }.dropFirst().first?.uppercased() == "YES"
        self.useSampleData = useSampleData ?? (launchSample || defaults.bool(forKey: Self.sampleKey))
        for category in ActivityNotice.Category.allCases {
            noticeCategories[category] = defaults.object(forKey: Self.noticePrefix + category.rawValue) as? Bool ?? true
        }
    }

    var pairingClient: PairingClient { PairingClient(store: tokenStore) }

    var savedCredential: DeviceCredential? {
        _ = credentialRevision
        return pairingClient.credential()
    }

    /// Paired (or on sample data): the app can talk to a Mac.
    var isConnectedSetup: Bool { useSampleData || savedCredential != nil }

    var remoteURL: URL? {
        let trimmed = remoteURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    /// The address requests go to right now.
    var activeBaseURL: URL? {
        if useRemoteControlURL, let remoteURL { return remoteURL }
        return savedCredential?.serverURL
    }

    func makeClient() -> APIClient {
        APIClient(baseURL: activeBaseURL ?? APIClient.localDefaultURL, auth: DeviceTokenAuth(store: tokenStore))
    }

    func credentialChanged() { credentialRevision += 1 }

    func forgetPairing() {
        try? pairingClient.forget()
        credentialChanged()
    }

    func isNoticeEnabled(_ category: ActivityNotice.Category) -> Bool { noticeCategories[category] ?? true }

    func setNotice(_ category: ActivityNotice.Category, enabled: Bool) {
        noticeCategories[category] = enabled
        defaults.set(enabled, forKey: Self.noticePrefix + category.rawValue)
    }

    /// Name used by the greeting and the avatar: the setting, else the paired Mac's owner.
    var greetingName: String? {
        let typed = ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return savedCredential.flatMap { StudioGreeting.ownerName(fromMacName: $0.serverName) }
    }

    var lastBrandId: EntityID? {
        get { defaults.string(forKey: Self.brandKey) }
        set { defaults.set(newValue, forKey: Self.brandKey) }
    }
}

/// Where a notification, a link or the drawer asks the app to go.
enum IOSRoute: Equatable {
    case conversation(EntityID)
    /// The home screen: an empty new chat.
    case newConversation
    case post(EntityID)
    case posts
    case calendar
    case brands
    case brand(EntityID)
    case jobs
    case settings
}

/// Full pages pushed over the chat from the drawer (each former tab and more).
enum IOSDestination: String, CaseIterable {
    case posts, calendar, brands, jobs, settings

    /// Rows of the drawer's top list (Ayarlar is the avatar at the bottom).
    static let drawerRows: [IOSDestination] = [.posts, .calendar, .brands, .jobs]

    var title: String {
        switch self {
        case .posts: "Postlar"
        case .calendar: "Takvim"
        case .brands: "Markalar"
        case .jobs: "Mac durumu"
        case .settings: "Ayarlar"
        }
    }

    var symbol: String {
        switch self {
        case .posts: "square.grid.2x2"
        case .calendar: "calendar"
        case .brands: "building.2"
        case .jobs: "laptopcomputer"
        case .settings: "gearshape"
        }
    }

    var route: IOSRoute {
        switch self {
        case .posts: .posts
        case .calendar: .calendar
        case .brands: .brands
        case .jobs: .jobs
        case .settings: .settings
        }
    }

    @MainActor
    func makeController(_ app: IOSAppModel) -> UIViewController {
        switch self {
        case .posts: IOSPostsViewController(app: app)
        case .calendar: IOSCalendarViewController(app: app)
        case .brands: BrandsViewController(app: app)
        case .jobs: JobsViewController(app: app)
        case .settings: IOSSettingsViewController(app: app)
        }
    }

    @MainActor
    func isShown(by controller: UIViewController) -> Bool {
        switch self {
        case .posts: controller is IOSPostsViewController
        case .calendar: controller is IOSCalendarViewController
        case .brands: controller is BrandsViewController
        case .jobs: controller is JobsViewController
        case .settings: controller is IOSSettingsViewController
        }
    }
}

/// Connection to the Mac as the UI shows it.
enum IOSConnection: Equatable {
    case notPaired
    case connecting
    case online
    /// The API answers but no worker is connected.
    case macOffline
    case unreachable(String)

    var label: String {
        switch self {
        case .notPaired: "Eşleşmedi"
        case .connecting: "Bağlanıyor"
        case .online: "Mac hazır"
        case .macOffline: "Mac çevrimdışı"
        case .unreachable: "Ulaşılamıyor"
        }
    }
}

/// Root observable state of `StudioIOS`.
@MainActor
@Observable
final class IOSAppModel {
    let settings: IOSAppSettings
    private(set) var conversationService: any ConversationService
    private(set) var dataService: any StudioDataService
    private(set) var isSample: Bool

    var brands: [Brand] = []
    var accounts: [SocialAccount] = []
    var conversations: [Conversation] = []
    var currentBrandId: EntityID? {
        didSet { if currentBrandId != oldValue { settings.lastBrandId = currentBrandId } }
    }
    var jobBoard = JobBoard()
    var loadError: String?
    var isLoading = false
    private(set) var hasLoaded = false
    /// Set by notifications and cross-screen links; the root navigates and clears it.
    var pendingRoute: IOSRoute?
    /// Conversation the user is looking at (no "reply ready" notice for it).
    var visibleConversationId: EntityID?
    private(set) var isInForeground = true

    let images = IOSImageStore()
    let posts = IOSPostsModel()
    let calendar = IOSCalendarModel()
    let notifier: IOSNotifier
    private(set) var conversationModels: [EntityID: IOSConversationModel] = [:]
    @ObservationIgnored private var feedTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTracker = ActivityNoticeTracker()
    @ObservationIgnored private var isRediscovering = false

    init(
        settings: IOSAppSettings,
        conversationService: (any ConversationService)? = nil,
        dataService: (any StudioDataService)? = nil,
        notifier: IOSNotifier? = nil
    ) {
        self.settings = settings
        self.notifier = notifier ?? IOSNotifier(delivering: settings.useSampleData ? .silent : .system)
        if let conversationService, let dataService {
            self.conversationService = conversationService
            self.dataService = dataService
            self.isSample = conversationService is SampleBackend
        } else if settings.useSampleData {
            let sample = SampleBackend()
            self.conversationService = sample
            self.dataService = sample
            self.isSample = true
        } else {
            let client = settings.makeClient()
            self.conversationService = RemoteConversationService(client: client)
            self.dataService = RemoteStudioDataService(client: client)
            self.isSample = false
        }
        currentBrandId = settings.lastBrandId
        images.app = self
        posts.app = self
        calendar.app = self
    }

    var presence: WorkerPresence? { jobBoard.presence }
    var isOnline: Bool { presence?.online == true }

    var connection: IOSConnection {
        if !isSample && !settings.isConnectedSetup && !settings.useRemoteControlURL { return .notPaired }
        if let loadError, brands.isEmpty, hasLoaded { return .unreachable(loadError) }
        guard let presence else { return hasLoaded ? (loadError.map { .unreachable($0) } ?? .connecting) : .connecting }
        return presence.online ? .online : .macOffline
    }

    var currentBrand: Brand? { brands.first { $0.id == currentBrandId } }

    func brand(_ id: EntityID?) -> Brand? { brands.first { $0.id == id } }

    func accounts(of brandId: EntityID?) -> [SocialAccount] {
        accounts.filter { $0.brandId == brandId }
    }

    func selectBrand(_ brandId: EntityID) {
        guard currentBrandId != brandId else { return }
        currentBrandId = brandId
        Task {
            await posts.load()
            await calendar.load()
        }
    }

    // MARK: Connection

    /// Rebuild the services for the current address (pairing, remote switch) and reload.
    func reconnect() {
        guard !isSample else { return }
        let client = settings.makeClient()
        conversationService = RemoteConversationService(client: client)
        dataService = RemoteStudioDataService(client: client)
        conversationModels.values.forEach { $0.stop() }
        conversationModels = [:]
        images.clear()
        jobBoard = JobBoard()
        brands = []
        conversations = []
        hasLoaded = false
        loadError = nil
        posts.reset()
        calendar.reset()
        Task { await load() }
    }

    func load() async {
        guard isSample || settings.isConnectedSetup || settings.useRemoteControlURL else {
            hasLoaded = true
            return
        }
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            async let loadedBrands = dataService.brands()
            async let loadedAccounts = dataService.socialAccounts(brandId: nil)
            async let loadedConvs = conversationService.conversations()
            brands = try await loadedBrands
            accounts = (try? await loadedAccounts) ?? accounts
            conversations = try await loadedConvs
            if currentBrandId == nil || !brands.contains(where: { $0.id == currentBrandId }) {
                currentBrandId = conversations.first?.brandId ?? brands.first?.id
            }
            loadError = nil
            if !isSample { notifier.requestAuthorizationIfNeeded() }
        } catch {
            loadError = Self.describe(error)
            // The Mac may have a new address on this network (DHCP): find it again with Bonjour.
            if await rediscoverPairedMac() { return }
        }
        startJobFeed()
        await posts.load()
    }

    /// When the saved Mac address does not answer, browse `_studio._tcp` for a few
    /// seconds, resolve the Mac with the same name and switch to its new address.
    /// Returns true when it reconnected (a fresh `load()` is then running).
    func rediscoverPairedMac() async -> Bool {
        guard !isSample, !isRediscovering, !settings.useRemoteControlURL,
              let credential = settings.savedCredential else { return false }
        isRediscovering = true
        defer { isRediscovering = false }
        let browser = StudioBrowser()
        let found: DiscoveredStudio? = await withTaskGroup(of: DiscoveredStudio?.self) { group in
            group.addTask {
                for await list in browser.results() {
                    if let match = list.first(where: { $0.displayName == credential.serverName || $0.serviceName == credential.serverName }) {
                        return match
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(6))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let found, let url = try? await StudioBrowser.resolve(found), url != credential.serverURL else { return false }
        try? settings.pairingClient.updateServerURL(url)
        settings.credentialChanged()
        reconnect()
        return true
    }

    private func startJobFeed() {
        feedTask?.cancel()
        let stream = dataService.jobFeed()
        feedTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    private func handle(_ event: JobFeedEvent) {
        jobBoard.apply(event)
        switch event {
        case .message(.snapshot(let jobs, _)):
            if !noticeTracker.hasBaseline { noticeTracker.baseline(jobs) }
        case .message(.jobUpdated(let job)):
            posts.jobChanged(job)
            if job.status.isTerminal {
                if job.type == .schedulePublish || job.type == .contentGenerate { Task { await calendar.load() } }
                if job.type == .brandAnalyze { Task { await self.load() } }
            }
            let title = job.contentId.flatMap { posts.card($0)?.title }
            for notice in noticeTracker.notices(for: job, contentTitle: title) { deliver(notice) }
        default:
            break
        }
    }

    /// A conversation model saw new state: announce pending consents / questions.
    func conversationStateChanged(_ state: ConversationState) {
        let notices = noticeTracker.waitingNotices(in: state)
        for notice in notices { deliver(notice) }
    }

    private func deliver(_ notice: ActivityNotice) {
        guard settings.isNoticeEnabled(notice.kind.category) else { return }
        if isInForeground, let id = notice.conversationId, id == visibleConversationId, notice.kind != .waitingOnYou { return }
        notifier.post(notice)
    }

    // MARK: Lifecycle

    func sceneDidBecomeActive() {
        let wasBackground = !isInForeground
        isInForeground = true
        notifier.clearDelivered()
        if wasBackground, hasLoaded { Task { await refreshAfterForeground() } }
    }

    func sceneDidEnterBackground() {
        isInForeground = false
        settings.defaults.set(Date(), forKey: IOSAppSettings.lastBackgroundKey)
        notifier.scheduleBackgroundRefresh()
    }

    private func refreshAfterForeground() async {
        await load()
        await calendar.load()
    }

    /// Open a screen (notification tap, content link in chat, empty-state buttons).
    /// The root view controller follows the route and clears it.
    func open(_ route: IOSRoute) {
        pendingRoute = route
    }

    // MARK: Conversations

    func conversationModel(_ id: EntityID) -> IOSConversationModel {
        if let existing = conversationModels[id] { return existing }
        let created = IOSConversationModel(id: id, app: self)
        conversationModels[id] = created
        created.start()
        return created
    }

    /// A new chat that becomes a conversation with its first message.
    func newConversationModel() -> IOSConversationModel {
        IOSConversationModel(id: nil, app: self)
    }

    func register(_ model: IOSConversationModel, as id: EntityID) {
        conversationModels[id] = model
    }

    func conversationUpdated(_ conv: Conversation) {
        if conv.status == .archived {
            conversations.removeAll { $0.id == conv.id }
            return
        }
        if let idx = conversations.firstIndex(where: { $0.id == conv.id }) {
            conversations[idx] = conv
        } else {
            conversations.insert(conv, at: 0)
        }
        conversations.sort { $0.lastActivityAt > $1.lastActivityAt }
    }

    func createConversation(title: String? = nil) async throws -> Conversation {
        let conv = try await conversationService.createConversation(brandId: currentBrandId, title: title)
        conversationUpdated(conv)
        return conv
    }

    func renameConversation(_ id: EntityID, to title: String) async throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        conversationUpdated(try await conversationService.renameConversation(id, title: String(trimmed.prefix(120))))
    }

    func archiveConversation(_ id: EntityID) async throws {
        _ = try await conversationService.archiveConversation(id)
        conversations.removeAll { $0.id == id }
        conversationModels[id]?.stop()
        conversationModels[id] = nil
    }

    /// Conversations of the current brand (and the brandless ones), newest first.
    var visibleConversations: [Conversation] {
        conversations.filter { currentBrandId == nil || $0.brandId == currentBrandId || $0.brandId == nil }
    }

    /// A consent or question in an opened conversation waits on the user.
    func isWaitingOnUser(_ conversationId: EntityID) -> Bool {
        conversationModels[conversationId]?.isWaitingOnUser ?? false
    }

    func selection(for conversationId: EntityID?) -> AgentSelection {
        settings.agentStore.selection(for: conversationId)
    }

    func saveSelection(_ selection: AgentSelection, for conversationId: EntityID?) {
        settings.agentStore.save(selection, for: conversationId)
    }

    static func describe(_ error: any Error) -> String {
        PostEditSession.describe(error)
    }
}
