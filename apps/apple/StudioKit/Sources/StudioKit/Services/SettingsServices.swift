import Foundation

/// Ayarlar defaults: other conformers keep compiling; reads come back empty and changes say they
/// cannot be made on this connection.
extension StudioDataService {
    public func hostSettings() async throws -> HostSettingsView {
        HostSettingsView(state: nil, live: false, via: .unknown)
    }
    public func changeHostSettings(_ input: HostSettingsChangeCreate) async throws -> HostSettingsChange {
        throw StudioAPIError.invalidConfiguration("Mac ayarları bu bağlantıda değiştirilemiyor.")
    }
    public func aiKeys() async throws -> AIKeyList { AIKeyList(items: [], vaultReady: false) }
    public func setAIKey(_ provider: AIKeyProvider, key: String) async throws -> AIKeyState {
        throw StudioAPIError.invalidConfiguration("Anahtar bu bağlantıda kaydedilemiyor.")
    }
    public func checkAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState {
        throw StudioAPIError.invalidConfiguration("Anahtar bu bağlantıda denetlenemiyor.")
    }
    public func deleteAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState {
        throw StudioAPIError.invalidConfiguration("Anahtar bu bağlantıda silinemiyor.")
    }
    public func setAIPreferences(_ input: AIPreferencesPut) async throws -> AIPreferences {
        throw StudioAPIError.invalidConfiguration("Yapay zekâ ayarları bu bağlantıda kaydedilemiyor.")
    }
    public func setPublishingSettings(_ input: PublishingSettingsPatch) async throws -> PublishingStatus {
        throw StudioAPIError.invalidConfiguration("Yayın ayarları bu bağlantıda kaydedilemiyor.")
    }
    public func pairedDevices() async throws -> DeviceList { DeviceList(items: []) }
    public func revokeDevice(_ id: EntityID) async throws -> PairedDevice {
        throw StudioAPIError.invalidConfiguration("Cihaz bu bağlantıda kaldırılamıyor.")
    }
    public func serverHealth() async throws -> HealthResponse {
        throw StudioAPIError.invalidConfiguration("Sunucu sağlığı bu bağlantıda okunamıyor.")
    }
}

extension RemoteStudioDataService {
    public func hostSettings() async throws -> HostSettingsView { try await client.hostSettings() }
    public func changeHostSettings(_ input: HostSettingsChangeCreate) async throws -> HostSettingsChange {
        try await client.changeHostSettings(input)
    }
    public func aiKeys() async throws -> AIKeyList { try await client.aiKeys() }
    public func setAIKey(_ provider: AIKeyProvider, key: String) async throws -> AIKeyState {
        try await client.setAIKey(provider, key: key)
    }
    public func checkAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState { try await client.checkAIKey(provider) }
    public func deleteAIKey(_ provider: AIKeyProvider) async throws -> AIKeyState { try await client.deleteAIKey(provider) }
    public func setAIPreferences(_ input: AIPreferencesPut) async throws -> AIPreferences {
        try await client.setAIPreferences(input)
    }
    public func setPublishingSettings(_ input: PublishingSettingsPatch) async throws -> PublishingStatus {
        try await client.setPublishingSettings(input)
    }
    public func pairedDevices() async throws -> DeviceList { try await client.deviceList() }
    public func revokeDevice(_ id: EntityID) async throws -> PairedDevice { try await client.revokeDevice(id) }
    public func serverHealth() async throws -> HealthResponse { try await client.health() }
}
