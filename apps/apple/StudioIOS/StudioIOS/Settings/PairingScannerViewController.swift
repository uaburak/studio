@preconcurrency import AVFoundation
import StudioKit
import UIKit
import VisionKit

/// "iPhone'u bağla": read the QR code the Mac shows (Settings → Cihazlar, or its start
/// screen) and pair at once. Also opened with a `studio://pair` link (system Camera app),
/// then it pairs without the camera. "Kodu elle gir" is the fallback.
final class PairingScannerViewController: UIViewController {
    private unowned let app: IOSAppModel
    private var invite: PairingInvite?

    private let cameraArea = UIView()
    private let frameGuide = UIView()
    private let titleLabel = UILabel.studio("Mac'teki QR kodu okut", size: 22, weight: .bold, lines: 0, style: .title2)
    private let hintLabel = UILabel.studio(
        "Mac'te Studio → Ayarlar → Cihazlar'da görünür. Kod okununca iPhone hemen bağlanır.",
        size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let statusLabel = UILabel.studio("", size: 15, weight: .semibold, color: IOSTheme.textPrimary, lines: 0, style: .subheadline)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var retryButton: UIButton!
    private var manualButton: UIButton!
    private var settingsButton: UIButton!

    private var scanner: DataScannerViewController?
    private var capture: QRCaptureSession?
    /// A code is being paired (further reads are ignored).
    private var isBusy = false
    private var lastRejected: String?

    /// What the sheet says (tests).
    var statusText: String { statusLabel.isHidden ? "" : statusLabel.text ?? "" }

    init(app: IOSAppModel, invite: PairingInvite? = nil) {
        self.app = app
        self.invite = invite
        super.init(nibName: nil, bundle: nil)
        title = "iPhone'u bağla"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.close() })

        cameraArea.backgroundColor = .black
        cameraArea.layer.cornerRadius = 28
        cameraArea.layer.cornerCurve = .continuous
        cameraArea.clipsToBounds = true
        cameraArea.translatesAutoresizingMaskIntoConstraints = false
        cameraArea.isAccessibilityElement = true
        cameraArea.accessibilityLabel = "Kamera: Mac'teki QR kodu çerçeveye getir"
        frameGuide.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        frameGuide.layer.borderWidth = 3
        frameGuide.layer.cornerRadius = 24
        frameGuide.layer.cornerCurve = .continuous
        frameGuide.isUserInteractionEnabled = false
        frameGuide.translatesAutoresizingMaskIntoConstraints = false
        cameraArea.addSubview(frameGuide)

        statusLabel.isHidden = true
        spinner.hidesWhenStopped = true
        retryButton = UIButton.studioPill(title: "Tekrar okut", kind: .primary) { [weak self] in self?.restart() }
        retryButton.isHidden = true
        manualButton = UIButton.studioPill(title: "Kodu elle gir", kind: .secondary) { [weak self] in self?.openManualEntry() }
        settingsButton = UIButton.studioPill(title: "Ayarlar'ı aç", kind: .secondary) {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        settingsButton.isHidden = true

        let statusRow = UIStackView.h([spinner, statusLabel], spacing: 8, alignment: .center)
        let buttons = UIStackView.v([retryButton, settingsButton, manualButton], spacing: 10)
        let panel = UIStackView.v([titleLabel, hintLabel, statusRow, buttons], spacing: 12)
        panel.setCustomSpacing(18, after: statusRow)
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cameraArea)
        view.addSubview(panel)

