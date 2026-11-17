import StudioKit
import UIKit

/// "Kodu elle gir": the 6-digit code from the Mac, for when the QR code cannot be read.
/// The Mac is found on the same Wi-Fi by itself (Bonjour); an address field appears only
/// when opened from Gelişmiş with an address.
final class PairingSheetViewController: UIViewController, UITextFieldDelegate {
    private unowned let app: IOSAppModel
    private let fixedURL: URL?
    private let fixedName: String?
    /// Gelişmiş: the address is typed (or corrected) by hand instead of found with Bonjour.
    private let asksAddress: Bool
    private let onPaired: () -> Void

    private let macLabel = UILabel.studio("Aynı Wi-Fi'deki Mac aranıyor…", size: 15, weight: .semibold, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let urlField = UITextField()
    private let codeField = UITextField()
    private let statusLabel = UILabel.studio("", size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline)
    private var macPicker: UIButton!
    private var pairButton: UIButton!
    private var isPairing = false
    private var found: [DiscoveredStudio] = []
    private var chosen: DiscoveredStudio?
    private var browseTask: Task<Void, Never>?

    /// Shown in tests: the line about which Mac the code goes to.
    var macLine: String { macLabel.text ?? "" }

    init(app: IOSAppModel, baseURL: URL? = nil, serverName: String? = nil, asksAddress: Bool? = nil, onPaired: @escaping () -> Void) {
        self.app = app
        // No localhost fallback: on a phone 127.0.0.1 is the phone itself.
        self.fixedURL = baseURL
        self.fixedName = serverName
        self.asksAddress = asksAddress ?? (baseURL != nil)
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
        title = "Kodu elle gir"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit { browseTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })

        urlField.text = fixedURL?.absoluteString
        urlField.placeholder = "http://192.168.1.10:8791"
        urlField.keyboardType = .URL
        urlField.autocapitalizationType = .none
        urlField.autocorrectionType = .no
        urlField.textContentType = .URL
        style(urlField)
        urlField.isHidden = !asksAddress

        codeField.placeholder = "000000"
        codeField.keyboardType = .numberPad
        codeField.textContentType = .oneTimeCode
        codeField.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .monospacedDigitSystemFont(ofSize: 30, weight: .bold))
        codeField.textAlignment = .center
        codeField.backgroundColor = IOSTheme.elevated
        codeField.layer.cornerRadius = 16
        codeField.layer.cornerCurve = .continuous
        codeField.delegate = self
        codeField.accessibilityLabel = "Mac'teki 6 haneli kod"
        codeField.translatesAutoresizingMaskIntoConstraints = false
        codeField.heightAnchor.constraint(equalToConstant: 64).isActive = true
        codeField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let digits = (self.codeField.text ?? "").filter(\.isNumber)
            if digits.count == 6, !self.isPairing { Task { await self.performPair() } }
        }, for: .editingChanged)

        macPicker = UIButton(configuration: .plain())
        macPicker.showsMenuAsPrimaryAction = true
        macPicker.isHidden = true

        statusLabel.isHidden = true
        pairButton = UIButton.studioPill(title: "Bağlan", kind: .primary) { [weak self] in
            guard let self else { return }
            Task { await self.performPair() }
        }

        let intro = UILabel.studio("Mac'te Studio → Ayarlar → Cihazlar'daki 6 haneli kodu gir. iPhone ile Mac aynı Wi-Fi'de olmalı.", size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
        if asksAddress {
            macLabel.text = fixedName ?? "Mac"
            macLabel.textColor = IOSTheme.textPrimary
        }
        let stack = UIStackView.v([intro, macLabel, macPicker, urlField, codeField, statusLabel, pairButton], spacing: 12)
        stack.setCustomSpacing(18, after: intro)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        scroll.pin(to: view)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
        ])
        if !asksAddress, !app.isSample, !AppDelegate.isUnderTest { browse() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        codeField.becomeFirstResponder()
    }

    /// Macs running Studio on this Wi-Fi; the first one is picked, a menu offers the others.
    private func browse() {
        let browser = StudioBrowser()
        browseTask = Task { @MainActor [weak self] in
            for await list in browser.results() {
                guard let self, !Task.isCancelled else { return }
                self.found = list.filter(\.isSupported)
                if let chosen = self.chosen, !self.found.contains(chosen) { self.chosen = nil }
                if self.chosen == nil { self.chosen = self.found.first }
                self.renderMacs()
            }
        }
    }

    private func renderMacs() {
        if let chosen {
            macLabel.text = "Bağlanılacak Mac: \(chosen.displayName)"
            macLabel.textColor = IOSTheme.textPrimary
        } else {
            macLabel.text = "Aynı Wi-Fi'deki Mac aranıyor… Mac'te Studio açık olmalı."
            macLabel.textColor = IOSTheme.textSecondary
        }
        macPicker.isHidden = found.count < 2
        var config = UIButton.Configuration.plain()
        config.title = "Başka bir Mac seç"
        macPicker.configuration = config
        macPicker.menu = UIMenu(children: found.map { studio in
            UIAction(title: studio.displayName, state: studio == chosen ? .on : .off) { [weak self] _ in
                self?.chosen = studio
                self?.renderMacs()
            }
        })
    }

    private func style(_ field: UITextField) {
        field.font = IOSTheme.font(16)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = IOSTheme.textPrimary
        field.backgroundColor = IOSTheme.elevated
        field.layer.cornerRadius = 14
        field.layer.cornerCurve = .continuous
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.clearButtonMode = .whileEditing
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        guard textField === codeField else { return true }
        let current = (textField.text ?? "") as NSString
        let next = current.replacingCharacters(in: range, with: string).filter(\.isNumber)
        return next.count <= 6
    }

    /// Where the code goes: the typed address (Gelişmiş), else the Mac found on this Wi-Fi.
    private func target() async throws(StudioAPIError) -> (URL, String) {
        if asksAddress {
            guard let text = urlField.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                  let url = URL(string: text.contains("://") ? text : "http://\(text)"),
                  url.scheme == "http" || url.scheme == "https", url.host != nil else {
                throw .invalidConfiguration("Geçerli bir adres gir.")
            }
            return (url, fixedName ?? "Mac")
        }
        guard let chosen else {
            throw .invalidConfiguration("Mac bulunamadı. iPhone ile Mac aynı Wi-Fi'de olmalı ve Mac'te Studio açık olmalı.")
        }
        return (try await StudioBrowser.resolve(chosen), chosen.displayName)
    }

    private func performPair() async {
        guard !isPairing else { return }
        let code = (codeField.text ?? "").filter(\.isNumber)
        guard code.count == 6 else {
            show("Kod 6 haneli olmalı.")
            return
        }
        isPairing = true
        pairButton.setPill(title: "Bağlanıyor", kind: .primary, busy: true)
        statusLabel.isHidden = true
        defer {
            isPairing = false
            pairButton.setPill(title: "Bağlan", kind: .primary)
        }
        do {
            let (url, name) = try await target()
            _ = try await app.settings.pairingClient.pair(baseURL: url, serverName: name, code: code, deviceName: UIDevice.current.name)
            app.settings.credentialChanged()
            app.reconnect()
            Haptics.success()
            let done = onPaired
            dismiss(animated: true) { done() }
        } catch {
            Haptics.error()
            show(error.errorDescription ?? "Bağlanılamadı.")
            codeField.text = ""
        }
    }

    private func show(_ message: String) {
        statusLabel.text = message
        statusLabel.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}
