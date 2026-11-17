import Foundation
import StudioKit

/// One label-left / value-right row of the right panel.
struct PanelRow: Equatable {
    enum Tone: Equatable {
        case normal
        /// Off, waiting or unknown: tertiary grey.
        case muted
        /// Something is wrong and needs the owner: accent.
        case attention
        /// A link-like action (Bağla, Giriş yap): accent, clickable.
        case action
    }

    var label: String
    var value: String
    var tone: Tone = .normal
    /// Tooltip with the full detail.
    var help: String?
}

/// One subscription window as a thin meter ("5 saatlik · %42 kullanıldı").
struct UsageMeter: Equatable {
    var title: String
    var usedText: String
    /// 0...1 (a limited window is full).
    var fraction: Double
    /// Near or at the limit: the bar and the text turn orange.
    var warning: Bool
    var resetText: String?
}

/// The embedded Mac server as a value (from `LocalHost`), so the rows are testable.
struct HostSnapshot: Equatable {
    var status: LocalHost.Status
    var apiURL: URL?
    var apiPhase: ServiceSupervisor.Phase?
    var tunnelPhase: ServiceSupervisor.Phase?
    var lanURLs: [String]
    var tunnelNote: String?

    init(status: LocalHost.Status, apiURL: URL? = nil, apiPhase: ServiceSupervisor.Phase? = nil, tunnelPhase: ServiceSupervisor.Phase? = nil, lanURLs: [String] = [], tunnelNote: String? = nil) {
        self.status = status
        self.apiURL = apiURL
        self.apiPhase = apiPhase
        self.tunnelPhase = tunnelPhase
        self.lanURLs = lanURLs
        self.tunnelNote = tunnelNote
    }

    @MainActor
    init(_ host: LocalHost) {
        self.init(
            status: host.status,
            apiURL: host.apiURL,
            apiPhase: host.phases[.api],
            tunnelPhase: host.phases[.tunnel],
            lanURLs: host.lanURLs,
            tunnelNote: host.tunnelNote
        )
    }
}

/// The texts of the right panel (Ortam, Kullanım, Bağlam, Hesaplar), built from what the
/// app already knows: the embedded host, settings, the worker presence the Mac reports
/// (usage windows, Claude and Gemini status), the conversation state and the brand's accounts.
/// Nothing here is invented: missing data reads "Bekleniyor" / "Henüz bildirilmedi".
@MainActor
enum InspectorContent {
    // MARK: Ortam

    static func environment(
        isSample: Bool,
        host: HostSnapshot?,
        hostEnabled: Bool,
        serverURL: URL?,
        lanEnabled: Bool,
        remoteEnabled: Bool,
        remoteHostname: String,
        issue: ConnectionIssue?,
        presence: WorkerPresence?
    ) -> [PanelRow] {
        if isSample {
            return [
                PanelRow(label: "Mac sunucusu", value: "Örnek veri", tone: .muted, help: "Örnek verilerle açıldı; sunucu ayarları bu oturumda kullanılmıyor."),
                worker(presence),
            ]
        }
        let ownHost = hostEnabled ? host : nil
        var rows: [PanelRow] = [server(host: ownHost, serverURL: serverURL)]
        rows.append(api(host: ownHost, issue: issue))
        rows.append(worker(presence))
        if let ownHost {
            rows.append(lan(host: ownHost, enabled: lanEnabled))
            rows.append(remote(host: ownHost, enabled: remoteEnabled, hostname: remoteHostname))
        }
        return rows
    }

    private static func server(host: HostSnapshot?, serverURL: URL?) -> PanelRow {
        let label = "Mac sunucusu"
        guard let host else {
            let address = serverURL?.host ?? "—"
            return PanelRow(label: label, value: "Harici · \(address)", tone: .normal, help: serverURL?.absoluteString)
        }
        switch host.status {
        case .running:
            return PanelRow(label: label, value: "Çalışıyor", help: host.apiURL?.absoluteString)
        case .attached:
            return PanelRow(label: label, value: "Bağlandı", help: "Bu Mac'te zaten çalışan Studio sunucusuna bağlandı.")
        case .starting(let step):
            return PanelRow(label: label, value: "Başlatılıyor", tone: .muted, help: "\(step)…")
        case .error(let message):
            return PanelRow(label: label, value: "Hata", tone: .attention, help: message)
        case .stopped:
            return PanelRow(label: label, value: "Durdu", tone: .attention, help: "Ayarlar → Mac sunucusu'ndan başlat.")
        }
    }

