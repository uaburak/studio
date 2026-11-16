import StudioKit
import UIKit

/// 6-digit pairing with a Mac running Studio (`PairingClient.pair`).
final class PairingSheetViewController: UIViewController, UITextFieldDelegate {
    private unowned let app: IOSAppModel
    private let baseURL: URL?
    private let serverName: String
    private let onPaired: () -> Void

    private let urlField = UITextField()
    private let codeField = UITextField()
    private let deviceNameField = UITextField()
    private let statusLabel = UILabel.studio("", size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline)
    private var pairButton: UIButton!
    private var isPairing = false

    init(app: IOSAppModel, baseURL: URL?, serverName: String, onPaired: @escaping () -> Void) {
        self.app = app
        // No localhost fallback: on a phone 127.0.0.1 is the phone itself.
        self.baseURL = baseURL
        self.serverName = serverName
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
        title = "Mac ile eşleştir"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })

        urlField.text = baseURL?.absoluteString
        urlField.placeholder = "http://192.168.1.10:8791"
        urlField.keyboardType = .URL
        urlField.autocapitalizationType = .none
        urlField.autocorrectionType = .no
        urlField.textContentType = .URL
        style(urlField)

        codeField.placeholder = "000000"
        codeField.keyboardType = .numberPad
        codeField.textContentType = .oneTimeCode
        codeField.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .monospacedDigitSystemFont(ofSize: 30, weight: .bold))
        codeField.textAlignment = .center
        codeField.backgroundColor = IOSTheme.elevated
        codeField.layer.cornerRadius = 16
        codeField.layer.cornerCurve = .continuous
        codeField.delegate = self
        codeField.accessibilityLabel = "Eşleştirme kodu"
        codeField.translatesAutoresizingMaskIntoConstraints = false
        codeField.heightAnchor.constraint(equalToConstant: 64).isActive = true
        codeField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let digits = (self.codeField.text ?? "").filter(\.isNumber)
            if digits.count == 6, !self.isPairing { Task { await self.performPair() } }
        }, for: .editingChanged)

        deviceNameField.text = UIDevice.current.name
        deviceNameField.placeholder = "iPhone"
        style(deviceNameField)

        statusLabel.isHidden = true
        pairButton = UIButton.studioPill(title: "Eşleştir ve bağlan", kind: .primary) { [weak self] in
            guard let self else { return }
            Task { await self.performPair() }
        }

        let intro = UILabel.studio("Mac'te Studio → Ayarlar → Cihazlar → Telefon ekle. Çıkan 6 haneli kodu gir (2 dakika geçerli).", size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
        let stack = UIStackView.v([
            UILabel.studio(serverName, size: 22, weight: .bold, lines: 2, style: .title2),
            intro,
            label("Eşleştirme kodu"), codeField,
            label("Mac adresi"), urlField,
            label("Bu telefonun adı"), deviceNameField,
            statusLabel, pairButton,
        ], spacing: 10)
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
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        codeField.becomeFirstResponder()
    }

    private func label(_ text: String) -> UILabel {
        UILabel.studio(text, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote)
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

    private func performPair() async {
        guard !isPairing else { return }
        guard let urlText = urlField.text?.trimmingCharacters(in: .whitespacesAndNewlines), !urlText.isEmpty,
              let url = URL(string: urlText.contains("://") ? urlText : "http://\(urlText)"),
              url.scheme == "http" || url.scheme == "https", url.host != nil else {
            show("Mac adresini gir (Mac → Ayarlar → Mac sunucusu'nda yazar).")
            return
        }
        let code = (codeField.text ?? "").filter(\.isNumber)
        guard code.count == 6 else {
            show("Kod 6 haneli olmalı.")
            return
        }
        isPairing = true
        pairButton.setPill(title: "Eşleştiriliyor", kind: .primary, busy: true)
        statusLabel.isHidden = true
        defer {
            isPairing = false
            pairButton.setPill(title: "Eşleştir ve bağlan", kind: .primary)
        }
        do {
            _ = try await app.settings.pairingClient.pair(
                baseURL: url, serverName: serverName, code: code,
                deviceName: (deviceNameField.text?.isEmpty == false ? deviceNameField.text : nil) ?? "iPhone")
            app.settings.credentialChanged()
            app.settings.useRemoteControlURL = false
            app.reconnect()
            Haptics.success()
            onPaired()
            dismiss(animated: true)
        } catch {
            Haptics.error()
            show(error.errorDescription ?? error.localizedDescription)
            codeField.text = ""
        }
    }

    private func show(_ message: String) {
        statusLabel.text = message
        statusLabel.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}
