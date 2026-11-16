import AppKit
import Foundation
import StudioKit

struct AccountConnectTarget: Equatable, Sendable {
    var brandId: EntityID
    var platform: Platform
}

/// Brand account sheet (opened from an account row in the inspector): the same connect
/// flow as Settings → Hesaplar for one brand — Facebook Login / LinkedIn OAuth with the
/// owner's own apps, health, reconnect, disconnect — plus, under "Gelişmiş", pasting an
/// access token by hand (a Meta system-user token, for example).
final class AccountConnectSheetController: NSViewController, NSTextFieldDelegate {
    private unowned let app: AppModel
    private let target: AccountConnectTarget
    private let onDone: () -> Void

    private var accountsView: AccountsSectionView!
    private let advancedToggle = NSButton(checkboxWithTitle: "Gelişmiş: erişim anahtarını elle gir", target: nil, action: nil)
    private let advancedBox = P3UI.vstack(spacing: 8)
    private let handleField = P3UI.field("Kullanıcı adı / Sayfa adı")
    private let externalIdField = P3UI.field("")
    private let tokenField = P3UI.field("Erişim anahtarı", secure: true)
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    private var saveButton: PillButton!
    private var busy = false

    init(app: AppModel, target: AccountConnectTarget, onDone: @escaping () -> Void) {
        self.app = app
        self.target = target
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let brandName = app.brand(target.brandId)?.name ?? "Marka"
        let title = NSTextField.styledLabel("\(brandName) · Hesaplar", font: NSFont.systemFont(ofSize: 15, weight: .semibold))
        let close = PillButton(title: "Kapat", kind: .secondary, height: 26) { [weak self] in self?.closeSheet() }
        let header = P3UI.hstack([title, P3UI.spacer(), close])

        accountsView = AccountsSectionView(app: app, brandId: target.brandId, focus: target.platform)

        advancedToggle.target = self
        advancedToggle.action = #selector(toggleAdvanced)
        let existing = app.accounts(of: target.brandId).first { $0.platform == target.platform }
        handleField.stringValue = existing?.handle ?? ""
        externalIdField.stringValue = existing?.externalId ?? ""
        externalIdField.placeholderString = switch target.platform {
        case .linkedin: "Person URN (urn:li:person:…)"
        case .instagram: "Instagram İşletme Hesabı ID (ör. 17841400001)"
        case .facebook: "Facebook Sayfa ID"
        case .unknown: "Hesap kimliği"
        }
        for f in [handleField, externalIdField, tokenField] { f.delegate = self }
        messageLabel.font = Theme.smallFont
        messageLabel.textColor = Theme.textSecondary
        messageLabel.preferredMaxLayoutWidth = 480
        saveButton = PillButton(title: "Kasaya kaydet", kind: .secondary, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.saveManual() }
        }
        advancedBox.addArrangedSubview(P3UI.note("Facebook Login yerine hazır bir uzun ömürlü anahtar (ör. Meta sistem kullanıcısı) kullanacaksanız. Anahtar şifreli kasaya yazılır, bir daha gösterilmez."))
        for f in [handleField, externalIdField, tokenField] { P3UI.addFull(f, to: advancedBox) }
        advancedBox.addArrangedSubview(P3UI.hstack([P3UI.spacer(), saveButton]))
        advancedBox.isHidden = true

        let stack = P3UI.vstack([header, HairlineView(), accountsView, advancedToggle, advancedBox, messageLabel], spacing: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        let clip = FlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedDocumentView()
        doc.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = doc
        doc.addSubview(stack)
        root.addSubview(scroll)

        for v in [header, accountsView!, advancedBox, messageLabel] as [NSView] {
            v.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 560),
            root.heightAnchor.constraint(equalToConstant: 600),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            doc.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            doc.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            doc.topAnchor.constraint(equalTo: clip.topAnchor),
            stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: doc.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor, constant: -20),
        ])
        view = root
        refreshButtons()
    }

    override func cancelOperation(_ sender: Any?) { closeSheet() }

    func controlTextDidChange(_ obj: Notification) { refreshButtons() }

    @objc private func toggleAdvanced() {
        advancedBox.isHidden = advancedToggle.state != .on
    }

    private func refreshButtons() {
        let hasToken = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).count >= 8
        let hasHandle = !handleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasId = !externalIdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        saveButton.isEnabled = !busy && hasToken && hasHandle && hasId
        saveButton.showsSpinner = busy
    }

    private func saveManual() async {
        guard !busy else { return }
        busy = true
        refreshButtons()
        defer { busy = false; refreshButtons() }
        let handle = handleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let extId = externalIdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if target.platform == .linkedin {
                _ = try await app.dataService.connectLinkedInAccount(
                    LinkedInConnectInput(brandId: target.brandId, handle: handle, personUrn: extId, accessToken: token))
            } else {
                let existing = app.accounts(of: target.brandId).first { $0.platform == target.platform && ($0.externalId == extId || $0.externalId == nil) }
                let accountId: EntityID
                if let existing {
                    accountId = existing.id
                } else {
                    accountId = try await app.dataService.createSocialAccount(
                        SocialAccountCreate(brandId: target.brandId, platform: target.platform, handle: handle, externalId: extId)).id
                }
                _ = try await app.dataService.putSocialAccountToken(
                    id: accountId, SocialAccountTokenPut(accessToken: token, externalId: extId, handle: handle))
            }
            tokenField.stringValue = ""
            await app.refreshAccounts()
            messageLabel.stringValue = "\(target.platform.displayName) erişim anahtarı şifreli kasaya kaydedildi. “Denetle” ile sağlığını kontrol edin."
            messageLabel.textColor = Theme.textSecondary
        } catch {
            messageLabel.stringValue = AppModel.describe(error)
            messageLabel.textColor = Theme.accent
        }
    }

    private func closeSheet() {
        accountsView.stop()
        onDone()
        dismiss(nil)
    }
}