    private static func api(host: HostSnapshot?, issue: ConnectionIssue?) -> PanelRow {
        let label = "API"
        switch issue {
        case .apiUnreachable?:
            return PanelRow(label: label, value: "Ulaşılamıyor", tone: .attention, help: ConnectionIssue.apiUnreachable.message)
        case .unauthorized?:
            return PanelRow(label: label, value: "Erişim reddedildi", tone: .attention, help: ConnectionIssue.unauthorized.message)
        case .apiError(let detail)?:
            return PanelRow(label: label, value: "Hata", tone: .attention, help: detail)
        default:
            break
        }
        if let host {
            if case .starting = host.status { return PanelRow(label: label, value: "Bekliyor", tone: .muted) }
            if let phase = host.apiPhase {
                switch phase {
                case .running: return PanelRow(label: label, value: "Çalışıyor", help: host.apiURL?.absoluteString)
                case .restarting: return PanelRow(label: label, value: "Yeniden başlıyor", tone: .muted)
                case .failed(let message): return PanelRow(label: label, value: "Durdu (hata)", tone: .attention, help: message)
                case .idle: return PanelRow(label: label, value: "Bekliyor", tone: .muted)
                case .stopped: return PanelRow(label: label, value: "Durdu", tone: .muted)
                }
            }
        }
        return PanelRow(label: label, value: "Bağlı", help: host?.apiURL?.absoluteString)
    }

    static func worker(_ presence: WorkerPresence?) -> PanelRow {
        let label = "Worker"
        guard let presence else { return PanelRow(label: label, value: "Bekleniyor", tone: .muted, help: "Mac durumu henüz gelmedi.") }
        guard presence.online else {
            return PanelRow(label: label, value: "Bağlı değil", tone: .attention, help: AssistantStatus.macLine(presence) + " · yeni işler sırada bekler.")
        }
        let busy = presence.currentJobs.count
        if busy > 0 { return PanelRow(label: label, value: "Çalışıyor · \(busy) iş") }
        if presence.queueLength > 0 { return PanelRow(label: label, value: "Hazır · \(presence.queueLength) sırada") }
        return PanelRow(label: label, value: "Hazır")
    }

    private static func lan(host: HostSnapshot, enabled: Bool) -> PanelRow {
        let label = "Yerel ağ"
        guard enabled else { return PanelRow(label: label, value: "Kapalı", tone: .muted, help: "API yalnızca bu Mac'ten (127.0.0.1) erişilebilir.") }
        guard let first = host.lanURLs.first else {
            return PanelRow(label: label, value: "Açık", tone: .muted, help: "Telefonlar aynı ağda Bonjour ile bulur (_studio._tcp).")
        }
        return PanelRow(label: label, value: displayAddress(first), help: host.lanURLs.joined(separator: ", "))
    }

    private static func remote(host: HostSnapshot, enabled: Bool, hostname: String) -> PanelRow {
        let label = "Uzaktan erişim"
        let cleanHost = LocalHost.normalizedHostname(hostname)
        guard enabled else { return PanelRow(label: label, value: "Kapalı", tone: .muted, help: "Açınca ev dışındaki iPhone https://\(cleanHost) ile bağlanır.") }
        if case .starting = host.status { return PanelRow(label: label, value: "Bekliyor", tone: .muted) }
        switch host.tunnelPhase {
        case .running?:
            return PanelRow(label: label, value: "Açık · \(cleanHost)", help: host.tunnelNote ?? "https://\(cleanHost)")
        case .restarting?:
            return PanelRow(label: label, value: "Yeniden bağlanıyor", tone: .muted, help: host.tunnelNote)
        case .failed(let message)?:
            return PanelRow(label: label, value: "Hata", tone: .attention, help: message)
        case .idle?, .stopped?, nil:
            return PanelRow(label: label, value: "Kurulum gerekli", tone: .attention, help: host.tunnelNote ?? "Ayarlar → Mac sunucusu → Uzaktan erişim.")
        }
    }

