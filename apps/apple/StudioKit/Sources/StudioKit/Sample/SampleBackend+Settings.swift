import Foundation

/// The settings the sample backend keeps in memory (Ayarlar parity): the Mac app's own settings
/// as its bridge would report them, AI keys, preferences, publishing and paired devices.
struct SampleSettings: Sendable {
    var host: HostSettingsState = SampleSettings.defaultHost
    var changes: [HostSettingsChange] = []
    /// Which way the sample phone "reaches" the Mac (the lockout guard reads it).
    var via: HostRoute = .lan
    var keys: [AIKeyProvider: AIKeyState] = [
        .gemini: AIKeyState(provider: .gemini, configured: true, valid: true, checkedAt: Date(), detail: "Anahtar geçerli; 12 model.", models: ["gemini-flash"]),
        .openai: AIKeyState(provider: .openai, configured: false),
    ]
    var preferences = AIPreferences()
    var publishing = PublishingStatus.unknownLocal
    var devices: [PairedDevice] = [
        PairedDevice(id: "dev-this", name: "Bu iPhone", platform: .ios, createdAt: Date(timeIntervalSince1970: 1_790_000_000), lastSeenAt: Date(), revokedAt: nil),
        PairedDevice(id: "dev-old", name: "Eski iPhone", platform: .ios, createdAt: Date(timeIntervalSince1970: 1_780_000_000), lastSeenAt: Date(timeIntervalSince1970: 1_785_000_000), revokedAt: nil),
    ]
    let currentDeviceId = "dev-this"
    var tools: [ToolStatus] = [
        ToolStatus(id: "claude", label: "Claude Code", purpose: "Sohbet ve içerik üretimi (Opus, Sonnet, Haiku).", source: "Anthropic (claude.ai)", sourceUrl: "https://claude.ai/download", sizeBytes: 60_000_000, state: .installed, version: "2.4.1", path: "/usr/local/bin/claude", location: .system, installable: true),
        ToolStatus(id: "chromium", label: "Chromium", purpose: "Post görsellerini çizer.", source: "Playwright (Microsoft)", sourceUrl: "https://playwright.dev", sizeBytes: 150_000_000, state: .outdated, version: "1200", targetVersion: "1208", location: .studio, installable: true, removable: true),
        ToolStatus(id: "ffmpeg", label: "ffmpeg", purpose: "Reels videolarını hazırlar.", source: "ffmpeg.org (evermeet.cx)", sourceUrl: "https://evermeet.cx/ffmpeg/", sizeBytes: 29_000_000, state: .missing, targetVersion: "7.1", installable: true),
        ToolStatus(id: "whisper", label: "Whisper", purpose: "Sesli mesajları yazıya döker.", source: "OpenAI (whisper.cpp)", sourceUrl: "https://github.com/ggerganov/whisper.cpp", state: .missing, installable: false, optional: true, note: "Uygulamadan kurulum yakında."),
    ]

    static let defaultHost = HostSettingsState(
        values: HostSettingsValues(
            lanEnabled: true, remoteControlEnabled: true, remoteHostname: "studio.ornek.com",
            keepAwake: true, notificationsEnabled: true, appearance: .system, ownerName: "",
            loginItem: true, defaultModel: AgentModel.opus.rawValue, defaultEffort: AgentEffort.high.rawValue,
            metaAppId: "1234567890", linkedInClientId: ""),
        keys: [
            HostKeyState(name: .cloudflareTunnelToken, label: "Tünel anahtarı (CLOUDFLARE_TUNNEL_TOKEN)", group: .tunnel, secret: true, saved: true, source: .settings),
            HostKeyState(name: .geminiAPIKey, label: "Gemini API anahtarı (kasa yoksa)", group: .worker, secret: true, saved: false),
            HostKeyState(name: .elevenLabsAPIKey, label: "ElevenLabs API anahtarı (Reels seslendirme)", group: .worker, secret: true, saved: true, source: .settings),
            HostKeyState(name: .elevenLabsVoiceID, label: "ElevenLabs ses kimliği", group: .worker, secret: false, saved: false),
            HostKeyState(name: .cloudPublisherURL, label: "Bulut yayıncı adresi (eski yol)", group: .worker, secret: false, saved: false),
            HostKeyState(name: .cloudPublisherToken, label: "Bulut yayıncı anahtarı (eski yol)", group: .worker, secret: true, saved: false),
            HostKeyState(name: .metaAppSecret, label: "Meta App Secret", group: .accounts, secret: true, saved: true, source: .settings),
            HostKeyState(name: .linkedInClientSecret, label: "LinkedIn Client Secret", group: .accounts, secret: true, saved: false),
        ],
        info: HostInfo(
            macName: "Örnek Mac", appVersion: "1.0.0", mode: "packaged", hostEnabled: true,
            hostStatus: "Çalışıyor · API: çalışıyor · Yerel ağ: çalışıyor · Worker: çalışıyor · Tünel: çalışıyor",
            apiPort: 8790, lanPort: 8791, lanUrls: ["http://192.168.1.20:8791"],
            tunnel: HostInfo.Tunnel(state: "ok", detail: "Açık: https://studio.ornek.com"),
            loginItemSupported: true, loginItemNote: "Mac açılınca Studio arka planda başlar.",
            keepAwakeActive: false, keepAwakeReason: nil, keysSealed: true,
            updatesNote: "Otomatik güncelleme kapalı: yeni sürümü Mac'te elle kur."))
}

