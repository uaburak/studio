import StudioKit
import SwiftUI

/// Settings (⌘,): appearance, server address, Cloudflare Access service token.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(AppSettings.self) private var settings
    @State private var server = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var status: String?
    @State private var testing = false

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section("Görünüm") {
                Picker("Görünüm", selection: $settings.appearance) {
                    ForEach(AppearancePreference.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                Text("Sistem: macOS ayarını izler. Değişiklik hemen uygulanır (⇧⌘L ile de değişir).")
                    .font(Theme.smallFont).foregroundStyle(.secondary)
            }

            Section("Sunucu") {
                if app.isSample {
                    Text("Uygulama örnek verilerle açıldı (-StudioSampleData YES). Sunucu ayarı bu oturumda kullanılmıyor.")
                        .font(Theme.smallFont).foregroundStyle(.secondary)
                }
                TextField("Adres", text: $server, prompt: Text(APIClient.localDefaultURL.absoluteString))
                    .onSubmit(save)
                HStack {
                    Button("Kaydet ve bağlan", action: save)
                    Button("Bağlantıyı dene") { Task { await test() } }
                        .disabled(testing)
                    if let status { Text(status).font(Theme.smallFont).foregroundStyle(.secondary) }
                }
            }

            Section("Cloudflare Access") {
                Text("Sunucu Access arkasındaysa servis anahtarını gir. Anahtar zincirinde saklanır.")
                    .font(Theme.smallFont).foregroundStyle(.secondary)
                TextField("Client ID", text: $clientId)
                SecureField("Client Secret", text: $clientSecret)
                HStack {
                    Button("Anahtarı kaydet") { saveToken() }
                        .disabled(clientId.isEmpty || clientSecret.isEmpty)
                    Button("Anahtarı sil") { deleteToken() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .onAppear {
            server = settings.serverURLString
            clientId = (try? settings.credentials.load())?.clientId ?? ""
        }
    }

    private func save() {
        settings.serverURLString = server
        guard settings.serverURL != nil else {
            status = "Adres http:// ya da https:// ile başlamalı."
            return
        }
        app.reconnect()
        status = "Kaydedildi."
    }

    private func test() async {
        testing = true
        defer { testing = false }
        guard let url = URL(string: server), url.scheme?.hasPrefix("http") == true else {
            status = "Adres geçersiz."
            return
        }
        do {
            let health = try await APIClient(baseURL: url, auth: AccessServiceTokenAuth(store: settings.credentials)).health()
            status = "Bağlandı: \(health.service) \(health.version), veritabanı \(health.checks.db)."
        } catch {
            status = error.errorDescription
        }
    }

    private func saveToken() {
        do {
            try settings.credentials.save(AccessServiceToken(clientId: clientId, clientSecret: clientSecret))
            clientSecret = ""
            status = "Anahtar kaydedildi."
            app.reconnect()
        } catch {
            status = error.localizedDescription
        }
    }

    private func deleteToken() {
        try? settings.credentials.delete()
        clientId = ""
        clientSecret = ""
        status = "Anahtar silindi."
        app.reconnect()
    }
}

/// Settings presented as a sheet inside the main window.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Ayarlar").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("Bitti") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 8)
            SettingsView()
        }
        .frame(width: 560, height: 600)
    }
}
