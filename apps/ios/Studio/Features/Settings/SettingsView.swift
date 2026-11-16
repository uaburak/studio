import SwiftUI

/// Server address and Cloudflare Access service token (Keychain).
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var baseURL = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var hasSavedSecret = false
    @State private var test: TestState = .idle
    @State private var saveError: String?

    enum TestState: Equatable {
        case idle, running
        case ok(String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://127.0.0.1:8787", text: $baseURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Sunucu adresi")
                        .accessibilityIdentifier("baseURLField")
                    Button("Varsayılana dön") { baseURL = ServerConfiguration.defaultBaseURL.absoluteString }
                    Button {
                        Task { await runTest() }
                    } label: {
                        HStack {
                            Text("Bağlantıyı test et")
                            Spacer()
                            switch test {
                            case .idle: EmptyView()
                            case .running: ProgressView()
                            case .ok(let text): Label(text, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                            }
                        }
                    }
                    if case .failed(let message) = test {
                        Text(message).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Sunucu")
                } footer: {
                    Text("Simülatörde Mac'teki yerel API: http://127.0.0.1:8787. Gerçek iPhone'da Mac'in yerel ağ adresi (ör. http://192.168.1.20:8787) ya da Cloudflare adresi (https).")
                }

                Section {
                    TextField("Client ID", text: $clientId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("clientIdField")
                    SecureField(hasSavedSecret ? "Kayıtlı (değiştirmek için yazın)" : "Client Secret", text: $clientSecret)
                        .accessibilityIdentifier("clientSecretField")
                    if app.hasCredentials {
                        Button("Token'ı sil", role: .destructive) {
                            clientId = ""
                            clientSecret = ""
                            hasSavedSecret = false
                        }
                    }
                } header: {
                    Text("Cloudflare Access servis token'ı")
                } footer: {
                    Text("İsteğe bağlı. Anahtar zincirinde (yalnızca bu cihazda) saklanır; her isteğe CF-Access-Client-Id / CF-Access-Client-Secret başlığı olarak eklenir. Yerel sunucu için gerekmez.")
                }

                Section {
                    LabeledContent("Durum", value: app.environment.push.isAvailable ? "Açık" : "Henüz yok")
                } header: {
                    Text("Bildirimler")
                } footer: {
                    Text("Anlık bildirimler Apple Developer Program üyeliği gerektiriyor; üyelik gelince eklenecek.")
                }

                Section("Uygulama") {
                    LabeledContent("Sürüm", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                    LabeledContent("Saat dilimi", value: ScheduleTime.zoneDescription(.current))
                }

                if let saveError {
                    Section { Text(saveError).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Ayarlar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Kaydet") { save() }.accessibilityIdentifier("saveSettings")
                }
            }
            .onAppear(perform: fill)
        }
    }

    private func fill() {
        baseURL = app.configuration.baseURL.absoluteString
        let stored = app.storedCredentials
        clientId = stored?.clientId ?? ""
        hasSavedSecret = stored?.isComplete ?? false
    }

    /// Credentials to save: a new secret if typed, else the stored one (never shown).
    private var credentials: AccessCredentials? {
        let id = clientId.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty else { return nil }
        let secret = clientSecret.isEmpty && hasSavedSecret ? (app.storedCredentials?.clientSecret ?? "") : clientSecret
        return AccessCredentials(clientId: id, clientSecret: secret.trimmingCharacters(in: .whitespaces))
    }

    private func save() {
        switch ServerConfiguration.parseBaseURL(baseURL) {
        case .failure(let error):
            saveError = error.localizedDescription
        case .success(let url):
            if let credentials, !credentials.isComplete {
                saveError = "Client ID ve Client Secret birlikte girilmeli."
                return
            }
            do {
                try app.updateServer(baseURL: url, credentials: credentials)
                dismiss()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }

    private func runTest() async {
        guard case .success(let url) = ServerConfiguration.parseBaseURL(baseURL) else {
            test = .failed("Adres geçersiz.")
            return
        }
        test = .running
        let client = APIClient(
            configuration: ServerConfiguration(baseURL: url),
            authorizer: AccessServiceTokenAuthorizer(credentials: credentials),
            session: app.environment.makeSession())
        do {
            let health = try await client.health()
            test = .ok(health.checks.db == "ok" ? "Bağlandı" : "Bağlandı (veritabanı sorunlu)")
        } catch {
            test = .failed("\(error.title): \(error.localizedDescription)")
        }
    }
}