extension SampleBackend {
    private var sampleNow: Date { Date() }

    /// Which way the sample phone reaches the Mac (tests of the lockout guard).
    public func setSampleRoute(_ via: HostRoute) { settingsSample.via = via }

    public func hostSettings() async throws -> HostSettingsView {
        HostSettingsView(state: settingsSample.host, seenAt: sampleNow, live: true, via: settingsSample.via, changes: settingsSample.changes)
    }

    /// The sample "Mac" applies a change at once, like a bridge that synced right away.
    public func changeHostSettings(_ input: HostSettingsChangeCreate) async throws -> HostSettingsChange {
        if input.values.isEmpty, input.keys.isEmpty {
            throw StudioAPIError.server(status: 400, code: .validationError, message: "nothing to change", issues: [])
        }
        if input.cuts(settingsSample.via, current: settingsSample.host.values) {
            let message = settingsSample.via == .tunnel ? HostLockout.tunnel : HostLockout.lan
            throw StudioAPIError.server(status: 409, code: .conflict, message: message, issues: [])
        }
        settingsSample.host.values = settingsSample.host.values.applying(input.values)
        for change in input.keys {
            guard let index = settingsSample.host.keys.firstIndex(where: { $0.name == change.name }) else { continue }
            settingsSample.host.keys[index].saved = change.value != nil
            settingsSample.host.keys[index].source = change.value != nil ? .settings : nil
        }
        let workerKeys = input.keys.contains { settingsSample.host.key($0.name)?.group == .worker }
        let message = input.values.restartHost == true
            ? "Sunucu yeniden başlatılıyor."
            : workerKeys ? "Worker anahtarları sunucu yeniden başlayınca kullanılır." : "Uygulandı."
        let change = HostSettingsChange(
            id: "hsc-\(settingsSample.changes.count + 1)", values: input.values,
            keys: input.keys.map { HostSettingsChange.KeyAction(name: $0.name, action: $0.value == nil ? "remove" : "set") },
            deviceId: settingsSample.currentDeviceId, status: .applied, message: message,
            createdAt: sampleNow, finishedAt: sampleNow)
        settingsSample.changes.insert(change, at: 0)
        return change
    }

    public func aiKeys() async throws -> AIKeyList {
        AIKeyList(items: AIKeyProvider.knownCases.compactMap { settingsSample.keys[$0] }, vaultReady: true)
    }

    public func setAIKey(_ provider: AIKeyProvider, key: String) async throws -> AIKeyState {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 10, !trimmed.contains(" ") else {
            throw StudioAPIError.server(status: 400, code: .validationError, message: "Anahtar geçersiz görünüyor.", issues: [])
        }
        let state = AIKeyState(provider: provider, configured: true, valid: true, checkedAt: sampleNow, detail: "Anahtar geçerli.", models: [], updatedAt: sampleNow)
        settingsSample.keys[provider] = state
        return state
    }

