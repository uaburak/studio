import Foundation

// iOS Ayarlar: the Mac host settings bridge, AI keys and preferences, publishing lateness,
// paired devices (the owner's phone may change them since the settings parity work).

extension APIClient {
    // MARK: Mac host settings bridge

    /// `GET /api/host/settings`: the Mac app's own settings as it last sent them.
    public func hostSettings() async throws(StudioAPIError) -> HostSettingsView {
        try await get(HostSettingsView.self, "/api/host/settings")
    }

    /// `POST /api/host/settings/changes`: queue a change; the Mac applies it within seconds.
    /// 409 `conflict` (Turkish message) when it would cut the route this phone uses.
    public func changeHostSettings(_ input: HostSettingsChangeCreate) async throws(StudioAPIError) -> HostSettingsChange {
        try await send(HostSettingsChange.self, .post, "/api/host/settings/changes", body: input)
    }

    // MARK: AI keys

    /// `GET /api/ai/keys` (a phone sees only whether each key is stored).
    public func aiKeys() async throws(StudioAPIError) -> AIKeyList {
        try await get(AIKeyList.self, "/api/ai/keys")
    }

    /// `PUT /api/ai/keys/{provider}`: checked with the provider first; a refused key is not stored (400).
    public func setAIKey(_ provider: AIKeyProvider, key: String) async throws(StudioAPIError) -> AIKeyState {
        try await send(AIKeyState.self, .put, "/api/ai/keys/\(Self.enc(provider.rawValue))", body: AIKeyPut(key: key))
    }

    /// `POST /api/ai/keys/{provider}/check`.
    public func checkAIKey(_ provider: AIKeyProvider) async throws(StudioAPIError) -> AIKeyState {
        try await send(AIKeyState.self, .post, "/api/ai/keys/\(Self.enc(provider.rawValue))/check")
    }

    /// `DELETE /api/ai/keys/{provider}`.
    public func deleteAIKey(_ provider: AIKeyProvider) async throws(StudioAPIError) -> AIKeyState {
        try await send(AIKeyState.self, .delete, "/api/ai/keys/\(Self.enc(provider.rawValue))")
    }

    // MARK: AI preferences

    /// `PUT /api/ai/preferences`: Claude limit, monthly budget, stop at budget, picture captions.
    public func setAIPreferences(_ input: AIPreferencesPut) async throws(StudioAPIError) -> AIPreferences {
        try await send(AIPreferences.self, .put, "/api/ai/preferences", body: input)
    }

    // MARK: Publishing

    /// `PATCH /api/publishing/settings` (maximum lateness, 5 min … 7 days).
    public func setPublishingSettings(_ input: PublishingSettingsPatch) async throws(StudioAPIError) -> PublishingStatus {
        try await send(PublishingStatus.self, .patch, "/api/publishing/settings", body: input)
    }
}
