import AppKit
import Foundation
import StudioKit

struct AccountConnectTarget: Equatable, Sendable {
    var brandId: EntityID
    var platform: Platform
}

/// Pure AppKit sheet for connecting / inspecting Instagram, Facebook, and LinkedIn accounts
/// (`discoverMetaAccounts`, `putSocialAccountToken`, `connectLinkedInAccount`, `checkSocialAccountToken`).
final class AccountConnectSheetController: NSViewController, NSTextFieldDelegate {
    private unowned let app: AppModel
    private let target: AccountConnectTarget
    private let onDone: () -> Void

    private var metaModeSegment: NSSegmentedControl?
    private let metaDiscoverStack = NSStackView()
    private let metaUserTokenField = NSSecureTextField()
    private let discoveredPagesStack = NSStackView()

    private let directStack = NSStackView()
    private let handleField = NSTextField()
    private let externalIdField = NSTextField()
    private let accessTokenField = NSSecureTextField()

    private let healthDot = StatusDotView(size: 8)
    private let healthLabel = NSTextField(labelWithString: "")
    private let statusBanner = InlineErrorBannerView()
    private let infoMessageLabel = NSTextField(wrappingLabelWithString: "")

    private var primaryConnectBtn: PillButton!
    private var checkTokenBtn: PillButton!
    private var disableAccountBtn: PillButton!

    private var busy = false
    private var discoveredPages: [MetaDiscoveredPage] = []

    init(app: AppModel, target: AccountConnectTarget, onDone: @escaping () -> Void) {
        self.app = app
        self.target = target
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var existingAccount: SocialAccount? {
        app.accounts(of: target.brandId).first { $0.platform == target.platform }
    }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let brandName = app.brand(target.brandId)?.name ?? "Marka"
        let titleLabel = NSTextField.styledLabel(
            "\(brandName) · \(target.platform.displayName) Bağlantısı",
            font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            color: Theme.textPrimary
        )
        let topSpacer = NSView()
        topSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let closeBtn = PillButton(title: "Kapat", kind: .secondary, height: 26) { [weak self] in
            self?.closeSheet()
        }
        let headerRow = NSStackView(views: [titleLabel, topSpacer, closeBtn])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        let topHairline = HairlineView()
        topHairline.translatesAutoresizingMaskIntoConstraints = false

        // Token health summary card
        let healthCard = SettingsGroupCardView(title: "Bağlantı ve Anahtar Durumu")
        healthLabel.font = Theme.captionFont
        healthLabel.textColor = Theme.textPrimary
        let healthRow = NSStackView(views: [healthDot, healthLabel])
        healthRow.orientation = .horizontal
        healthRow.alignment = .centerY
        healthRow.spacing = 8
        healthCard.addFullWidth(healthRow)

        checkTokenBtn = PillButton(title: "Anahtarı Denetle", kind: .secondary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.checkToken() }
        }
        disableAccountBtn = PillButton(title: "Devre dışı bırak", kind: .secondary, height: 24) { [weak self] in
            guard let self else { return }
            Task { await self.disableAccount() }
        }
        let healthActions = NSStackView(views: [checkTokenBtn, disableAccountBtn])
        healthActions.orientation = .horizontal
        healthActions.spacing = 8
        healthCard.stack.addArrangedSubview(healthActions)

