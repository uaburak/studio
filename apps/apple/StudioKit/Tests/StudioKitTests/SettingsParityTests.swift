import Foundation
import Testing
@testable import StudioKit

/// iOS Ayarlar parity: the Mac host settings bridge models, AI keys / preferences encoders, and
/// the sample backend's settings (lockout guard, self-revoke refusal, keys never read back).
@Suite("Settings parity: host bridge, AI keys, devices")
struct SettingsParityTests {
    private static let viewJSON = """
    {
      "state": {
        "values": {
          "lanEnabled": true, "remoteControlEnabled": true, "remoteHostname": "studio.example.com",
          "keepAwake": true, "notificationsEnabled": false, "appearance": "dark", "ownerName": "Burak",
          "loginItem": false, "defaultModel": "opus", "defaultEffort": "high",
          "metaAppId": "123", "linkedInClientId": ""
        },
        "keys": [
          { "name": "ELEVENLABS_API_KEY", "label": "ElevenLabs", "group": "worker", "secret": true, "saved": true, "source": "env-file" },
          { "name": "SOMETHING_NEW", "label": "Yeni", "group": "future", "secret": true, "saved": false, "source": null }
        ],
        "info": {
          "macName": "Mac", "appVersion": "1.0.0", "mode": "dev", "hostEnabled": true,
          "hostStatus": "Çalışıyor", "hostError": false, "apiPort": 8790, "lanPort": null,
          "lanUrls": [], "tunnel": { "state": "ok", "detail": "Açık" },
          "loginItemSupported": false, "loginItemNote": "", "keepAwakeActive": true,
          "keepAwakeReason": "1 iş sürüyor", "keysSealed": true, "updatesNote": ""
        }
      },
      "seenAt": "2026-11-21T10:00:00.000Z",
      "live": true,
      "via": "tunnel",
      "changes": [
        { "id": "c2", "values": { "keepAwake": false }, "keys": [], "deviceId": "d1", "status": "pending",
          "message": null, "createdAt": "2026-11-21T10:00:05.000Z", "finishedAt": null },
        { "id": "c1", "values": { "appearance": "light" }, "keys": [{ "name": "ELEVENLABS_API_KEY", "action": "set" }],
          "deviceId": "d1", "status": "failed", "message": "Olmadı", "createdAt": "2026-11-21T09:00:00.000Z",
          "finishedAt": "2026-11-21T09:00:03.000Z" }
      ]
    }
    """

    @Test func decodesTheHostViewAndToleratesNewValues() throws {
        let view = try StudioJSON.decoder().decode(HostSettingsView.self, from: Data(Self.viewJSON.utf8))
        #expect(view.via == .tunnel)
        #expect(view.state?.values.appearance == .dark)
        #expect(view.state?.keys.first?.statusText == "Kayıtlı (depodaki .env)")
        #expect(view.state?.keys.last?.name == .unknown)
        #expect(view.state?.keys.last?.group == .unknown)
        #expect(view.pendingCount == 1)
        // A pending change shows where the owner put the switch.
        #expect(view.effectiveValues?.keepAwake == false)
        #expect(view.state?.values.keepAwake == true)
        #expect(view.lastFailure?.message == "Olmadı")
    }

    @Test func encodesOnlyWhatChangesAndNullForRemovedKeys() throws {
        let input = HostSettingsChangeCreate(
            values: HostSettingsPatch(keepAwake: false, defaultModel: .sonnet),
            keys: [HostKeyChange(name: .elevenLabsAPIKey, value: nil)])
        let json = String(decoding: try StudioJSON.encoder().encode(input), as: UTF8.self)
        #expect(json == #"{"keys":[{"name":"ELEVENLABS_API_KEY","value":null}],"values":{"defaultModel":"sonnet","keepAwake":false}}"#)
        #expect(HostSettingsPatch(restartHost: false).isEmpty)
        #expect(!HostSettingsPatch(restartHost: true).isEmpty)
    }

    @Test func knowsWhichChangesCutThePhonesRoute() {
        let current = HostSettingsValues(remoteControlEnabled: true, remoteHostname: "a.example.com")
        #expect(HostSettingsChangeCreate(values: HostSettingsPatch(remoteControlEnabled: false)).cuts(.tunnel, current: current))
        #expect(HostSettingsChangeCreate(values: HostSettingsPatch(remoteHostname: "b.example.com")).cuts(.tunnel, current: current))
        #expect(!HostSettingsChangeCreate(values: HostSettingsPatch(remoteHostname: "a.example.com")).cuts(.tunnel, current: current))
        #expect(HostSettingsChangeCreate(keys: [HostKeyChange(name: .cloudflareTunnelToken, value: "x")]).cuts(.tunnel, current: current))
        #expect(!HostSettingsChangeCreate(values: HostSettingsPatch(lanEnabled: false)).cuts(.tunnel, current: current))
        #expect(HostSettingsChangeCreate(values: HostSettingsPatch(lanEnabled: false)).cuts(.lan, current: current))
        #expect(!HostSettingsChangeCreate(values: HostSettingsPatch(remoteControlEnabled: false)).cuts(.lan, current: current))
    }

