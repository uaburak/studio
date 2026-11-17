import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import Observation
import StudioKit

/// "iPhone'u bağla" on the Mac: one pairing offer (QR code + 6-digit code) shared by
/// Settings → Cihazlar and the start screen, the list of paired iPhones and "Kaldır".
///
/// While a QR card is on screen (`showQR()` … `hideQR()`) the offer is kept fresh: a new one
/// replaces it shortly before its QR secret runs out, and the device list is checked every
/// few seconds so the card can say "bağlandı" as soon as the phone paired. Without a card,
/// the list is refreshed now and then for the start screen's "no iPhone yet" hint.
@MainActor
@Observable
final class PhonePairingModel {
    enum Phase: Equatable {
        /// The Mac's own server is not running (or sample data): nothing to pair with.
        case unavailable(String)
        /// Making a new offer.
        case preparing
        /// Showing the QR code and the code.
        case ready
        /// A phone just paired with the offer on screen.
        case paired(String)
        case failed(String)
    }

    /// The host this app runs (nil: sample data or an external server).
    weak var host: LocalHost?
    /// Overrides the API (tests).
    @ObservationIgnored var clientOverride: APIClient?
    /// Overrides the routes (tests).
    @ObservationIgnored var routesOverride: MacRoutes?
    @ObservationIgnored var now: () -> Date = { Date() }
    /// Off in tests: nothing runs by itself, `step()` is called by hand.
    @ObservationIgnored var autoRefresh = true

    private(set) var phase: Phase = .unavailable("")
    private(set) var offer: PairingCode?
    private(set) var invite: PairingInvite?
    private(set) var qrImage: NSImage?
    private(set) var devices: [PairedDevice] = []
    /// The device list was read at least once (the start screen waits for it).
    private(set) var hasLoadedDevices = false
    /// Result of the last remove, or an error, for one line under the list.
    private(set) var message: String?
    /// Bumped every second while a code is on screen (countdowns re-render).
    private(set) var tick = 0

    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var messageIsError = false
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var offerMadeAt: Date?

    init(host: LocalHost? = nil) {
        self.host = host
    }

    /// Paired iPhones (not removed).
    var activeDevices: [PairedDevice] { devices.filter { !$0.isRevoked } }

    /// The start screen offers "iPhone'u bağla" only when this is true.
    var needsFirstPhone: Bool { client != nil && hasLoadedDevices && activeDevices.isEmpty }

    var client: APIClient? {
        if let clientOverride { return clientOverride }
        guard let host, host.isUp, let url = host.apiURL else { return nil }
        return APIClient(baseURL: url)
    }

    /// Seconds left for the typed code (0 when it ran out).
    var codeSecondsLeft: Int {
        _ = tick
        guard let offer else { return 0 }
        return max(0, Int(offer.expiresAt.timeIntervalSince(now()).rounded(.up)))
    }

    /// "123 456".
    var formattedCode: String? {
        guard let code = offer?.code, code.count == 6 else { return offer?.code }
        return "\(code.prefix(3)) \(code.suffix(3))"
    }

    // MARK: Lifecycle

    /// A QR card appeared: make an offer if needed and watch for the phone.
    func showQR() {
        viewers += 1
        restartLoop()
    }

    func hideQR() {
        viewers = max(0, viewers - 1)
        restartLoop()
    }

    /// Keep the device list fresh (start screen hint) without showing a QR code.
    func startWatching() {
        if loop == nil { restartLoop() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    private func restartLoop() {
        loop?.cancel()
        guard autoRefresh else { return }
        loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.step()
                let interval: Duration = self.viewers > 0 ? .seconds(1) : .seconds(20)
                try? await Task.sleep(for: interval)
            }
        }
    }

