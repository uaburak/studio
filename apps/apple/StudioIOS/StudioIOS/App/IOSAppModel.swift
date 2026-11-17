import Foundation
import Network
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

    /// Gelişmiş → "Ek uzak adres": also try `remoteURLString` when looking for the Mac (after
    /// the addresses the Mac itself sent, which include its tunnel when it has one).
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

    /// The extra address to try (Gelişmiş), when switched on and valid.
    var manualRemoteURL: URL? { useRemoteControlURL ? remoteURL : nil }

    /// Where requests start out: the address that answered last time. The connection manager
    /// moves the client when the Mac answers somewhere else.
    var activeBaseURL: URL? {
        savedCredential?.serverURL ?? manualRemoteURL
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

    /// Name typed in Settings, else a guess from the paired Mac's name (the model prefers the
    /// Claude account's name over the guess: `IOSAppModel.greetingName`).
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
    /// "iPhone'u bağla" / "Yeniden bağla": the QR scanner (with `IOSAppModel.pendingInvite`
    /// when a `studio://pair` link was opened).
    case pair
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

    // Connection to the Mac (see `connectToMac`).
    /// The one client every remote service uses; its address follows the Mac.
    private(set) var client: APIClient
    /// What the connection manager is doing; `connection` turns it into the four plain states.
    private(set) var linkPhase: MacLinkPhase = .idle
    /// A `studio://pair` link waiting for the scanner sheet to pair with it.
    var pendingInvite: PairingInvite?
    /// Tries addresses (tests inject a fake probe).
    @ObservationIgnored var connector = MacConnector()
    /// Looks for the Mac with Bonjour (tests inject a fake).
    @ObservationIgnored var locateOnNetwork: @Sendable (_ macId: String?, _ names: [String]) async -> [URL] = { macId, names in
        await StudioBrowser.locate(macId: macId, names: names)
    }
    /// Reads the Mac's current routes after a connect (tests inject a fake).
    @ObservationIgnored var fetchRoutes: @Sendable (APIClient) async -> MacRoutes? = { client in try? await client.macRoutes() }
    /// Waits between searches after a failure: 2 s, 4 s, 8 s … at most a minute.
    @ObservationIgnored var retryBackoff = Backoff(initial: .seconds(2), maximum: .seconds(60))
    /// Off in tests: no retries scheduled, no network monitor.
    @ObservationIgnored var autoRetry = true
    @ObservationIgnored private var linkTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var linkFailures = 0
    @ObservationIgnored private var lastSearchAt: Date?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    init(
        settings: IOSAppSettings,
        conversationService: (any ConversationService)? = nil,
        dataService: (any StudioDataService)? = nil,
        notifier: IOSNotifier? = nil,
        treatAsRemote: Bool = false
    ) {
        self.settings = settings
        self.notifier = notifier ?? IOSNotifier(delivering: settings.useSampleData ? .silent : .system)
        let client = settings.makeClient()
        self.client = client
        if let conversationService, let dataService {
            self.conversationService = conversationService
            self.dataService = dataService
            // Tests may drive the connection manager over in-memory services.
            self.isSample = !treatAsRemote && conversationService is SampleBackend
        } else if settings.useSampleData {
            let sample = SampleBackend()
            self.conversationService = sample
            self.dataService = sample
            self.isSample = true
        } else {
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

    /// The connection in plain words: "Mac'e bağlı", "Mac'e bağlanıyor…", "Mac'e ulaşılamıyor"
    /// (with one reason and one action) or "Bağlı değil".
    var connection: MacLinkState {
        if isSample { return .connected }
        return MacLinkState.make(isPaired: settings.savedCredential != nil, phase: linkPhase)
    }

    /// Connected, but the Mac's worker is not taking jobs (messages wait until it is back).
    var isMacIdle: Bool { connection == .connected && presence?.online == false }

    /// The greeting name: typed in Settings, else the name of the Claude account on the Mac,
    /// else a guess from the Mac's name.
    var greetingName: String? {
        let typed = settings.ownerName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return presence?.claude?.greetingName ?? settings.greetingName
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

    /// Start over after pairing changed (new Mac, forgotten pairing): drop what the old
    /// connection loaded and connect again.
    func reconnect() {
        guard !isSample else { return }
        let client = settings.makeClient()
        self.client = client
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
        linkTask?.cancel()
        linkTask = nil
        retryTask?.cancel()
        retryTask = nil
        linkFailures = 0
        linkPhase = .idle
        Task { await load() }
    }

    /// Load everything; finds the Mac first when not connected yet.
    func load() async {
        if isSample {
            await loadData()
            return
        }
        guard settings.savedCredential != nil else {
            linkPhase = .idle
            hasLoaded = true
            return
        }
        if case .connected = linkPhase {
            await loadData()
        } else {
            await connectToMac()
        }
    }

    /// Find the paired Mac and connect: the Bonjour service, the last answering address, the
    /// LAN addresses, then the tunnel (`MacConnector`). On success the shared client moves to
    /// that address and data loads; on failure it tries again with backoff. One search at a time.
    func connectToMac() async {
        guard !isSample, let credential = settings.savedCredential else { return }
        if let running = linkTask {
            await running.value
            return
        }
        retryTask?.cancel()
        retryTask = nil
        if !connection.isConnected { linkPhase = .searching }
        let task = Task { await self.search(credential) }
        linkTask = task
        await task.value
        // `reconnect()` may have replaced it meanwhile.
        if linkTask == task { linkTask = nil }
    }

    private func search(_ credential: DeviceCredential) async {
        lastSearchAt = Date()
        let candidates = MacRoutePlanner.candidates(
            lastKnown: credential.serverURL, routes: credential.routes, manual: settings.manualRemoteURL)
        let locate = locateOnNetwork
        let macId = credential.macId
        let names = [credential.bonjourName, credential.serverName]
        let found = await connector.firstReachable(candidates, macId: macId) {
            await locate(macId, names).map { MacRoute(.bonjour, $0) }
        }
        if Task.isCancelled { return }
        guard let found else {
            linkLost(.notFound)
            return
        }
        if client.baseURL != found.url {
            client.updateBaseURL(found.url)
            try? settings.pairingClient.updateServerURL(found.url)
            settings.credentialChanged()
            // Live streams reconnect to the new address now instead of after their backoff.
            if hasLoaded { conversationModels.values.forEach { $0.stop(); $0.start() } }
        }
        linkPhase = .connected(found)
        linkFailures = 0
        await loadData()
        if case .connected = linkPhase, let routes = await fetchRoutes(client) {
            try? settings.pairingClient.updateRoutes(routes)
            settings.credentialChanged()
        }
    }

    /// A request showed the Mac is gone (`notFound`) or no longer knows this phone
    /// (`notRecognized`). The first searches again with backoff; the second waits for "Yeniden bağla".
    func linkLost(_ failure: MacLinkFailure) {
        guard !isSample else { return }
        // It was working a moment ago: the Mac probably moved. Look again right away, quietly.
        if failure == .notFound, connection.isConnected, linkTask == nil, autoRetry {
            linkPhase = .searching
            Task { await connectToMac() }
            return
        }
        linkPhase = .failed(failure)
        guard failure != .notRecognized, autoRetry, isInForeground else { return }
        linkFailures += 1
        let delay = retryBackoff.delay(afterFailures: linkFailures, random: Double.random(in: 0...1))
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            await self.connectToMac()
        }
    }

    /// "Tekrar dene": search now (resets the backoff).
    func retryConnection() {
        linkFailures = 0
        Task { await connectToMac() }
    }

    /// The job feed keeps failing: the Mac may have moved (new Wi-Fi address, left home).
    private func feedTrouble(_ state: LiveState) {
        guard !isSample, linkTask == nil, isInForeground else { return }
        switch state {
        case .waiting(let failures, _) where failures >= 2: break
        case .polling: break
        default: return
        }
        if let last = lastSearchAt, Date().timeIntervalSince(last) < 10 { return }
        Task { await connectToMac() }
    }

    /// Follow network changes (Wi-Fi on/off, another network): look for the Mac again.
    func startNetworkMonitor() {
        guard autoRetry, pathMonitor == nil, !isSample else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor [weak self] in self?.networkChanged(satisfied: satisfied) }
        }
        monitor.start(queue: .global(qos: .utility))
        pathMonitor = monitor
    }

    private func networkChanged(satisfied: Bool) {
        guard satisfied, isInForeground, settings.savedCredential != nil, hasLoaded else { return }
        linkFailures = 0
        Task {
            // Addresses settle a moment after the change.
            try? await Task.sleep(for: .seconds(1))
            await connectToMac()
        }
    }

    /// Map a failed request: connection problems go to the connection manager.
    private func handleLoadFailure(_ error: any Error) {
        guard !isSample, let failure = MacLinkState.failure(for: StudioAPIError.from(error)) else { return }
        linkLost(failure)
    }

    /// Brands, accounts and conversations, then the live job feed and the posts.
    private func loadData() async {
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
            handleLoadFailure(error)
            if case .failed = linkPhase { return }
        }
        startJobFeed()
        await posts.load()
    }

    // MARK: Pairing

    /// Pair with the Mac whose QR code was scanned (or whose link was opened), then connect.
    func pair(with invite: PairingInvite) async throws(StudioAPIError) {
        _ = try await settings.pairingClient.pair(invite: invite, deviceName: UIDevice.current.name, connector: connector)
        settings.credentialChanged()
        reconnect()
    }

    /// A `studio://pair` link: keep it for the scanner sheet, which pairs with it.
    @discardableResult
    func openLink(_ url: URL) -> Bool {
        guard PairingInvite.isPairingLink(url) else { return false }
        pendingInvite = try? PairingInvite.parse(url)
        open(.pair)
        return true
    }

    /// Forget the Mac on this phone (the Mac lists it until removed there).
    func forgetMac() {
        settings.forgetPairing()
        reconnect()
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
        case .state(let state):
            feedTrouble(state)
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
        startNetworkMonitor()
        if wasBackground, hasLoaded {
            linkFailures = 0
            Task { await refreshAfterForeground() }
        }
    }

    func sceneDidEnterBackground() {
        isInForeground = false
        retryTask?.cancel()
        retryTask = nil
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
