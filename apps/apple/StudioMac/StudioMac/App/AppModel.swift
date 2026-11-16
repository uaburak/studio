import AppKit
import StudioKit
import SwiftUI

/// What the detail column shows.
enum Route: Hashable {
    case newChat
    case conversation(EntityID)
    case posts
}

/// Sidebar list selection (native `List(selection:)`).
enum SidebarItem: Hashable {
    case posts
    case conversation(EntityID)
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
    var accounts: [SocialAccount] = []
    var conversations: [Conversation] = []
    var jobBoard = JobBoard()
    var loadError: String?
    var isLoading = false

    // Navigation
    private(set) var route: Route = .newChat
    private var back: [Route] = []
    private var forward: [Route] = []
    var columnVisibility: NavigationSplitViewVisibility = .all
    var inspectorPresented = true
    var expandedBrands: Set<EntityID> = []
    /// Brand for a new chat and the posts screen.
    var currentBrandId: EntityID?
    var searchPresented = false
    /// Settings open as an in-window sheet, not a separate window.
    var settingsPresented = false
    /// The last sidebar navigation came from the keyboard (do not steal focus).
    private(set) var navigatedByKeyboard = false

    // Screens
    private(set) var conversationModels: [EntityID: ConversationModel] = [:]
    let newChat: NewChatModel
    let posts: PostsModel
    let images: ImageStore
    var detail: PostDetailModel?
    var banner: String?

    private var feedTask: Task<Void, Never>?
    let pendingImages = PendingSlotImageStore()

    init(settings: AppSettings, conversationService: (any ConversationService)? = nil, dataService: (any StudioDataService)? = nil) {
        self.settings = settings
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
        newChat = NewChatModel()
        posts = PostsModel()
        images.app = self
        newChat.app = self
        posts.app = self
    }

    /// Rebuild the services after the server address or access key changed.
    func reconnect() {
        guard !isSample else { return }
        let client = settings.makeClient()
        conversationService = RemoteConversationService(client: client)
        dataService = RemoteStudioDataService(client: client)
        conversationModels.values.forEach { $0.stop() }
        conversationModels = [:]
        images.clear()
        Task { await load() }
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
            if currentBrandId == nil || !self.brands.contains(where: { $0.id == currentBrandId }) {
                currentBrandId = self.conversations.first?.brandId ?? self.brands.first?.id
            }
            if expandedBrands.isEmpty, let brand = currentBrandId { expandedBrands = [brand] }
        } catch {
            loadError = Self.describe(error)
        }
        startJobFeed()
    }

    func refreshConversations() async {
        if let list = try? await conversationService.conversations() { conversations = list }
    }

    private func startJobFeed() {
        feedTask?.cancel()
        let stream = dataService.jobFeed()
        feedTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.jobBoard.apply(event)
                if case .message(.jobUpdated(let job)) = event, job.type == .contentGenerate || job.type == .contentRender {
                    self.posts.jobChanged(job)
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

    // MARK: Derived

    var presence: WorkerPresence? { jobBoard.presence }
    var isOnline: Bool { presence?.online == true }

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
        case .conversation(let id): conversations.first { $0.id == id }?.displayTitle ?? "Sohbet"
        }
    }

    // MARK: Navigation

    var sidebarSelection: SidebarItem? {
        get {
            switch route {
            case .posts: .posts
            case .conversation(let id): .conversation(id)
            case .newChat: nil
            }
        }
        set {
            // Arrow keys in the sidebar keep the focus there; a click moves it to the composer.
            navigatedByKeyboard = NSApp.currentEvent?.type == .keyDown
            switch newValue {
            case .posts: navigate(to: .posts)
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
        if case .conversation(let id) = route, let brand = conversations.first(where: { $0.id == id })?.brandId {
            currentBrandId = brand
            expandedBrands.insert(brand)
        }
    }

    /// `--route posts` or `--route "conversation:Kasım planı"`: open a screen at launch
    /// (used by scripts/capture-live.sh to screenshot the live app).
    func applyLaunchRoute() {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--route"), index + 1 < args.count else { return }
        let value = args[index + 1]
        if value == "posts" {
            navigate(to: .posts)
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
        withAnimation { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
    }

    func toggleInspector() {
        withAnimation { inspectorPresented.toggle() }
    }

    func toggleBrand(_ id: EntityID) {
        if expandedBrands.contains(id) { expandedBrands.remove(id) } else { expandedBrands.insert(id) }
    }

    /// Called by a conversation when the server renamed it or touched it.
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