        let formStack = NSStackView()
        formStack.orientation = .vertical
        formStack.alignment = .leading
        formStack.spacing = 14
        formStack.translatesAutoresizingMaskIntoConstraints = false
        formStack.addArrangedSubview(healthCard)
        healthCard.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        if target.platform == .instagram || target.platform == .facebook {
            let modeSeg = NSSegmentedControl(
                labels: [
                    "Facebook Login Erişim Anahtarı ile Sayfaları Keşfet",
                    "Doğrudan Anahtar Gir",
                ],
                trackingMode: .selectOne,
                target: self,
                action: #selector(metaModeChanged)
            )
            modeSeg.selectedSegment = 0
            self.metaModeSegment = modeSeg
            formStack.addArrangedSubview(modeSeg)

            // Option A: Meta Discover
            metaDiscoverStack.orientation = .vertical
            metaDiscoverStack.alignment = .leading
            metaDiscoverStack.spacing = 8
            metaDiscoverStack.addArrangedSubview(NSTextField.styledLabel(
                "Facebook Kullanıcı Erişim Anahtarını (EAA…) yapıştırın; bağlı Facebook Sayfaları ve Instagram İşletme hesapları otomatik keşfedilip bağlanır.",
                font: Theme.smallFont,
                color: Theme.textSecondary,
                wraps: true
            ))
            metaUserTokenField.placeholderString = "Facebook User Access Token (EAA…)"
            metaUserTokenField.bezelStyle = .roundedBezel
            metaUserTokenField.delegate = self
            metaDiscoverStack.addArrangedSubview(metaUserTokenField)

            discoveredPagesStack.orientation = .vertical
            discoveredPagesStack.alignment = .leading
            discoveredPagesStack.spacing = 4
            metaDiscoverStack.addArrangedSubview(discoveredPagesStack)

            for v in metaDiscoverStack.arrangedSubviews {
                v.widthAnchor.constraint(equalTo: metaDiscoverStack.widthAnchor).isActive = true
            }
            formStack.addArrangedSubview(metaDiscoverStack)
            metaDiscoverStack.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true
        }

        // Direct / LinkedIn form
        directStack.orientation = .vertical
        directStack.alignment = .leading
        directStack.spacing = 8

        handleField.stringValue = existingAccount?.handle ?? ""
        handleField.placeholderString = target.platform == .instagram ? "mtmagro" : "MTM Agro"
        handleField.bezelStyle = .roundedBezel
        handleField.delegate = self

        externalIdField.stringValue = existingAccount?.externalId ?? ""
        externalIdField.placeholderString = switch target.platform {
        case .linkedin: "urn:li:person:abc123"
        case .instagram: "IG User ID (örn. 17841400001)"
        case .facebook: "Facebook Page ID (örn. 10223344)"
        case .unknown: "Hesap kimliği"
        }
        externalIdField.bezelStyle = .roundedBezel
        externalIdField.delegate = self

        accessTokenField.placeholderString = target.platform == .linkedin
            ? "60 günlük LinkedIn OAuth Access Token (AQV…)"
            : "Uzun ömürlü Sayfa / IG Erişim Anahtarı (EAA…)"
        accessTokenField.bezelStyle = .roundedBezel
        accessTokenField.delegate = self

        let extTitle = switch target.platform {
        case .linkedin: "Person URN (urn:li:person:…)"
        case .instagram: "Instagram İşletme Hesabı ID"
        case .facebook: "Facebook Sayfa ID"
        case .unknown: "Platform Hesap ID"
        }

        directStack.addArrangedSubview(NSTextField.styledLabel("Kullanıcı adı / Sayfa adı", font: Theme.captionFont, color: Theme.textSecondary))
        directStack.addArrangedSubview(handleField)
        directStack.addArrangedSubview(NSTextField.styledLabel(extTitle, font: Theme.captionFont, color: Theme.textSecondary))
        directStack.addArrangedSubview(externalIdField)
        directStack.addArrangedSubview(NSTextField.styledLabel("OAuth Erişim Anahtarı (Şifreli Kasada Saklanır)", font: Theme.captionFont, color: Theme.textSecondary))
        directStack.addArrangedSubview(accessTokenField)

