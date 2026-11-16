import AppKit
import StudioKit

/// Settings → "Yayın": who publishes (cloud publisher or this Mac), the cloud publisher's
/// address and token (Keychain + the API's vault), last sync, and removing it.
/// The notifications switch lives in "Bildirimler".
final class PublishingSectionView: SettingsPaneView {
    private unowned let app: AppModel
    private let secrets: any SecretStore
    private let modeValue = SettingsControls.value("")
    private var modeRow: SettingsRowView!
    private var syncRow: SettingsRowView!
    private var cloudRow: SettingsRowView!
    private var removeRow: SettingsRowView!
    private let urlField = SettingsControls.field("Adres (ör. https://publish.burakkoc.net)", width: nil)
    private let tokenField = SettingsControls.field("PUBLISHER_TOKEN", secure: true, width: nil)
    private let messageLabel = SettingsControls.message()
    private let stepsLabel = SettingsControls.message()
    private var saveButton: PillButton!
    private var observation: ObservationToken?
    private var busy = false

    init(app: AppModel, secrets: any SecretStore = KeychainSecretStore()) {
        self.app = app
        self.secrets = secrets
        super.init(section: .publishing)

        modeRow = addRow(SettingsCatalog.publisher, accessory: modeValue)
        syncRow = addRow(SettingsCatalog.lastSync)

        saveButton = PillButton(title: "Kaydet ve dene", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.save() }
        }
        let footer = SettingsControls.formFooter(fields: [stepsLabel, urlField, tokenField], buttons: [saveButton], message: messageLabel)
        cloudRow = addRow(SettingsCatalog.cloudPublisher, footer: footer)

        let remove = PillButton(title: "Kaldır", kind: .outline, height: 26) { [weak self] in self?.confirmRemove() }
        removeRow = addRow(SettingsCatalog.removeCloudPublisher, accessory: remove)

        observation = observe { [weak self] in self?.render() }
        Task { await app.publishing.refreshStatus() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        let publishing = app.publishing
        let status = publishing.status
        let cloud = status.cloud.configured
        modeValue.stringValue = cloud ? "Bulut yayıncı" : "Bu Mac"
        modeRow.detail = cloud
            ? "Onaylanan zamanlamalar buluta gönderilir; Mac kapalıyken de paylaşılır."
            : "Zamanlanan saatte Mac açık ve Studio çalışıyor olmalı. Instagram ve Facebook görselleri için bulut yayıncı gerekir (Meta görseli herkese açık bir adresten indirir)."

        var sync: [String] = []
        if let at = status.cloud.lastSyncAt {
            sync.append("\(TurkishFormat.dayAndTime(at))\(status.cloud.lastSyncOk == false ? " — hata: \(status.cloud.lastSyncError ?? "")" : "")")
        }
        if !status.vaultReady {
            sync.append("Token kasası anahtarı yok: API'yi Studio başlatmadıysa hesaplar kaydedilemez.")
        }
        if let error = publishing.statusError { sync.append(error) }
        syncRow.detail = sync.joined(separator: "\n")
        syncRow.detailColor = status.cloud.lastSyncOk == false || !status.vaultReady ? Theme.accent : Theme.textSecondary
        syncRow.isAvailable = !sync.isEmpty

        if urlField.stringValue.isEmpty, let url = status.cloud.url { urlField.stringValue = url }
        let steps = PublishingSetupGuide.cloud.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        stepsLabel.stringValue = "Kurulum (bir kez, Cloudflare hesabınla):\n\(steps)"
        stepsLabel.isHidden = cloud
        removeRow.isAvailable = cloud
        saveButton.showsSpinner = busy
        saveButton.isEnabled = !busy
    }

    private func showMessage(_ text: String, error: Bool = false) {
        messageLabel.stringValue = text
        messageLabel.textColor = error ? Theme.accent : Theme.textSecondary
        messageLabel.isHidden = text.isEmpty
    }

    private func save() async {
        let url = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty, !token.isEmpty else {
            showMessage("Adres ve PUBLISHER_TOKEN ikisi de gerekli.", error: true)
            return
        }
        busy = true
        render()
        defer { busy = false; render() }
        do {
            try await app.publishing.saveCloud(url: url, token: token, secrets: secrets)
            tokenField.stringValue = ""
            showMessage("Bulut yayıncıya bağlanıldı. Bekleyen zamanlamalar birkaç saniye içinde gönderilir.")
            await app.calendar.reloadIfVisible(force: true)
        } catch {
            showMessage(AppModel.describe(error), error: true)
        }
    }

    private func confirmRemove() {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Bulut yayıncı kaldırılsın mı?"
        alert.informativeText = "Bundan sonra yayını bu Mac yapar (zamanlanan saatte açık olmalı). Buluta zaten gönderilmiş siparişler orada kalır ve paylaşılır; istemiyorsan önce Takvim'den iptal et."
        alert.addButton(withTitle: "Kaldır")
        alert.addButton(withTitle: "Vazgeç")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task {
                do {
                    try await self.app.publishing.clearCloud(secrets: self.secrets)
                    self.urlField.stringValue = ""
                    self.showMessage("Bulut yayıncı kaldırıldı.")
                } catch {
                    self.showMessage(AppModel.describe(error), error: true)
                }
            }
        }
    }
}
