import AppKit
import Foundation
import Observation
import StudioKit

/// Connecting social accounts with the owner's own Meta / LinkedIn apps (P3).
///
/// - App ID / Client ID live in user defaults (not secret); App Secret / Client Secret in
///   the Keychain (`KeychainSecretStore`), read only when a flow runs.
/// - Meta: Facebook Login in the browser → loopback redirect → the API exchanges the code
///   (long-lived with the App Secret) and lists the Pages → the owner picks Pages and
///   Instagram accounts per brand → Page tokens go into the vault.
/// - LinkedIn: OAuth in the browser → the API exchanges the code, reads the member and
///   vaults the 60-day token.
@MainActor
@Observable
final class AccountsModel {
    enum Phase: Equatable {
        case idle
        case waitingForBrowser(Platform)
        case exchanging
        case picking
        case connecting
        case finished(String)
        case failed(String)
    }

    static let metaAppIdKey = "studio.meta.appId"
    static let metaHasSecretKey = "studio.meta.hasSecret"
    static let linkedInClientIdKey = "studio.linkedin.clientId"
    static let linkedInHasSecretKey = "studio.linkedin.hasSecret"

    weak var app: AppModel?
    var apiOverride: (any PublishingAPI)?
    let secrets: any SecretStore
    private let defaults: UserDefaults
    /// Opens the login page (the browser); tests capture the URL.
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// Waits for the loopback redirect; tests answer it directly.
    var waitForCallback: (String, URL) async throws -> URL = { path, authorizeURL in
        let server = OAuthLoopbackServer()
        return try await server.waitForCallback(path: path) {
            DispatchQueue.main.async { NSWorkspace.shared.open(authorizeURL) }
        }
    }

    private(set) var phase: Phase = .idle
    private(set) var busyAccountIds: Set<EntityID> = []
    /// Facebook Login result while the owner picks Pages (token in memory only).
    private(set) var exchange: MetaExchangeResult?
    private(set) var pickingBrandId: EntityID?
    var selections: [String: MetaPageSelection] = [:]
    private var flowTask: Task<Void, Never>?

    init(app: AppModel? = nil, defaults: UserDefaults = .standard, secrets: any SecretStore = KeychainSecretStore()) {
        self.app = app
        self.defaults = defaults
        self.secrets = secrets
    }

    var api: any PublishingAPI { apiOverride ?? app?.publishing.api ?? DataServicePublishingAPI { SampleBackend() } }

    // MARK: App credentials

    var metaAppId: String { defaults.string(forKey: Self.metaAppIdKey) ?? "" }
    var metaHasSecret: Bool { defaults.bool(forKey: Self.metaHasSecretKey) }
    var linkedInClientId: String { defaults.string(forKey: Self.linkedInClientIdKey) ?? "" }
    var linkedInHasSecret: Bool { defaults.bool(forKey: Self.linkedInHasSecretKey) }

    var metaConfigured: Bool { !metaAppId.isEmpty }
    var linkedInConfigured: Bool { !linkedInClientId.isEmpty && linkedInHasSecret }

    /// Bumps so views re-read the stored ids.
    private(set) var credentialsRevision = 0

    func saveMetaApp(appId: String, secret: String?) throws {
        let id = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.isEmpty || id.allSatisfy(\.isNumber) else { throw StudioAPIError.invalidConfiguration("Uygulama Kimliği yalnızca rakamlardan oluşur.") }
        defaults.set(id.isEmpty ? nil : id, forKey: Self.metaAppIdKey)
        if let secret = secret?.trimmingCharacters(in: .whitespacesAndNewlines), !secret.isEmpty {
            try secrets.save(secret, name: PublishingSecret.metaAppSecret)
            defaults.set(true, forKey: Self.metaHasSecretKey)
        }
        credentialsRevision += 1
    }

    func forgetMetaSecret() throws {
        try secrets.delete(PublishingSecret.metaAppSecret)
        defaults.set(false, forKey: Self.metaHasSecretKey)
        credentialsRevision += 1
    }

    func saveLinkedInApp(clientId: String, secret: String?) throws {
        let id = clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        defaults.set(id.isEmpty ? nil : id, forKey: Self.linkedInClientIdKey)
        if let secret = secret?.trimmingCharacters(in: .whitespacesAndNewlines), !secret.isEmpty {
            try secrets.save(secret, name: PublishingSecret.linkedInClientSecret)
            defaults.set(true, forKey: Self.linkedInHasSecretKey)
        }
        credentialsRevision += 1
    }

    private func metaSecret() -> String? {
        guard metaHasSecret else { return nil }
        return try? secrets.load(PublishingSecret.metaAppSecret)
    }

    // MARK: Flows

