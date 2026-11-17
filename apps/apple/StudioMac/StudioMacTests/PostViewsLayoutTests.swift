import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// Builds the posts grid and the opened post offscreen (no window is created or shown):
/// catches broken constraints and wrong geometry without looking at the screen.
@Suite("Posts views lay out offscreen")
@MainActor
struct PostViewsLayoutTests {
    private func makeApp() async -> AppModel {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let defaults = UserDefaults(suiteName: "studio.views.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
        let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
        await app.load()
        app.posts.month = MonthKey(year: 2026, month: 11)
        await app.posts.load()
        return app
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + all(type, in: $0) }
    }

    private func settle() async {
        for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(15)) }
    }

    @Test func gridBuildsCardsFiltersAndStatesAtSeveralWidths() async throws {
        let app = await makeApp()
        let controller = PostsViewController(app: app)
        let view = controller.view
        for width in [1280.0, 900.0, 640.0] {
            view.frame = CGRect(x: 0, y: 0, width: width, height: 820)
            view.layoutSubtreeIfNeeded()
            await settle()
            view.layoutSubtreeIfNeeded()
        }
        let placeholders = all(PostPlaceholderView.self, in: view)
        #expect(placeholders.count == 12)
        for card in placeholders {
            #expect(card.frame.width >= 150)
            #expect(abs(card.frame.height / card.frame.width - 1.25) < 0.02)
        }
        let labels = all(NSTextField.self, in: view).map(\.stringValue)
        #expect(labels.contains("Kasım"))
        #expect(labels.contains("Zamanlandı"))
        #expect(labels.contains("Yayınlandı"))

        // Empty month state with its actions.
        app.posts.showNextMonth()
        await settle()
        view.layoutSubtreeIfNeeded()
        #expect(all(NSTextField.self, in: view).contains { $0.stringValue == "Bu ayda post yok." && !$0.isHiddenOrHasHiddenAncestor })
        #expect(all(PillButton.self, in: view).contains { $0.title == "Önceki postlar" && !$0.isHiddenOrHasHiddenAncestor })
    }

    private func views(in view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + views(in: $0) }
    }

    @Test func postsAndTheOpenedPostSpeakToVoiceOver() async throws {
        let app = await makeApp()
        let controller = PostsViewController(app: app)
        let view = controller.view
        view.frame = CGRect(x: 0, y: 0, width: 1280, height: 820)
        view.layoutSubtreeIfNeeded()
        await settle()
        view.layoutSubtreeIfNeeded()
        let elements = views(in: view).filter { $0.isAccessibilityElement() }

        // The grid is a named group; each card is one button that opens its post.
        let grid = try #require(elements.first { $0.accessibilityRole() == .group && $0.accessibilityLabel() == "Postlar" })
        #expect(grid.accessibilityValue() as? String == "12 post")
        let card = try #require(app.posts.card("post-01"))
        let label = PostAccessibility.cardLabel(card)
        #expect(label.hasPrefix("\(card.title), "))
        #expect(label.contains(card.state.label))
        let cardView = try #require(elements.first { $0.accessibilityLabel() == label })
        #expect(cardView.accessibilityRole() == .button)
        let actions = (cardView.accessibilityCustomActions() ?? []).map(\.name)
        #expect(actions.contains("Çoğalt") && actions.contains("Açıklamayı kopyala"))
        #expect(cardView.accessibilityPerformPress())
        #expect(app.detail?.card.id == "post-01")
        app.detail = nil

        // Status chips read as one text; the filters are a radio group that presses like a click.
        let chips = all(PostStateLabelView.self, in: view)
        #expect(!chips.isEmpty && chips.allSatisfy { $0.isAccessibilityElement() && $0.accessibilityLabel()?.hasPrefix("Durum: ") == true })
        #expect(elements.contains { $0.accessibilityRole() == .radioGroup && $0.accessibilityLabel() == "Durum filtresi" })
        let readyFilter = try #require(elements.first { $0.accessibilityRole() == .radioButton && $0.accessibilityLabel()?.hasPrefix("\(PostListFilter.ready.label), ") == true })
        #expect(readyFilter.accessibilityPerformPress())
        #expect(app.posts.filter == .ready)
        app.posts.filter = .all

        // The opened post: a named group, section pills and version rows as buttons.
        let model = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        app.detail = model
        let overlay = PostDetailOverlayView(model: model)
        overlay.frame = CGRect(x: 0, y: 0, width: 1280, height: 820)
        overlay.layoutSubtreeIfNeeded()
        await settle()
        #expect(overlay.isAccessibilityElement() && overlay.accessibilityLabel() == "Açık post: \(card.title)")
        let pills = views(in: overlay).filter { $0.isAccessibilityElement() && $0.accessibilityRole() == .radioButton }
        #expect(pills.compactMap { $0.accessibilityLabel() } == PostDetailModel.Tab.allCases.map(\.label))
        #expect(pills.last?.accessibilityPerformPress() == true)
        #expect(model.tab == .versions)
        await settle()
        overlay.layoutSubtreeIfNeeded()
        let version = try #require(views(in: overlay).first { $0.isAccessibilityElement() && $0.accessibilityLabel()?.hasPrefix("Sürüm 1, ") == true })
        #expect(version.accessibilityRole() == .button)
        #expect(version.accessibilityValue() as? String == "Gösteriliyor")
        app.detail = nil
    }

    @Test func openedPostLaysOutCanvasPanelAndKeys() async throws {
        let app = await makeApp()
        let card = try #require(app.posts.card("post-01"))
        let model = PostDetailModel(app: app, card: card, sourceFrame: .zero)
        app.detail = model
        let overlay = PostDetailOverlayView(model: model)
        overlay.frame = CGRect(x: 0, y: 0, width: 1280, height: 820)
        overlay.layoutSubtreeIfNeeded()
        for _ in 0..<40 where model.layerBoxes == nil || model.activity != .idle { try? await Task.sleep(for: .milliseconds(15)) }
        overlay.layoutSubtreeIfNeeded()

        let canvas = try #require(all(SlideCanvasView.self, in: overlay).first)
        #expect(canvas.frame.width > 400)
        #expect(abs(canvas.frame.width / canvas.frame.height - 0.8) < 0.02)
        let panel = try #require(all(DetailPanelView.self, in: overlay).first)
        #expect(panel.frame.width >= 300)
        #expect(panel.frame.minX >= canvas.frame.maxX - 1)

        // Clicks always land on the canvas (not on the image underneath).
        let center = canvas.convert(CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY), to: canvas.superview)
        #expect(canvas.hitTest(center) === canvas)

        // Post tab shows the caption and the facts; the edit tab lists the layers.
        let labels = all(NSTextField.self, in: panel).map(\.stringValue)
        #expect(labels.contains("Tarih") && labels.contains("Platform") && labels.contains("Tür"))
        model.select(layer: "photo")
        #expect(model.tab == .edit)
        await settle()
        panel.layoutSubtreeIfNeeded()
        let buttons = all(PillButton.self, in: panel).filter { !$0.isHiddenOrHasHiddenAncestor }.map(\.title)
        #expect(buttons.contains("Görsel ekle…"))
        #expect(buttons.contains("AI ile doldur…"))
        model.tab = .versions
        await settle()
        #expect(all(NSTextField.self, in: panel).contains { $0.stringValue == "v1" && !$0.isHiddenOrHasHiddenAncestor })

        // Esc first clears the layer selection; ⌫ with a layer selected hides it (an edit).
        let esc = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
        #expect(overlay.handleKey(esc))
        #expect(model.selectedLayerId == nil)
        model.select(layer: "title")
        let delete = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51))
        #expect(overlay.handleKey(delete))
        for _ in 0..<60 where model.content.currentVersion?.version != 2 || model.activity != .idle { try? await Task.sleep(for: .milliseconds(15)) }
        #expect(model.layers.first { $0.layerId == "title" }?.isHidden == true)
        #expect(overlay.validateUserInterfaceItem(NSMenuItem(title: "Geri Al", action: #selector(PostDetailOverlayView.undo(_:)), keyEquivalent: "z")))

        // Caption editing with counters, in a smaller window.
        model.tab = .post
        model.isEditingCaption = true
        overlay.frame = CGRect(x: 0, y: 0, width: 1000, height: 660)
        await settle()
        overlay.layoutSubtreeIfNeeded()
        let counters = all(NSTextField.self, in: panel).map(\.stringValue).filter { $0.hasPrefix("Instagram ") || $0.hasPrefix("Facebook ") }
        #expect(counters.count == 2)
        #expect(all(SlideCanvasView.self, in: overlay).first.map { abs($0.frame.width / $0.frame.height - 0.8) < 0.02 } == true)
        app.detail = nil
    }
}