    /// "http://192.168.1.20:8791" → "192.168.1.20:8791".
    static func displayAddress(_ url: String) -> String {
        var text = url
        for scheme in ["http://", "https://"] where text.hasPrefix(scheme) { text = String(text.dropFirst(scheme.count)) }
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    // MARK: Kullanım

    static func usageMeters(_ usage: WorkerUsage?, now: Date = Date()) -> [UsageMeter] {
        (usage?.windows ?? []).map { window in
            let percent = window.effectivePercent
            return UsageMeter(
                title: AssistantStatus.windowTitle(window.kind),
                usedText: AssistantStatus.usedText(window),
                fraction: percent / 100,
                warning: window.limited || AssistantStatus.isWarning(percent),
                resetText: window.resetsAt.map { "Sıfırlanma: \(AssistantStatus.relative($0, now: now))" }
            )
        }
    }

    /// Why there are no meters (nil when the Mac reported windows).
    static func usageNote(_ presence: WorkerPresence?) -> String? {
        if let windows = presence?.usage?.windows, !windows.isEmpty { return nil }
        guard let presence else { return "Mac'e bağlanılıyor…" }
        return presence.online ? "Henüz bildirilmedi; Claude Code bir işi bitirince gelir." : "Mac worker bağlı değil."
    }

    static func usageUpdated(_ usage: WorkerUsage?, now: Date = Date()) -> String? {
        guard let usage, !usage.windows.isEmpty else { return nil }
        return "Güncellendi: \(AssistantStatus.relative(usage.observedAt, now: now))"
    }

    /// Claude (subscription account) and Gemini (API / CLI) availability.
    static func providers(_ presence: WorkerPresence?) -> [PanelRow] {
        [claude(presence), gemini(presence)]
    }

    static func claude(_ presence: WorkerPresence?) -> PanelRow {
        let label = "Claude"
        let full = AssistantStatus.claudeLine(presence)
        guard let claude = presence?.claude else {
            return PanelRow(label: label, value: presence?.online == true ? "Bekleniyor" : "Mac çevrimdışı", tone: .muted, help: full)
        }
        switch claude.status {
        case .signedIn:
            let plan = claude.plan?.trimmingCharacters(in: .whitespaces)
            return PanelRow(label: label, value: (plan?.isEmpty == false ? plan : nil) ?? "Giriş yapıldı", help: full)
        case .signedOut: return PanelRow(label: label, value: "Giriş yap", tone: .action, help: full)
        case .signingIn: return PanelRow(label: label, value: "Giriş bekleniyor", tone: .muted, help: full)
        case .notInstalled: return PanelRow(label: label, value: "Kurulu değil", tone: .attention, help: full)
        case .error, .unknown: return PanelRow(label: label, value: "Hata", tone: .attention, help: full)
        }
    }

    static func gemini(_ presence: WorkerPresence?) -> PanelRow {
        let label = "Gemini"
        let full = AssistantStatus.geminiLine(presence)
        guard let gemini = presence?.gemini else {
            return PanelRow(label: label, value: presence?.online == true ? "Bekleniyor" : "Mac çevrimdışı", tone: .muted, help: full)
        }
        switch gemini.status {
        case .ready:
            let mode = switch gemini.mode {
            case .api: "Hazır · API"
            case .cli: "Hazır · CLI"
            case .both: "Hazır · API + CLI"
            case .none, .unknown: "Hazır"
            }
            return PanelRow(label: label, value: mode, help: gemini.defaultModel.map { "\(full) · \($0)" } ?? full)
        case .notConfigured: return PanelRow(label: label, value: "Yapılandırılmadı", tone: .attention, help: full)
        case .error, .unknown: return PanelRow(label: label, value: "Hata", tone: .attention, help: full)
        }
    }

    // MARK: Bağlam

    /// What the current conversation holds (nil state: still loading → no rows).
    static func context(state: ConversationState?, choice: AgentChoice) -> [PanelRow] {
        guard let state else { return [] }
        var rows: [PanelRow] = []
        let messageCount = "\(state.messages.count)\(state.hasMoreMessages ? "+" : "")"
        rows.append(PanelRow(label: "Mesajlar", value: messageCount))
        rows.append(state.aliases.isEmpty
            ? PanelRow(label: "Görseller", value: "Yok", tone: .muted)
            : PanelRow(label: "Görseller", value: "\(state.aliases.count)", help: aliasLine(state)))
        if state.plans.isEmpty {
            rows.append(PanelRow(label: "Planlar", value: "Yok", tone: .muted))
        } else {
            let open = state.plans.filter { $0.status.isOpen }.count
            rows.append(PanelRow(label: "Planlar", value: open > 0 ? "\(state.plans.count) · \(open) açık" : "\(state.plans.count)", help: state.plans.first?.title))
        }
        let posts = state.contentIds.count
        rows.append(posts == 0 ? PanelRow(label: "Postlar", value: "Yok", tone: .muted) : PanelRow(label: "Postlar", value: "\(posts)"))
        rows.append(PanelRow(label: "Model", value: ComposerStatusText.title(choice)))
        if let run = state.activeRun {
            let value = run.status == .running ? "Hazırlanıyor" : "Sırada"
            rows.append(PanelRow(label: "Yanıt", value: value, tone: run.status == .running ? .normal : .muted))
        }
        return rows
    }

    /// "@image · @image-1": the conversation's image aliases.
    static func aliasLine(_ state: ConversationState) -> String? {
        let names = state.aliases.map { "@" + $0.alias }
        return names.isEmpty ? nil : names.joined(separator: " · ")
    }

    // MARK: Hesaplar

    static func account(platform: Platform, account: SocialAccount?) -> PanelRow {
        let label = platform.displayName
        guard let account else { return PanelRow(label: label, value: "Bağla", tone: .action, help: "\(label) hesabını bağla") }
        switch account.status {
        case .connected:
            switch account.tokenHealth {
            case .expiringSoon?, .invalid?, .missingScopes?:
                return PanelRow(label: label, value: account.tokenHealth?.label ?? "Kontrol et", tone: .attention, help: "\(account.handle) · bağlantı detayları ve anahtar denetimi")
            default:
                let handle = account.handle.trimmingCharacters(in: .whitespaces)
                return PanelRow(label: label, value: handle.isEmpty ? "Bağlı" : handle, help: "\(handle.isEmpty ? label : handle) · bağlı")
            }
        case .needsReauth:
            return PanelRow(label: label, value: "Yeniden bağla", tone: .action, help: "\(account.handle) · anahtar yenilenmeli")
        case .pending:
            return PanelRow(label: label, value: "Bekliyor", tone: .muted, help: account.handle)
        case .disabled, .unknown:
            return PanelRow(label: label, value: "Bağla", tone: .action, help: "\(label) hesabını bağla")
        }
    }
}