    var isBusy: Bool {
        switch phase {
        case .waitingForBrowser, .exchanging, .connecting: true
        default: false
        }
    }

    func cancelFlow() {
        flowTask?.cancel()
        flowTask = nil
        exchange = nil
        selections = [:]
        phase = .idle
    }

    func dismissResult() {
        if case .finished = phase { phase = .idle }
        if case .failed = phase { phase = .idle }
    }

    /// Facebook Login → Pages to pick (phase `.picking`).
    func startMetaConnect(brandId: EntityID) {
        guard metaConfigured else {
            phase = .failed("Önce Meta uygulamasının Kimliğini girin (adımlar aşağıda).")
            return
        }
        flowTask?.cancel()
        flowTask = Task { await runMetaConnect(brandId: brandId) }
    }

    func runMetaConnect(brandId: EntityID) async {
        let appId = metaAppId
        let secret = metaSecret()
        let state = OAuthLoopback.newState()
        let url = MetaLogin.authorizeURL(appId: appId, state: state, hasSecret: secret != nil)
        phase = .waitingForBrowser(.instagram)
        do {
            let callbackURL = try await waitForCallback(MetaLogin.callbackPath, url)
            let callback = try MetaLogin.parseCallback(callbackURL, expectedState: state).get()
            phase = .exchanging
            let result = try await api.exchangeMeta(MetaExchangeInput(
                appId: appId, appSecret: secret, code: callback.code,
                redirectUri: callback.code != nil ? MetaLogin.redirectURI : nil,
                accessToken: callback.accessToken))
            exchange = result
            pickingBrandId = brandId
            let alreadyConnected = Set(app?.accounts.compactMap(\.externalId) ?? [])
            selections = Dictionary(uniqueKeysWithValues: result.pages.filter(\.canPublish).map { page in
                (page.pageId, MetaPageSelection(
                    pageId: page.pageId,
                    facebook: alreadyConnected.contains(page.pageId) || result.pages.count == 1,
                    instagram: page.instagram != nil && (alreadyConnected.contains(page.instagram?.igUserId ?? "") || result.pages.count == 1)))
            })
            if result.pages.isEmpty {
                phase = .failed("Bu Facebook hesabının yönettiği bir Sayfa bulunamadı. Instagram hesabı bir Sayfaya bağlı olmalı ve girişte Sayfalara izin verilmeli.")
                exchange = nil
                return
            }
            phase = .picking
        } catch is CancellationError {
            phase = .idle
        } catch let error as OAuthLoopbackServer.Failure where error == .cancelled {
            phase = .idle
        } catch {
            phase = .failed(AppModel.describe(error))
        }
    }

    var pickedCount: Int {
        selections.values.reduce(0) { $0 + ($1.facebook ? 1 : 0) + ($1.instagram ? 1 : 0) }
    }

    func toggle(pageId: String, facebook: Bool? = nil, instagram: Bool? = nil) {
        var current = selections[pageId] ?? MetaPageSelection(pageId: pageId, facebook: false, instagram: false)
        if let facebook { current.facebook = facebook }
        if let instagram { current.instagram = instagram }
        selections[pageId] = current
    }

    /// Vault the picked Pages / Instagram accounts for the brand.
    func confirmMetaSelection() async {
        guard let exchange, let brandId = pickingBrandId, pickedCount > 0 else { return }
        phase = .connecting
        do {
            let picked = selections.values.filter { $0.facebook || $0.instagram }.sorted { $0.pageId < $1.pageId }
            let result = try await api.discoverMeta(MetaDiscoverInput(
                brandId: brandId, userAccessToken: exchange.userAccessToken, autoConnect: true,
                selections: picked, userTokenExpiresAt: exchange.expiresAt))
            self.exchange = nil
            selections = [:]
            await app?.refreshAccounts()
            let names = result.connectedAccounts.map { "\($0.platform.displayName) · \($0.handle)" }
            let skipped = pickedCount > 0 && result.connectedAccounts.isEmpty
            phase = skipped
                ? .failed("Seçilen hesaplar bağlanamadı: başka bir markaya bağlı ya da Sayfada yayın yetkiniz yok.")
                : .finished("Bağlandı: \(names.joined(separator: ", "))." + (exchange.longLived ? "" : " App Secret girilmediği için anahtar yaklaşık bir saat geçerli; uzun ömürlü bağlantı için App Secret ekleyin."))
        } catch {
            phase = .failed(AppModel.describe(error))
        }
    }

    func startLinkedInConnect(brandId: EntityID) {
        guard linkedInConfigured else {
            phase = .failed("Önce LinkedIn uygulamasının Client ID ve Client Secret değerlerini girin (adımlar aşağıda).")
            return
        }
        flowTask?.cancel()
        flowTask = Task { await runLinkedInConnect(brandId: brandId) }
    }

