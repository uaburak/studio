import Foundation
import StudioKit

/// What Studio's background (embedded host + API + worker + Claude) looks like right now.
/// One honest place that turns raw state into the status line and the app-wide banner.
enum ConnectionIssue: Equatable {
    /// The embedded host is starting its children (`starting("API")`).
    case hostStarting(String)
    /// The embedded host gave up (missing node, bad repo path, crashing API).
    case hostFailed(String)
    /// The API cannot be reached (offline, refused, timed out).
    case apiUnreachable
    /// The API (or Cloudflare Access) refused the credentials.
    case unauthorized
    /// The API answered with an error or a shape the app does not understand.
    case apiError(String)
    /// The API is up but no worker is connected: jobs wait in the queue.
    case workerOffline
    /// The worker runs but Claude is not signed in: chat and generation cannot run.
    case claudeSignedOut
    case claudeSigningIn
    case claudeNotInstalled

    enum Action: Equatable {
        case retry
        case restartHost
        case openSettings
        case signInClaude
    }

    /// Turkish, honest, one sentence: what is wrong and what it means.
    var message: String {
        switch self {
        case .hostStarting(let what): "Studio hazırlanıyor: \(what)…"
        case .hostFailed(let reason): "Studio başlatılamadı: \(reason)"
        case .apiUnreachable: "Studio'nun arka planına ulaşılamıyor. Yeniden dene; sürerse Studio'yu yeniden başlat."
        case .unauthorized: "Erişim reddedildi. Ayarlar → Gelişmiş → Cloudflare Access anahtarını denetle."
        case .apiError(let detail): "Beklenmeyen hata: \(detail)"
        case .workerOffline: "Arka plan işçisi bağlı değil; yeni işler sırada bekliyor."
        case .claudeSignedOut: "Claude hesabına giriş yapılmadı; sohbet ve içerik üretimi çalışmaz."
        case .claudeSigningIn: "Claude girişi bekleniyor; tarayıcıdaki adımı tamamla."
        case .claudeNotInstalled: "Bu Mac'te Claude Code kurulu değil; sohbet ve içerik üretimi çalışmaz."
        }
    }

    var actions: [Action] {
        switch self {
        case .hostStarting, .claudeSigningIn: []
        case .hostFailed: [.restartHost, .openSettings]
        case .apiUnreachable, .apiError: [.retry]
        case .unauthorized: [.openSettings]
        case .workerOffline: [.openSettings]
        case .claudeSignedOut: [.signInClaude]
        case .claudeNotInstalled: [.openSettings]
        }
    }

    /// Settings section the "Ayarlar…" action opens.
    var settingsSection: SettingsSection {
        switch self {
        case .hostStarting, .hostFailed, .apiUnreachable, .unauthorized, .apiError, .workerOffline: .macServer
        case .claudeSignedOut, .claudeSigningIn, .claudeNotInstalled: .ai
        }
    }

    var isBusy: Bool {
        switch self {
        case .hostStarting, .claudeSigningIn: true
        default: false
        }
    }

    /// Short form for the sidebar status line.
    var shortLabel: String {
        switch self {
        case .hostStarting: "Hazırlanıyor"
        case .hostFailed: "Başlatılamadı"
        case .apiUnreachable: "Bağlantı yok"
        case .unauthorized: "Erişim reddedildi"
        case .apiError: "Hata"
        case .workerOffline: "İşçi bağlı değil"
        case .claudeSignedOut: "Claude girişi yok"
        case .claudeSigningIn: "Claude girişi bekleniyor"
        case .claudeNotInstalled: "Claude kurulu değil"
        }
    }

    /// Needs the owner (accent dot) versus a passing state.
    var needsOwner: Bool {
        switch self {
        case .hostStarting, .claudeSigningIn: false
        default: true
        }
    }

    /// The most important issue first: the host, then the API, then the worker, then Claude.
    /// `presence == nil` means "not reported yet" and is not treated as offline.
    static func evaluate(
        isSample: Bool,
        hostStatus: LocalHost.Status?,
        loadError: StudioAPIError?,
        presence: WorkerPresence?
    ) -> ConnectionIssue? {
        if isSample { return nil }
        switch hostStatus {
        case .starting(let what)?: return .hostStarting(what)
        case .error(let reason)?: return .hostFailed(reason)
        default: break
        }
        if let loadError {
            switch loadError {
            case .offline, .timedOut, .transport: return .apiUnreachable
            case .unauthorized: return .unauthorized
            case .server(let status, _, _, _) where status == 401 || status == 403: return .unauthorized
            case .cancelled: break
            case .invalidConfiguration(let detail): return .apiError(detail)
            default: return .apiError(loadError.errorDescription ?? "beklenmeyen yanıt")
            }
        }
        guard let presence else { return nil }
        if !presence.online { return .workerOffline }
        switch presence.claude?.status {
        case .signedOut?: return .claudeSignedOut
        case .signingIn?: return .claudeSigningIn
        case .notInstalled?: return .claudeNotInstalled
        default: return nil
        }
    }
}

/// The one-line Mac server status shown in the sidebar footer.
struct ServerStatusSummary: Equatable {
    var text: String
    var needsOwner: Bool

    static func make(isSample: Bool, issue: ConnectionIssue?, presence: WorkerPresence?) -> ServerStatusSummary {
        if isSample { return ServerStatusSummary(text: "Örnek veri", needsOwner: false) }
        if let issue { return ServerStatusSummary(text: issue.shortLabel, needsOwner: issue.needsOwner) }
        guard let presence else { return ServerStatusSummary(text: "Bağlanıyor…", needsOwner: false) }
        let queue = presence.queueLength
        let jobs = presence.currentJobs.count
        if jobs > 0 { return ServerStatusSummary(text: "Mac hazır · \(jobs) iş çalışıyor", needsOwner: false) }
        if queue > 0 { return ServerStatusSummary(text: "Mac hazır · \(queue) iş sırada", needsOwner: false) }
        return ServerStatusSummary(text: "Mac hazır", needsOwner: false)
    }
}