    public func checkAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState {
        guard var state = settingsSample.keys[provider], state.configured else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "AI key \(provider.rawValue) not found", issues: [])
        }
        state.checkedAt = sampleNow
        state.valid = true
        settingsSample.keys[provider] = state
        return state
    }

    public func deleteAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState {
        let state = AIKeyState(provider: provider, configured: false)
        settingsSample.keys[provider] = state
        return state
    }

    public func aiPreferences() async throws -> AIPreferences { settingsSample.preferences }

    public func setAIPreferences(_ input: AIPreferencesPut) async throws -> AIPreferences {
        var next = settingsSample.preferences
        if let mode = input.claudeLimit { next.claudeLimit = mode }
        if input.clearBudget { next.monthlyBudgetUsd = nil } else if let budget = input.monthlyBudgetUsd { next.monthlyBudgetUsd = budget }
        if let stop = input.stopAtBudget { next.stopAtBudget = stop }
        if let captions = input.mediaCaptions { next.mediaCaptions = captions }
        next.updatedAt = sampleNow
        settingsSample.preferences = next
        return next
    }

    public func publishingStatus() async throws -> PublishingStatus { settingsSample.publishing }

    public func setCloudPublisher(url: String, token: String) async throws -> PublishingStatus {
        settingsSample.publishing.mode = .cloud
        settingsSample.publishing.cloud = PublishingStatus.Cloud(configured: true, url: url, lastSyncAt: sampleNow, lastSyncOk: true)
        return settingsSample.publishing
    }

    public func clearCloudPublisher() async throws -> PublishingStatus {
        settingsSample.publishing.mode = .local
        settingsSample.publishing.cloud = PublishingStatus.Cloud(configured: false)
        return settingsSample.publishing
    }

    public func setPublishingSettings(_ input: PublishingSettingsPatch) async throws -> PublishingStatus {
        if let minutes = input.maxLatenessMinutes {
            guard (PublishingSettingsPatch.minLateness...PublishingSettingsPatch.maxLateness).contains(minutes) else {
                throw StudioAPIError.server(status: 400, code: .validationError, message: "invalid request json", issues: [])
            }
            settingsSample.publishing.maxLatenessMinutes = minutes
        }
        return settingsSample.publishing
    }

    public func pairedDevices() async throws -> DeviceList {
        DeviceList(items: settingsSample.devices, currentDeviceId: settingsSample.currentDeviceId)
    }

    public func revokeDevice(_ id: EntityID) async throws -> PairedDevice {
        if id == settingsSample.currentDeviceId {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "Bu iPhone kendini buradan kaldıramaz. Ayarlar → Mac → Bağlantıyı kaldır'ı kullan ya da Mac'te kaldır.", issues: [])
        }
        guard let index = settingsSample.devices.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "device \(id) not found", issues: [])
        }
        if settingsSample.devices[index].revokedAt == nil { settingsSample.devices[index].revokedAt = sampleNow }
        return settingsSample.devices[index]
    }

    public func tools() async throws -> ToolsControl {
        ToolsControl(tools: settingsSample.tools, online: true, reportedAt: sampleNow)
    }

    public func refreshTools() async throws -> ToolsControl {
        ToolsControl(tools: settingsSample.tools, online: true, reportedAt: sampleNow, sent: 1)
    }

    /// The sample "Mac" installs at once.
    public func installTool(_ id: String, update: Bool) async throws -> Job {
        guard let index = settingsSample.tools.firstIndex(where: { $0.id == id }) else {
            throw StudioAPIError.server(status: 404, code: .notFound, message: "tool \(id) not found", issues: [])
        }
        var tool = settingsSample.tools[index]
        guard tool.installable else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "\(tool.label) uygulamadan kurulamıyor.", issues: [])
        }
        if tool.state == .installed, !(update && tool.location == .studio) {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "\(tool.label) bu Mac'te zaten kurulu.", issues: [])
        }
        tool.state = .installed
        tool.location = .studio
        tool.removable = true
        tool.version = tool.targetVersion ?? tool.version ?? "1.0"
        tool.error = nil
        settingsSample.tools[index] = tool
        return Job(id: "job-tool-\(id)", type: .toolInstall, status: .succeeded, payload: ["toolId": .string(id)], createdAt: sampleNow, updatedAt: sampleNow)
    }

    public func uninstallTool(_ id: String) async throws -> Job {
        guard let index = settingsSample.tools.firstIndex(where: { $0.id == id }), settingsSample.tools[index].location == .studio else {
            throw StudioAPIError.server(status: 409, code: .conflict, message: "Studio'nun bu araçtan kendi kopyası yok.", issues: [])
        }
        settingsSample.tools[index].state = .missing
        settingsSample.tools[index].location = nil
        settingsSample.tools[index].version = nil
        settingsSample.tools[index].removable = false
        return Job(id: "job-untool-\(id)", type: .toolUninstall, status: .succeeded, payload: ["toolId": .string(id)], createdAt: sampleNow, updatedAt: sampleNow)
    }

    public func serverHealth() async throws -> HealthResponse {
        HealthResponse(
            status: "ok", service: "studio-api", version: "0.0.0", time: sampleNow,
            checks: HealthResponse.Checks(db: "ok"), instance: "sample-mac",
            components: [
                HealthComponent(id: "db", state: "ok", label: "Veritabanı", detail: "Çalışıyor."),
                HealthComponent(id: "worker", state: "ok", label: "Worker", detail: "Bağlı."),
                HealthComponent(id: "cloud", state: "warn", label: "Bulut yayıncı", detail: "Kurulmadı; yayını bu Mac yapar."),
            ],
            migrations: nil)
    }
}
