import Observation
import SwiftUI

enum AppTab: Hashable {
    case home, compose, jobs, review, calendar
}

/// App-wide state: server configuration, brands and the selected brand, the
/// live job store. Screens keep their own view models and read the client
/// from here.
@MainActor
@Observable
final class AppModel {
    let environment: AppEnvironment
    private(set) var api: APIClient
    private(set) var hasCredentials = false
    var brands = Loadable<[Brand]>()
    private(set) var selectedBrandId: String?
    var selectedTab: AppTab = .home
    /// Set when a screen created or changed content, so lists reload.
    private(set) var contentRevision = 0
    let jobs: JobsStore
    let images = ImageCache()
    /// Opened from Compose after a submit so Review can show the new content.
    var pendingContentId: String?

    init(environment: AppEnvironment) {
        self.environment = environment
        let credentials = try? environment.credentials.load()
        let api = APIClient(
            configuration: ServerConfiguration(baseURL: environment.preferences.baseURL),
            authorizer: AccessServiceTokenAuthorizer(credentials: credentials),
            session: environment.makeSession())
        self.api = api
        self.hasCredentials = credentials?.isComplete ?? false
        self.selectedBrandId = environment.preferences.selectedBrandId
        self.jobs = JobsStore(api: api, connector: environment.webSocketConnector)
    }

    var configuration: ServerConfiguration { api.configuration }

    var activeBrands: [Brand] { brands.value ?? [] }

    var selectedBrand: Brand? {
        activeBrands.first { $0.id == selectedBrandId }
    }

    // MARK: Lifecycle

    /// First launch and every return to the foreground.
    func activate() async {
        if brands.value == nil || brands.error != nil {
            await loadBrands()
        }
        jobs.start(brandId: selectedBrandId)
    }

    func deactivate() {
        jobs.stop()
    }

    func loadBrands() async {
        brands.begin()
        do {
            let page = try await api.brands()
            brands.succeed(page.items)
            if selectedBrand == nil {
                select(brandId: page.items.first?.id)
            }
        } catch {
            brands.fail(error)
        }
    }

    func select(brandId: String?) {
        guard brandId != selectedBrandId else { return }
        selectedBrandId = brandId
        environment.preferences.selectedBrandId = brandId
        if jobs.isRunning || brandId != nil {
            jobs.start(brandId: brandId)
        }
    }

    func contentDidChange() {
        contentRevision += 1
    }

    // MARK: Settings

    var storedCredentials: AccessCredentials? {
        try? environment.credentials.load()
    }

    /// Save server settings and rebuild the client. `credentials == nil` removes them.
    func updateServer(baseURL: URL, credentials: AccessCredentials?) throws(KeychainError) {
        if let credentials, credentials.isComplete {
            try environment.credentials.save(credentials)
        } else {
            try environment.credentials.delete()
        }
        environment.preferences.baseURL = baseURL
        let saved = try? environment.credentials.load()
        hasCredentials = saved?.isComplete ?? false
        api = APIClient(
            configuration: ServerConfiguration(baseURL: baseURL),
            authorizer: AccessServiceTokenAuthorizer(credentials: saved),
            session: environment.makeSession())
        jobs.configure(api: api, connector: environment.webSocketConnector)
        Task {
            await images.removeAll()
            brands = Loadable()
            await loadBrands()
            jobs.start(brandId: selectedBrandId)
            contentDidChange()
        }
    }
}