        for v in [handleField, externalIdField, accessTokenField] {
            v.widthAnchor.constraint(equalTo: directStack.widthAnchor).isActive = true
        }
        formStack.addArrangedSubview(directStack)
        directStack.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        statusBanner.isHidden = true
        statusBanner.onDismiss = { [weak self] in self?.statusBanner.isHidden = true }
        formStack.addArrangedSubview(statusBanner)
        statusBanner.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        infoMessageLabel.font = Theme.smallFont
        infoMessageLabel.textColor = Theme.textSecondary
        infoMessageLabel.isHidden = true
        formStack.addArrangedSubview(infoMessageLabel)
        infoMessageLabel.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        let cancelBtn = PillButton(title: "Vazgeç", kind: .secondary, height: 28) { [weak self] in
            self?.closeSheet()
        }
        primaryConnectBtn = PillButton(title: "Bağla", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.submitConnect() }
        }
        let bottomSpacer = NSView()
        bottomSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bottomRow = NSStackView(views: [bottomSpacer, cancelBtn, primaryConnectBtn])
        bottomRow.orientation = .horizontal
        bottomRow.alignment = .centerY
        bottomRow.spacing = 8
        formStack.addArrangedSubview(bottomRow)
        bottomRow.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        root.addSubview(headerRow)
        root.addSubview(topHairline)
        root.addSubview(formStack)

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 520),
            headerRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            headerRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            headerRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),

            topHairline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topHairline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topHairline.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 12),

            formStack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            formStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            formStack.topAnchor.constraint(equalTo: topHairline.bottomAnchor, constant: 16),
            formStack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])

        self.view = root
        refreshUI()
    }

    override func cancelOperation(_ sender: Any?) {
        closeSheet()
    }

    @objc private func metaModeChanged() {
        refreshUI()
    }

    func controlTextDidChange(_ obj: Notification) {
        refreshButtons()
    }

    private var isMetaDiscoverMode: Bool {
        guard let seg = metaModeSegment else { return false }
        return seg.selectedSegment == 0
    }

    private func refreshUI() {
        let isDiscover = isMetaDiscoverMode
        metaDiscoverStack.isHidden = !isDiscover
        directStack.isHidden = isDiscover

        if let account = existingAccount {
            let health = account.tokenHealth ?? (account.status == .connected ? .valid : .unchecked)
            switch health {
            case .valid:
                healthDot.color = .systemGreen
            case .expiringSoon:
                healthDot.color = Theme.accent
            case .invalid, .missingScopes:
                healthDot.color = .systemRed
            case .unchecked, .unknown:
                healthDot.color = Theme.textTertiary
            }
            var parts = ["\(account.handle) (\(account.status.label))", "Anahtar: \(health.label)"]
            if let exp = account.tokenExpiresAt {
                parts.append("Bitiş: \(TurkishFormat.shortDay(exp))")
            }
            healthLabel.stringValue = parts.joined(separator: " · ")
            checkTokenBtn.isHidden = false
            disableAccountBtn.isHidden = account.status == .disabled
        } else {
            healthDot.color = Theme.textTertiary
            healthLabel.stringValue = "Bu marka için henüz bağlı \(target.platform.displayName) hesabı yok."
            checkTokenBtn.isHidden = true
            disableAccountBtn.isHidden = true
        }

        primaryConnectBtn.title = isDiscover ? "Sayfaları Keşfet ve Bağla" : "Kaydet ve Bağla"
        refreshButtons()
    }

    private func refreshButtons() {
        checkTokenBtn.isEnabled = !busy && existingAccount != nil
        disableAccountBtn.isEnabled = !busy && existingAccount != nil
        primaryConnectBtn.showsSpinner = busy

        if isMetaDiscoverMode {
            primaryConnectBtn.isEnabled = !busy && metaUserTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).count >= 8
        } else {
            let hasToken = accessTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).count >= 8
            let hasHandle = !handleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let hasUrn = target.platform != .linkedin || !externalIdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            primaryConnectBtn.isEnabled = !busy && hasToken && hasHandle && hasUrn
        }
    }

    private func submitConnect() async {
        guard !busy else { return }
        busy = true
        statusBanner.isHidden = true
        refreshButtons()
        defer {
            busy = false
            refreshUI()
        }

        do {
            if isMetaDiscoverMode {
                let token = metaUserTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let result = try await app.dataService.discoverMetaAccounts(
                    MetaDiscoverInput(brandId: target.brandId, userAccessToken: token, autoConnect: true)
                )
                discoveredPages = result.pages
                rebuildDiscoveredPages()
                await app.refreshAccounts()
                metaUserTokenField.stringValue = ""
                infoMessageLabel.stringValue = "\(result.connectedAccounts.count) hesap otomatik bağlandı."
                infoMessageLabel.isHidden = false
            } else if target.platform == .linkedin {
                let handle = handleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let urn = externalIdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let token = accessTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                _ = try await app.dataService.connectLinkedInAccount(
                    LinkedInConnectInput(brandId: target.brandId, handle: handle, personUrn: urn, accessToken: token)
                )
                accessTokenField.stringValue = ""
                await app.refreshAccounts()
                infoMessageLabel.stringValue = "LinkedIn hesabı bağlandı ve anahtar doğrulandı."
                infoMessageLabel.isHidden = false
            } else {
                let handle = handleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let extId = externalIdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let token = accessTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let accountId: EntityID
                if let existing = existingAccount {
                    accountId = existing.id
                } else {
                    let created = try await app.dataService.createSocialAccount(
                        SocialAccountCreate(brandId: target.brandId, platform: target.platform, handle: handle, externalId: extId.isEmpty ? nil : extId)
                    )
                    accountId = created.id
                }
                _ = try await app.dataService.putSocialAccountToken(
                    id: accountId,
                    SocialAccountTokenPut(
                        accessToken: token,
                        externalId: extId.isEmpty ? nil : extId,
                        handle: handle
                    )
                )
                accessTokenField.stringValue = ""
                await app.refreshAccounts()
                infoMessageLabel.stringValue = "\(target.platform.displayName) erişim anahtarı kasaya kaydedildi."
                infoMessageLabel.isHidden = false
            }
        } catch {
            statusBanner.message = AppModel.describe(error)
            statusBanner.isHidden = false
        }
    }

    private func rebuildDiscoveredPages() {
        discoveredPagesStack.arrangedSubviews.forEach {
            discoveredPagesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for page in discoveredPages {
            let igText = page.instagram.map { " + IG @\($0.username)" } ?? ""
            let lbl = NSTextField.styledLabel(
                "✓ \(page.pageName) (Sayfa \(page.pageId))\(igText)",
                font: Theme.smallFont,
                color: Theme.textPrimary
            )
            discoveredPagesStack.addArrangedSubview(lbl)
        }
    }

    private func checkToken() async {
        guard let account = existingAccount, !busy else { return }
        busy = true
        refreshButtons()
        defer { busy = false; refreshUI() }
        do {
            let checked = try await app.dataService.checkSocialAccountToken(id: account.id)
            await app.refreshAccounts()
            infoMessageLabel.stringValue = "Denetim tamamlandı: \(checked.tokenHealth?.label ?? checked.status.label)."
            infoMessageLabel.isHidden = false
        } catch {
            statusBanner.message = AppModel.describe(error)
            statusBanner.isHidden = false
        }
    }

    private func disableAccount() async {
        guard let account = existingAccount, !busy else { return }
        busy = true
        refreshButtons()
        defer { busy = false; refreshUI() }
        do {
            _ = try await app.dataService.updateSocialAccount(account.id, SocialAccountUpdate(status: .disabled))
            await app.refreshAccounts()
            infoMessageLabel.stringValue = "Hesap devre dışı bırakıldı."
            infoMessageLabel.isHidden = false
        } catch {
            statusBanner.message = AppModel.describe(error)
            statusBanner.isHidden = false
        }
    }

    private func closeSheet() {
        onDone()
        dismiss(nil)
    }
}