    @Test func aiPreferencesClearTheBudgetWithNull() throws {
        let clear = String(decoding: try StudioJSON.encoder().encode(AIPreferencesPut(clearBudget: true)), as: UTF8.self)
        #expect(clear == #"{"monthlyBudgetUsd":null}"#)
        let set = String(decoding: try StudioJSON.encoder().encode(AIPreferencesPut(monthlyBudgetUsd: 20, stopAtBudget: true)), as: UTF8.self)
        #expect(set == #"{"monthlyBudgetUsd":20,"stopAtBudget":true}"#)
    }

    @Test func decodesKeysDevicesAndHealthFromOlderAndNewerServers() throws {
        let keys = try StudioJSON.decoder().decode(AIKeyList.self, from: Data("""
        {"items":[{"provider":"gemini","configured":true,"hint":null,"valid":false,"checkedAt":null,"detail":"Reddedildi","models":[],"updatedAt":null}],"vaultReady":true}
        """.utf8))
        #expect(keys.items.first?.statusText == "Kayıtlı · reddedildi")
        let devices = try StudioJSON.decoder().decode(DeviceList.self, from: Data("""
        {"items":[],"currentDeviceId":"d1"}
        """.utf8))
        #expect(devices.currentDeviceId == "d1")
        let older = try StudioJSON.decoder().decode(DeviceList.self, from: Data(#"{"items":[]}"#.utf8))
        #expect(older.currentDeviceId == nil)
        let health = try StudioJSON.decoder().decode(HealthResponse.self, from: Data("""
        {"status":"ok","service":"studio-api","version":"1","time":"2026-11-21T10:00:00.000Z","checks":{"db":"ok"},
         "components":[{"id":"db","state":"ok","label":"Veritabanı","detail":""}],
         "migrations":{"applied":28,"last":"0027_host_settings_bridge.sql","expected":"0027_host_settings_bridge.sql"}}
        """.utf8))
        #expect(health.components?.first?.label == "Veritabanı")
        #expect(health.migrations?.applied == 28)
        let status = try StudioJSON.decoder().decode(PublishingStatus.self, from: Data("""
        {"mode":"local","cloud":{"configured":false,"url":null,"lastSyncAt":null,"lastSyncOk":null,"lastSyncError":null,"syncRequestedAt":null},"vaultReady":true,"maxLatenessMinutes":90}
        """.utf8))
        #expect(status.maxLatenessMinutes == 90)
    }

    @Test func sampleBackendAppliesChangesAndGuardsTheRoute() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let change = try await backend.changeHostSettings(HostSettingsChangeCreate(
            values: HostSettingsPatch(keepAwake: false),
            keys: [HostKeyChange(name: .geminiAPIKey, value: "AIza-sample-key")]))
        #expect(change.status == .applied)
        #expect(change.message?.contains("yeniden başlayınca") == true)
        let view = try await backend.hostSettings()
        #expect(view.state?.values.keepAwake == false)
        #expect(view.state?.key(.geminiAPIKey)?.saved == true)
        #expect(!String(describing: view).contains("AIza-sample-key"))

        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.changeHostSettings(HostSettingsChangeCreate(values: HostSettingsPatch(lanEnabled: false)))
        }
        await backend.setSampleRoute(.tunnel)
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.changeHostSettings(HostSettingsChangeCreate(values: HostSettingsPatch(remoteControlEnabled: false)))
        }
        _ = try await backend.changeHostSettings(HostSettingsChangeCreate(values: HostSettingsPatch(lanEnabled: false)))
        #expect(try await backend.hostSettings().state?.values.lanEnabled == false)
    }

    @Test func sampleBackendKeepsDevicesKeysAndPreferences() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let devices = try await backend.pairedDevices()
        let own = try #require(devices.currentDeviceId)
        await #expect(throws: StudioAPIError.self) { _ = try await backend.revokeDevice(own) }
        let other = try #require(devices.items.first { $0.id != own })
        #expect(try await backend.revokeDevice(other.id).isRevoked)

        let saved = try await backend.setAIKey(.openai, key: "sk-sample-0123456789")
        #expect(saved.configured && saved.hint == nil)
        #expect(try await backend.deleteAIKey(.openai).configured == false)

        let prefs = try await backend.setAIPreferences(AIPreferencesPut(claudeLimit: .wait, monthlyBudgetUsd: 25, mediaCaptions: true))
        #expect(prefs.claudeLimit == .wait && prefs.monthlyBudgetUsd == 25 && prefs.mediaCaptions == true)
        #expect(try await backend.setAIPreferences(AIPreferencesPut(clearBudget: true)).monthlyBudgetUsd == nil)

        let lateness = try await backend.setPublishingSettings(PublishingSettingsPatch(maxLatenessMinutes: 60))
        #expect(lateness.maxLatenessMinutes == 60)
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.setPublishingSettings(PublishingSettingsPatch(maxLatenessMinutes: 1))
        }
        #expect(try await backend.serverHealth().components?.isEmpty == false)
    }
}