    /// One round: refresh the list (every 3 s while showing), renew the offer when needed.
    func step() async {
        guard let api = client else {
            let reason: Phase = .unavailable(host == nil
                ? "iPhone bağlamak için Studio bu Mac'te çalışmalı."
                : "Studio hazırlanıyor; birazdan iPhone'u bağlayabilirsin.")
            if phase != reason { phase = reason }
            if offer != nil { offer = nil }
            if invite != nil { invite = nil }
            if qrImage != nil { qrImage = nil }
            return
        }
        tick += 1
        let showing = viewers > 0
        if !showing || tick % 3 == 1 || !hasLoadedDevices { await loadDevices(api) }
        guard showing else { return }
        if case .paired = phase { return }
        // After a failure, try again every ten seconds rather than every second.
        if case .failed = phase, tick % 10 != 0 { return }
        if needsNewOffer { await renewOffer(api) }
    }

    private var needsNewOffer: Bool {
        guard let invite else { return true }
        // A little before the QR secret runs out, so a phone never reads a dead code.
        return invite.expiresAt.timeIntervalSince(now()) < 20
    }

    /// Make a fresh offer now ("Yeni kod", or after a phone paired).
    func renewOffer() async {
        guard let api = client else { return }
        if case .paired = phase { phase = .ready }
        await renewOffer(api)
    }

    private func renewOffer(_ api: APIClient) async {
        if offer == nil { phase = .preparing }
        do {
            let created = try await api.createPairingCode()
            let routes = await currentRoutes(api)
            guard let routes, let invite = PairingInvite(offer: created, routes: routes) else {
                phase = .failed("Bağlantı kodu hazırlanamadı. Studio'yu yeniden başlatıp tekrar dene.")
                return
            }
            offer = created
            self.invite = invite
            offerMadeAt = now()
            qrImage = QRCode.image(for: invite.url.absoluteString)
            phase = .ready
        } catch {
            phase = .failed(error.errorDescription ?? "Bağlantı kodu hazırlanamadı.")
        }
    }

    private func currentRoutes(_ api: APIClient) async -> MacRoutes? {
        if let routesOverride { return routesOverride }
        if let routes = host?.routes {
            // Make sure the API has them too (the phone gets them with its token).
            _ = try? await api.publishMacRoutes(routes)
            return routes
        }
        // Another copy of Studio runs the server: use what it published.
        return try? await api.macRoutes()
    }

    func loadDevices() async {
        guard let api = client else { return }
        await loadDevices(api)
    }

    private func loadDevices(_ api: APIClient) async {
        do {
            let loaded = try await api.devices()
            if let madeAt = offerMadeAt, viewers > 0,
               let fresh = loaded.first(where: { !$0.isRevoked && $0.createdAt >= madeAt.addingTimeInterval(-2) && !devices.map(\.id).contains($0.id) }),
               hasLoadedDevices {
                // The phone used the code on screen: say so, and do not show a used code.
                phase = .paired(fresh.name)
                offer = nil
                invite = nil
                qrImage = nil
                offerMadeAt = nil
            }
            if devices != loaded { devices = loaded }
            if !hasLoadedDevices { hasLoadedDevices = true }
            if messageIsError {
                message = nil
                messageIsError = false
            }
        } catch {
            message = error.errorDescription
            messageIsError = true
        }
    }

    func remove(_ device: PairedDevice) async {
        guard let api = client else { return }
        do {
            try await api.revokeDevice(device.id)
            message = "\(device.name) kaldırıldı. Yeniden bağlamak için QR kodu okutması yeter."
            messageIsError = false
            await loadDevices(api)
        } catch {
            message = error.errorDescription
            messageIsError = true
        }
    }
}

/// QR code images (CoreImage), crisp at any size.
enum QRCode {
    /// A black-on-white QR code for `text`, scaled up without smoothing; nil when it does not fit.
    static func image(for text: String, scale: CGFloat = 8) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }

    /// Read a QR code back from an image (tests: the code really holds the link).
    static func decode(_ image: NSImage) -> String? {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let features = detector?.features(in: CIImage(cgImage: cgImage)) ?? []
        return features.compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }
}
