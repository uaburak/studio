import StudioKit
import UIKit

/// 6-digit pairing sheet for connecting iPhone to a Mac running Studio (`PairingClient.pair`).
final class PairingSheetViewController: UIViewController {
    private unowned let app: IOSAppModel
    private let baseURL: URL?
    private let serverName: String
    private let onPaired: () -> Void

    private let urlField = UITextField()
    private let codeField = UITextField()
    private let deviceNameField = UITextField()
    private let statusLabel = UILabel.studio("", size: 13, color: .systemRed, lines: 0)
    private var pairButton: UIButton!
    private var isPairing = false

    init(app: IOSAppModel, baseURL: URL?, serverName: String, onPaired: @escaping () -> Void) {
        self.app = app
        // No localhost fallback: on a phone 127.0.0.1 is the phone itself.
        self.baseURL = baseURL
        self.serverName = serverName
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
        title = "Mac ile Eşleştir"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "Vazgeç",
            primaryAction: UIAction { [weak self] _ in
                self?.dismiss(animated: true)
            }
        )

        urlField.text = baseURL?.absoluteString
        urlField.placeholder = "http://192.168.1.x:8791 (Mac → Ayarlar → Mac sunucusu)"
        urlField.placeholder = "http://192.168.1.10:8791"
        urlField.keyboardType = .URL
        urlField.autocapitalizationType = .none
        urlField.autocorrectionType = .no
        styleField(urlField)

        codeField.placeholder = "123 456"
        codeField.keyboardType = .numberPad
        codeField.font = UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
        codeField.textAlignment = .center
        codeField.backgroundColor = IOSTheme.fill
        codeField.layer.cornerRadius = 14
        codeField.translatesAutoresizingMaskIntoConstraints = false
        codeField.heightAnchor.constraint(equalToConstant: 56).isActive = true

        deviceNameField.text = UIDevice.current.name
        deviceNameField.placeholder = "Burak'ın iPhone'u"
        styleField(deviceNameField)

        statusLabel.isHidden = true

        pairButton = UIButton.studioPill(title: "Eşleştir ve Bağlan", primary: true) { [weak self] in
            guard let self else { return }
            Task { await self.performPair() }
        }

        let stack = UIStackView(arrangedSubviews: [
            UILabel.studio("Mac'te Ayarlar → Cihazlar → Telefon ekle ekranındaki 6 haneli tek kullanımlık kodu gir.", size: 14, color: IOSTheme.textSecondary, lines: 0),
            UILabel.studio("Mac Adresi", size: 12, weight: .semibold, color: IOSTheme.textSecondary),
            urlField,
            UILabel.studio("6 Haneli Eşleştirme Kodu", size: 12, weight: .semibold, color: IOSTheme.textSecondary),
            codeField,
            UILabel.studio("Bu Telefonun Adı", size: 12, weight: .semibold, color: IOSTheme.textSecondary),
            deviceNameField,
            statusLabel,
            pairButton,
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        codeField.becomeFirstResponder()
    }

    private func styleField(_ field: UITextField) {
        field.font = UIFont.systemFont(ofSize: 15)
        field.textColor = IOSTheme.textPrimary
        field.backgroundColor = IOSTheme.fill
        field.layer.cornerRadius = 12
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        field.leftViewMode = .always
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: 42).isActive = true
    }

    private func performPair() async {
        guard !isPairing else { return }
        guard let urlText = urlField.text?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: urlText),
              url.scheme == "http" || url.scheme == "https" else {
            statusLabel.text = "Geçerli bir http:// ya da https:// adresi girin."
            statusLabel.isHidden = false
            return
        }
        isPairing = true
        pairButton.isEnabled = false
        statusLabel.isHidden = true
        defer {
            isPairing = false
            pairButton.isEnabled = true
        }
        do {
            _ = try await app.settings.pairingClient.pair(
                baseURL: url,
                serverName: serverName,
                code: codeField.text ?? "",
                deviceName: deviceNameField.text ?? "iPhone"
            )
            app.settings.useRemoteControlURL = false
            app.reconnect()
            onPaired()
            dismiss(animated: true)
        } catch {
            statusLabel.text = error.errorDescription ?? error.localizedDescription
            statusLabel.isHidden = false
        }
    }
}