    func runLinkedInConnect(brandId: EntityID) async {
        let clientId = linkedInClientId
        guard let secret = try? secrets.load(PublishingSecret.linkedInClientSecret) else {
            phase = .failed("LinkedIn Client Secret Anahtar Zinciri'nden okunamadı; yeniden girin.")
            return
        }
        let state = OAuthLoopback.newState()
        phase = .waitingForBrowser(.linkedin)
        do {
            let callbackURL = try await waitForCallback(LinkedInLogin.callbackPath, LinkedInLogin.authorizeURL(clientId: clientId, state: state))
            let code = try LinkedInLogin.parseCallback(callbackURL, expectedState: state).get()
            phase = .connecting
            let account = try await api.linkedInOAuth(LinkedInOAuthInput(
                brandId: brandId, clientId: clientId, clientSecret: secret, code: code, redirectUri: LinkedInLogin.redirectURI))
            await app?.refreshAccounts()
            phase = .finished("LinkedIn bağlandı: \(account.handle). Anahtar \(LinkedInLogin.tokenLifetimeDays) gün geçerli; bitmeden hatırlatılır.")
        } catch is CancellationError {
            phase = .idle
        } catch let error as OAuthLoopbackServer.Failure where error == .cancelled {
            phase = .idle
        } catch {
            phase = .failed(AppModel.describe(error))
        }
    }

    /// Reconnect = the same flow for the account's platform.
    func reconnect(_ account: SocialAccount) {
        if account.platform == .linkedin { startLinkedInConnect(brandId: account.brandId) } else { startMetaConnect(brandId: account.brandId) }
    }

    /// Token health; live when the platform can be asked (Meta needs the App Secret).
    func check(_ account: SocialAccount) async {
        busyAccountIds.insert(account.id)
        defer { busyAccountIds.remove(account.id) }
        let secret = account.platform == .linkedin ? nil : metaSecret()
        let input = account.platform == .linkedin
            ? SocialAccountCheckInput(live: true)
            : SocialAccountCheckInput(live: secret != nil, appId: secret != nil ? metaAppId : nil, appSecret: secret)
        do {
            let checked = try await api.checkAccount(id: account.id, input)
            await app?.refreshAccounts()
            phase = .finished("\(checked.handle): \(TokenHealthText.label(for: checked)).")
        } catch {
            phase = .failed(AppModel.describe(error))
        }
    }

    func disconnect(_ account: SocialAccount) async {
        busyAccountIds.insert(account.id)
        defer { busyAccountIds.remove(account.id) }
        do {
            _ = try await api.disconnectAccount(id: account.id)
            await app?.refreshAccounts()
            phase = .finished("\(account.handle) bağlantısı kesildi; erişim anahtarı silindi.")
        } catch {
            phase = .failed(AppModel.describe(error))
        }
    }
}

/// Account health in words (Settings → Hesaplar, brand sheet).
enum TokenHealthText {
    static func label(for account: SocialAccount, now: Date = Date()) -> String {
        if account.status == .disabled { return "Bağlantı kesildi" }
        if account.hasToken == false { return "Bağlı değil" }
        if account.status == .needsReauth { return "Yeniden bağlanmalı" }
        let health = account.tokenHealth ?? .unchecked
        var text = health == .unchecked ? "Bağlı" : health.label
        if let expires = account.tokenExpiresAt {
            let days = Int(ceil(expires.timeIntervalSince(now) / 86_400))
            text += days > 0 ? " · \(days) gün kaldı" : " · süresi doldu"
        }
        return text
    }

    /// Orange only when the owner must act.
    static func needsOwner(_ account: SocialAccount, now: Date = Date()) -> Bool {
        if account.status == .disabled { return false }
        if account.status == .needsReauth || account.hasToken == false { return true }
        switch account.tokenHealth {
        case .invalid, .missingScopes, .expiringSoon: return true
        default: break
        }
        return account.tokenExpiresAt.map { $0.timeIntervalSince(now) < 7 * 86_400 } ?? false
    }

    static func hint(for account: SocialAccount) -> String? {
        if account.status == .needsReauth || account.tokenHealth == .invalid {
            return "Erişim anahtarı geçersiz ya da süresi doldu; “Yeniden bağla” ile girişi yenileyin."
        }
        if account.tokenHealth == .missingScopes {
            return "Yayın için gereken izinlerden bazıları verilmemiş; yeniden bağlarken tüm izinleri onaylayın."
        }
        if account.tokenHealth == .expiringSoon {
            return account.platform == .linkedin
                ? "LinkedIn anahtarı 60 gün geçerlidir; bitmeden yeniden bağlayın."
                : "Erişim yakında doluyor; yeniden bağlayın."
        }
        return nil
    }
}
