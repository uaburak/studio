import Foundation
import Observation
import StudioKit
import UIKit

struct IOSAgentChoice: Equatable, Sendable {
    var model: AgentModel
    var effort: AgentEffort

    static let fallback = IOSAgentChoice(model: .geminiFlashLite, effort: .medium)
}

@MainActor
@Observable
final class IOSAppSettings {
    static let appearanceKey = "studio.ios.appearance"
    static let remoteEnabledKey = "studio.ios.useRemoteURL"
    static let remoteURLKey = "studio.ios.remoteURL"
    static let sampleKey = "StudioSampleData"
    static let lastModelKey = "studio.ios.agent.model"
    static let lastEffortKey = "studio.ios.agent.effort"
    nonisolated static let defaultRemoteURLString = "https://social.burakkoc.net"

    private let defaults: UserDefaults
    let tokenStore: any DeviceTokenStore
    let useSampleData: Bool

    var appearance: IOSAppearancePreference {
        didSet { defaults.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// When true, connects through Cloudflare Tunnel (`https://social.burakkoc.net`) using the paired Bearer token.
    var useRemoteControlURL: Bool {
        didSet { defaults.set(useRemoteControlURL, forKey: Self.remoteEnabledKey) }
    }

    var remoteURLString: String {
        didSet { defaults.set(remoteURLString, forKey: Self.remoteURLKey) }
    }

    init(
        defaults: UserDefaults = .standard,
        tokenStore: any DeviceTokenStore = KeychainDeviceTokenStore(),
        useSampleData: Bool? = nil
    ) {
        self.defaults = defaults
        self.tokenStore = tokenStore
        self.appearance = IOSAppearancePreference(rawValue: defaults.string(forKey: Self.appearanceKey) ?? "") ?? .system
        self.useRemoteControlURL = defaults.bool(forKey: Self.remoteEnabledKey)
        self.remoteURLString = defaults.string(forKey: Self.remoteURLKey) ?? Self.defaultRemoteURLString
        let launchSample = ProcessInfo.processInfo.arguments.drop { $0 != "-StudioSampleData" }.dropFirst().first?.uppercased() == "YES"
        self.useSampleData = useSampleData ?? (launchSample || defaults.bool(forKey: Self.sampleKey))
    }

    var pairingClient: PairingClient {
        PairingClient(store: tokenStore)
    }

    var savedCredential: DeviceCredential? {
        pairingClient.credential()
    }

    var remoteURL: URL? {
        let trimmed = remoteURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    func makeClient() -> APIClient {
        let baseURL: URL
        if useRemoteControlURL, let remoteURL {
            baseURL = remoteURL
        } else if let paired = savedCredential {
            baseURL = paired.serverURL
        } else {
            baseURL = APIClient.localDefaultURL
        }
        return APIClient(baseURL: baseURL, auth: DeviceTokenAuth(store: tokenStore))
    }

    func loadAgentChoice() -> IOSAgentChoice {
        let m = AgentModel(rawValue: defaults.string(forKey: Self.lastModelKey) ?? "")
        let e = AgentEffort(rawValue: defaults.string(forKey: Self.lastEffortKey) ?? "")
        return IOSAgentChoice(
            model: (m != nil && m != .unknown) ? m! : IOSAgentChoice.fallback.model,
            effort: (e != nil && e != .unknown) ? e! : IOSAgentChoice.fallback.effort
        )
    }

    func saveAgentChoice(_ choice: IOSAgentChoice) {
        defaults.set(choice.model.rawValue, forKey: Self.lastModelKey)
        defaults.set(choice.effort.rawValue, forKey: Self.lastEffortKey)
    }
}

/// Root observable state of `StudioIOS`.
@MainActor
@Observable
final class IOSAppModel {
    enum Tab: Int, CaseIterable {
        case chat = 0
        case posts = 1
        case calendar = 2
        case settings = 3
    }

    let settings: IOSAppSettings
    private(set) var conversationService: any ConversationService
    private(set) var dataService: any StudioDataService
    private(set) var isSample: Bool

    var selectedTab: Tab = .chat
    var brands: [Brand] = []
    var accounts: [SocialAccount] = []
    var conversations: [Conversation] = []
    var currentBrandId: EntityID?
    var jobBoard = JobBoard()
    var loadError: String?
    var isLoading = false

    var agentChoice: IOSAgentChoice {
        didSet { settings.saveAgentChoice(agentChoice) }
    }

    let images = IOSImageStore()
    let posts = IOSPostsModel()
    let calendar = IOSCalendarModel()
    private(set) var conversationModels: [EntityID: IOSConversationModel] = [:]
    private var feedTask: Task<Void, Never>?

    init(
        settings: IOSAppSettings,
        conversationService: (any ConversationService)? = nil,
        dataService: (any StudioDataService)? = nil
    ) {
        self.settings = settings
        self.agentChoice = settings.loadAgentChoice()
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
        images.app = self
        posts.app = self
        calendar.app = self
    }

    var presence: WorkerPresence? { jobBoard.presence }
    var isOnline: Bool { presence?.online == true }

    var currentBrand: Brand? {
        brands.first { $0.id == currentBrandId }
    }

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

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let loadedBrands = dataService.brands()
            async let loadedAccounts = dataService.socialAccounts(brandId: nil)
            async let loadedConvs = conversationService.conversations()
            brands = try await loadedBrands
            accounts = try await loadedAccounts
            conversations = try await loadedConvs
            if currentBrandId == nil || !brands.contains(where: { $0.id == currentBrandId }) {
                currentBrandId = conversations.first?.brandId ?? brands.first?.id
            }
            loadError = nil
        } catch {
            loadError = Self.describe(error)
            // The Mac may have a new address on this network (DHCP): find it again with Bonjour.
            if await rediscoverPairedMac() { return }
        }
        startJobFeed()
    }

    private var isRediscovering = false

    /// When the saved Mac address does not answer, browse `_studio._tcp` for a few
    /// seconds, resolve the Mac with the same name and switch to its new address.
    /// Returns true when it reconnected (a fresh `load()` is then running).
    private func rediscoverPairedMac() async -> Bool {
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
        reconnect()
        return true
    }

    private func startJobFeed() {
        feedTask?.cancel()
        let stream = dataService.jobFeed()
        feedTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.jobBoard.apply(event)
                if case .message(.jobUpdated(let job)) = event, job.status.isTerminal {
                    if job.type == .contentGenerate || job.type == .contentRender {
                        Task { await self.posts.load() }
                    } else if job.type == .schedulePublish {
                        Task { await self.calendar.load() }
                    }
                }
            }
        }
    }

    func conversationModel(_ id: EntityID) -> IOSConversationModel {
        if let existing = conversationModels[id] { return existing }
        let created = IOSConversationModel(id: id, app: self)
        conversationModels[id] = created
        created.start()
        return created
    }

    func conversationUpdated(_ conv: Conversation) {
        if let idx = conversations.firstIndex(where: { $0.id == conv.id }) {
            conversations[idx] = conv
        } else {
            conversations.insert(conv, at: 0)
        }
        conversations.sort { $0.lastActivityAt > $1.lastActivityAt }
    }

    func createAndOpenConversation(title: String? = nil) async throws -> Conversation {
        let conv = try await conversationService.createConversation(brandId: currentBrandId, title: title)
        conversationUpdated(conv)
        return conv
    }

    static func describe(_ error: any Error) -> String {
        (error as? StudioAPIError)?.errorDescription ?? error.localizedDescription
    }
}