        let guide = view.safeAreaLayoutGuide
        let square = cameraArea.heightAnchor.constraint(equalTo: cameraArea.widthAnchor)
        square.priority = .defaultHigh
        NSLayoutConstraint.activate([
            cameraArea.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            cameraArea.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
            cameraArea.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -20),
            square,
            frameGuide.centerXAnchor.constraint(equalTo: cameraArea.centerXAnchor),
            frameGuide.centerYAnchor.constraint(equalTo: cameraArea.centerYAnchor),
            frameGuide.widthAnchor.constraint(equalTo: cameraArea.widthAnchor, multiplier: 0.62),
            frameGuide.heightAnchor.constraint(equalTo: frameGuide.widthAnchor),
            panel.topAnchor.constraint(equalTo: cameraArea.bottomAnchor, constant: 20),
            panel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            panel.bottomAnchor.constraint(lessThanOrEqualTo: guide.bottomAnchor, constant: -16),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let invite {
            self.invite = nil
            Task { await pair(invite) }
        } else if scanner == nil, capture == nil, !isBusy, !AppDelegate.isUnderTest {
            startCamera()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopCamera()
    }

    // MARK: Camera

    private func startCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            beginScanning()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor [weak self] in
                    if granted { self?.beginScanning() } else { self?.showCameraDenied() }
                }
            }
        default:
            showCameraDenied()
        }
    }

    private func beginScanning() {
        guard view.window != nil else { return }
        if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
            let scanner = DataScannerViewController(
                recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
            scanner.delegate = self
            addChild(scanner)
            scanner.view.translatesAutoresizingMaskIntoConstraints = false
            cameraArea.insertSubview(scanner.view, at: 0)
            scanner.view.pin(to: cameraArea)
            scanner.didMove(toParent: self)
            do {
                try scanner.startScanning()
                self.scanner = scanner
                return
            } catch {
                scanner.willMove(toParent: nil)
                scanner.view.removeFromSuperview()
                scanner.removeFromParent()
            }
        }
        // Older devices: AVFoundation's QR reader.
        if let session = QRCaptureSession(onCode: { [weak self] text in self?.read(text) }) {
            let preview = session.makePreviewLayer()
            preview.frame = cameraArea.bounds
            cameraArea.layer.insertSublayer(preview, at: 0)
            session.start()
            capture = session
            return
        }
        show("Bu cihazda kamera kullanılamıyor. Mac'teki kodu elle girebilirsin.")
    }

    private func stopCamera() {
        scanner?.stopScanning()
        if let scanner {
            scanner.willMove(toParent: nil)
            scanner.view.removeFromSuperview()
            scanner.removeFromParent()
        }
        scanner = nil
        capture?.stop()
        cameraArea.layer.sublayers?.filter { $0 is AVCaptureVideoPreviewLayer }.forEach { $0.removeFromSuperlayer() }
        capture = nil
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        cameraArea.layer.sublayers?.filter { $0 is AVCaptureVideoPreviewLayer }.forEach { $0.frame = cameraArea.bounds }
    }

    private func showCameraDenied() {
        show("Kamera izni kapalı. Ayarlar'dan Studio için kamerayı aç ya da kodu elle gir.")
        settingsButton.isHidden = false
    }

    // MARK: Reading and pairing

    /// A scanned text (DataScanner or AVFoundation).
    func read(_ text: String) {
        guard !isBusy else { return }
        do {
            let invite = try PairingInvite.parse(text)
            Task { await pair(invite) }
        } catch {
            // Another QR code: say it once, keep scanning.
            guard lastRejected != text else { return }
            lastRejected = text
            show(error.errorDescription ?? "Bu kod okunamadı.")
        }
    }

    private func pair(_ invite: PairingInvite) async {
        guard !isBusy else { return }
        isBusy = true
        stopCamera()
        retryButton.isHidden = true
        settingsButton.isHidden = true
        show("\(invite.macName) için bağlanıyor…", busy: true)
        do {
            try await app.pair(with: invite)
            Haptics.success()
            let presenter = presentingViewController
            dismiss(animated: true) {
                Toast.show("Mac'e bağlandı", in: presenter?.view)
            }
        } catch {
            Haptics.error()
            isBusy = false
            show(error.errorDescription ?? "Bağlanılamadı.")
            retryButton.isHidden = false
        }
    }

    private func restart() {
        retryButton.isHidden = true
        lastRejected = nil
        show(nil)
        startCamera()
    }

    private func openManualEntry() {
        stopCamera()
        let sheet = PairingSheetViewController(app: app) { [weak self] in
            self?.dismiss(animated: true)
        }
        presentSheet(sheet, detents: [.large()])
    }

    private func close() {
        stopCamera()
        dismiss(animated: true)
    }

    private func show(_ message: String?, busy: Bool = false) {
        statusLabel.text = message
        statusLabel.isHidden = message == nil
        if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
        if let message { UIAccessibility.post(notification: .announcement, argument: message) }
    }
}

extension PairingScannerViewController: DataScannerViewControllerDelegate {
    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            if case .barcode(let barcode) = item, let text = barcode.payloadStringValue {
                read(text)
                return
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        if case .barcode(let barcode) = item, let text = barcode.payloadStringValue { read(text) }
    }
}

/// AVFoundation QR reader for devices without VisionKit's scanner. The session runs on its
/// own queue; codes arrive on the main actor.
final class QRCaptureSession: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "studio.qr-capture")
    private let onCode: @MainActor (String) -> Void

    init?(onCode: @escaping @MainActor (String) -> Void) {
        self.onCode = onCode
        super.init()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return nil }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return nil }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return nil }
        output.metadataObjectTypes = [.qr]
    }

    @MainActor
    func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }

    func start() {
        queue.async { [session] in session.startRunning() }
    }

    func stop() {
        queue.async { [session] in session.stopRunning() }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let text = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        MainActor.assumeIsolated { onCode(text) }
    }
}
