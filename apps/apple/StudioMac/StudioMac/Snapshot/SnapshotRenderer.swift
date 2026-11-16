import AppKit
import StudioKit
import SwiftUI

/// The approved screens, as scenes the renderer can reproduce with sample data.
enum SnapshotScene: String, CaseIterable, Sendable {
    case chatBothPanels = "01-sohbet-iki-panel"
    case chatLeftPanel = "02-sohbet-sol-panel"
    case chatOnly = "03-sohbet-yalniz"
    case start = "04-baslangic"
    case posts = "05-postlar"
    case postOpen = "06-post-acik"
    /// Not a draft: attachments with aliases, @mention pills and the autocomplete.
    case attachments = "07-ekler-ve-anma"
}

/// Renders scenes of the real SwiftUI views (sample data) into PNGs.
///
/// Each scene is laid out in a real window (titled, unified toolbar, the same
/// RootView the app uses) and captured with `cacheDisplay`. That path draws
/// the view hierarchy itself, so system materials and Liquid Glass come out
/// flattened compared to the screen; `scripts/capture-window.sh` captures the
/// live window with the window server instead.
@MainActor
enum SnapshotRenderer {
    static let size = CGSize(width: 1440, height: 900)

    struct Prepared {
        let window: NSWindow
        let model: AppModel
    }

    /// Build the window for a scene and wait until it has settled.
    static func prepare(_ scene: SnapshotScene, dark: Bool) async -> Prepared {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let defaults = UserDefaults(suiteName: "studio.snapshot.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
        let model = AppModel(settings: settings, conversationService: backend, dataService: backend)
        await model.load()
        model.currentBrandId = SampleData.mtm
        model.expandedBrands = [SampleData.mtm]
        model.posts.month = MonthKey(year: 2026, month: 11)

        switch scene {
        case .chatBothPanels:
            model.navigate(to: .conversation(SampleData.kasimConversation))
        case .chatLeftPanel:
            model.navigate(to: .conversation(SampleData.kasimConversation))
            model.inspectorPresented = false
        case .chatOnly:
            model.navigate(to: .conversation(SampleData.kasimConversation))
            model.inspectorPresented = false
            model.columnVisibility = .detailOnly
        case .start:
            model.inspectorPresented = false
            model.newChat.updatePlaceholder()
        case .posts, .postOpen:
            model.inspectorPresented = false
            model.navigate(to: .posts)
        case .attachments:
            model.navigate(to: .conversation(SampleData.hasatConversation))
        }
        await model.posts.load()

        let host = NSHostingController(rootView: RootView().environment(model).environment(settings))
        host.sceneBridgingOptions = [.toolbars, .title]
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.contentViewController = host
        window.toolbarStyle = .unified
        window.titlebarAppearsTransparent = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.setContentSize(size)
        window.setFrame(CGRect(origin: CGPoint(x: 40, y: 40), size: size), display: true)
        window.isReleasedWhenClosed = false
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        await settle(0.8)

        switch scene {
        case .postOpen:
            if let card = model.posts.card("post-01") {
                model.detail = PostDetailModel(app: model, card: card, sourceFrame: .zero)
            }
            await settle(0.9)
        case .attachments:
            let conversation = model.conversationModel(SampleData.hasatConversation)
            await settle(0.3)
            let composer = conversation.composer
            for (name, seed) in [("hasat-1.png", "tarla-2"), ("hasat-2.png", "depo-2")] {
                if let data = SampleImages.png(seed: seed), let image = try? ImageImport.from(data: data, filename: name) {
                    composer.add([image])
                }
            }
            await settle(0.3)
            let text = "Kapak için @image-2 kullan, @"
            composer.bridge?.setText(text)
            composer.bridge?.focus()
            await settle(0.6)
        default:
            break
        }
        window.setFrame(CGRect(origin: window.frame.origin, size: size), display: true)
        await settle(0.4)
        return Prepared(window: window, model: model)
    }

    /// The whole window (title bar, toolbar, content) at 1x: exactly 1440x900 px.
    static func capture(_ window: NSWindow) -> NSBitmapImageRep? {
        guard let frameView = window.contentView?.superview else { return nil }
        let bounds = frameView.bounds
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(bounds.width), pixelsHigh: Int(bounds.height),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        rep.size = bounds.size
        frameView.cacheDisplay(in: bounds, to: rep)
        return rep
    }

    static func render(_ scene: SnapshotScene, dark: Bool, to url: URL) async throws {
        let prepared = await prepare(scene, dark: dark)
        defer {
            prepared.model.stopFeeds()
            prepared.window.orderOut(nil)
            prepared.window.close()
        }
        guard let rep = capture(prepared.window), let png = rep.representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
    }

    static func settle(_ seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}

/// `--render-screenshots <dir>`: render every scene in both appearances and quit.
/// `--show-scene <scene> [--dark] --window-id-file <path>`: show one scene in a
/// window for an external capture (scripts/capture-window.sh), stay open.
enum SnapshotMode {
    static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static var isActive: Bool {
        arguments.contains("--render-screenshots") || arguments.contains("--show-scene")
    }

    static func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    @MainActor
    static func run() {
        // The regular main window is not needed in snapshot mode.
        for window in NSApp.windows { window.orderOut(nil) }
        Task { @MainActor in
            await SnapshotRenderer.settle(0.3)
            for window in NSApp.windows { window.orderOut(nil) }
            if let dir = value(after: "--render-screenshots") {
                let base = URL(fileURLWithPath: dir)
                for dark in [false, true] {
                    for scene in SnapshotScene.allCases {
                        let url = base.appending(path: dark ? "dark" : "light").appending(path: scene.rawValue + ".png")
                        do {
                            try await SnapshotRenderer.render(scene, dark: dark, to: url)
                            print("rendered \(url.path)"); fflush(stdout)
                        } catch {
                            print("failed \(scene.rawValue): \(error)")
                        }
                    }
                }
                NSApp.terminate(nil)
            } else if let name = value(after: "--show-scene"), let scene = SnapshotScene(rawValue: name) {
                let prepared = await SnapshotRenderer.prepare(scene, dark: arguments.contains("--dark"))
                held = prepared
                if arguments.contains("--focus-sidebar"), let table = findTable(in: prepared.window.contentView) {
                    prepared.window.makeFirstResponder(table)
                    await SnapshotRenderer.settle(0.4)
                }
                if let path = value(after: "--window-id-file") {
                    try? String(prepared.window.windowNumber).write(toFile: path, atomically: true, encoding: .utf8)
                }
            }
        }
    }

    @MainActor static var held: SnapshotRenderer.Prepared?

    @MainActor
    static func findTable(in view: NSView?) -> NSTableView? {
        guard let view else { return nil }
        if let table = view as? NSTableView { return table }
        for subview in view.subviews { if let found = findTable(in: subview) { return found } }
        return nil
    }
}
