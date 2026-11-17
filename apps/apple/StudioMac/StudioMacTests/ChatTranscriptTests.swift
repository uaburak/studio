import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// The conversation like Claude Code's transcript: Markdown, live states, images, the
/// lightbox and incremental updates. Window-free except the lightbox (an offscreen window
/// that is never shown).
@MainActor
private func makeApp() async -> AppModel {
    let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
    let defaults = UserDefaults(suiteName: "studio.tests.chat.\(UUID().uuidString)")!
    let settings = AppSettings(defaults: defaults, credentials: InMemoryCredentialStore(), useSampleData: true)
    let app = AppModel(settings: settings, conversationService: backend, dataService: backend)
    await app.load()
    return app
}

@MainActor
private func waitUntil(_ condition: () -> Bool, timeout: Double = 3) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
}

@MainActor
private func descendants<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
    view.subviews.flatMap { (($0 as? T).map { [$0] } ?? []) + descendants(type, in: $0) }
}

/// Models hold their app unowned: keep every test app alive for the run.
@MainActor private var retainedApps: [AppModel] = []

/// A seeded (not streaming) conversation model and its chat screen, laid out offscreen.
@MainActor
private func makeChat(_ conversation: EntityID, edit: (inout ConversationState) -> Void = { _ in }) async throws -> (AppModel, ConversationModel, ChatViewController) {
    let app = await makeApp()
    retainedApps.append(app)
    let live = app.conversationModel(conversation)
    await waitUntil { live.state != nil }
    var state = try #require(live.state)
    live.stop()
    edit(&state)
    let model = ConversationModel(id: conversation, app: app, state: state)
    let controller = ChatViewController(model: model)
    controller.view.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
    controller.syncNow()
    controller.view.layoutSubtreeIfNeeded()
    return (app, model, controller)
}

private func assistant(_ id: String, _ conversation: EntityID, _ parts: [MessagePart], status: MessageStatus = .complete, run: EntityID? = nil) -> Message {
    Message(id: id, conversationId: conversation, role: .assistant, status: status, runId: run, parts: parts, createdAt: .now, updatedAt: .now)
}

private func step(_ id: String, _ name: String, _ label: String, _ state: ToolStepState = .done, summary: String? = nil) -> ToolStepPart {
    ToolStepPart(id: id, name: name, label: label, state: state, summary: summary)
}

// MARK: - Markdown parsing

@Suite("Chat Markdown parsing")
struct MarkdownParsingTests {
    @Test func headingsAndRunInBoldHeadings() {
        let blocks = Markdown.parse("# Başlık\n## Alt başlık\n**Plan:**\n#hasat #tarım etiketleri")
        #expect(blocks == [
            .heading(level: 1, [.text("Başlık")]),
            .heading(level: 2, [.text("Alt başlık")]),
            .boldHeading([.strong([.text("Plan:")])]),
            // A hashtag line is a paragraph, not a heading.
            .paragraph([.text("#hasat #tarım etiketleri")]),
        ])
        // A bold-only line splits its paragraph; bold followed by more text is a normal paragraph.
        #expect(Markdown.parse("giriş\n**Plan:**\ndevam") == [
            .paragraph([.text("giriş")]), .boldHeading([.strong([.text("Plan:")])]), .paragraph([.text("devam")]),
        ])
        #expect(Markdown.parse("**Takvim:** ay görünümü") == [.paragraph([.strong([.text("Takvim:")]), .text(" ay görünümü")])])
    }

    @Test func inlineSpans() {
        let inlines = Markdown.parseInlines("**kalın** ve *italik*, `kod`, ~~eski~~, [site](https://burakkoc.net) ve https://example.com/a.")
        #expect(inlines == [
            .strong([.text("kalın")]), .text(" ve "), .emphasis([.text("italik")]), .text(", "),
            .code("kod"), .text(", "), .strikethrough([.text("eski")]), .text(", "),
            .link([.text("site")], url: "https://burakkoc.net"), .text(" ve "),
            .link([.text("https://example.com/a")], url: "https://example.com/a"), .text("."),
        ])
        // snake_case and lone stars stay text; a code span keeps its stars.
        #expect(Markdown.parseInlines("dosya_adi_v2 ve 2 * 3") == [.text("dosya_adi_v2 ve 2 * 3")])
        #expect(Markdown.parseInlines("`a**b**`") == [.code("a**b**")])
        // Unclosed while streaming: plain text.
        #expect(Markdown.parseInlines("**yarım") == [.text("**yarım")])
        #expect(Markdown.parseInlines("***ikisi***") == [.strong([.emphasis([.text("ikisi")])])])
        #expect(Markdown.parseInlines("bir\niki") == [.text("bir"), .lineBreak, .text("iki")])
    }

    @Test func nestedListsWithHangingContinuation() {
        let source = """
        1. **Üstteki ikonlar:** sağ panel
           - **Takvim:** ay görünümü
             devamı
           - Medya
        1. Ayarlar
        - madde
        """
        guard case .list(let items) = Markdown.parse(source).first else {
            Issue.record("expected a list")
            return
        }
        #expect(items.map(\.depth) == [0, 1, 1, 0, 0])
        // Agents often write `1.` for every item: numbers count up per level.
        #expect(items.map(\.ordinal) == [1, nil, nil, 2, nil])
        #expect(Markdown.plainText(items[1].content) == "Takvim: ay görünümü\ndevamı")
        #expect(items[0].content.first == .strong([.text("Üstteki ikonlar:")]))
    }

    @Test func fencedCodeAlsoWhileStreaming() {
        #expect(Markdown.parse("Önce:\n```swift\nlet a = 1\n  let b = 2\n```\nSonra") == [
            .paragraph([.text("Önce:")]),
            .code(language: "swift", code: "let a = 1\n  let b = 2"),
            .paragraph([.text("Sonra")]),
        ])
        // The closing fence has not arrived yet: everything after the fence is code.
        #expect(Markdown.parse("```\nyarım kod") == [.code(language: nil, code: "yarım kod")])
    }

    @Test func tablesWithAlignment() {
        let blocks = Markdown.parse("| Gün | Post | Durum |\n|:--|:-:|--:|\n| 4 Kas | `Hasat` | hazır |\n| 5 Kas | a \\| b |")
        guard case .table(let table) = blocks.first else {
            Issue.record("expected a table")
            return
        }
        #expect(table.alignments == [.leading, .center, .trailing])
        #expect(table.header.map(Markdown.plainText) == ["Gün", "Post", "Durum"])
        #expect(table.rows.count == 2)
        #expect(table.rows[0][1] == [.code("Hasat")])
        // Short rows are padded; an escaped pipe stays in its cell.
        #expect(table.rows[1].map(Markdown.plainText) == ["5 Kas", "a | b", ""])
    }

    @Test func quotesAndRules() {
        #expect(Markdown.parse("> alıntı\n> devam *iki*\n\n---\n\nson") == [
            .quote([.paragraph([.text("alıntı"), .lineBreak, .text("devam "), .emphasis([.text("iki")])])]),
            .rule,
            .paragraph([.text("son")]),
        ])
    }

    @Test func segmentsSplitCodeAndTablesFromFlowingText() {
        let blocks = Markdown.parse("Metin\n- a\n```\nx\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\nSon")
        #expect(MarkdownSegment.segments(blocks).map(\.kind) == ["text", "code", "table", "rule", "text"])
    }
}

// MARK: - Markdown rendering

@Suite("Chat Markdown rendering")
@MainActor
struct MarkdownRenderingTests {
    private func render(_ source: String, context: MarkdownContext = MarkdownContext()) -> NSAttributedString {
        MarkdownAttributedBuilder(context: context).build(Markdown.parse(source))
    }

    private func font(_ string: NSAttributedString, at text: String) -> NSFont? {
        let range = (string.string as NSString).range(of: text)
        return string.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont
    }

    private func style(_ string: NSAttributedString, at text: String) -> NSParagraphStyle? {
        let range = (string.string as NSString).range(of: text)
        return string.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
    }

    @Test func headingsAndBodyType() {
        let text = render("# Büyük\n## Orta\n**Koyu:**\nGövde metni")
        #expect(font(text, at: "Büyük")?.pointSize == 17)
        #expect(font(text, at: "Orta")?.pointSize == 15)
        #expect(font(text, at: "Gövde")?.pointSize == ChatStyle.bodySize)
        let bold = font(text, at: "Koyu")
        #expect(bold.map { NSFontManager.shared.weight(of: $0) >= 8 } == true)
        // The run-in heading gets room above; the first block none.
        #expect(style(text, at: "Büyük")?.paragraphSpacingBefore == 0)
        #expect(style(text, at: "Koyu")?.paragraphSpacingBefore == MarkdownAttributedBuilder.Spacing.boldHeading)
        #expect((style(text, at: "Gövde")?.lineSpacing ?? 0) > 0)
    }

    @Test func listsHangTheirTextPerLevel() {
        let text = render("- bir\n  - iki\n1. üç")
        #expect(style(text, at: "bir")?.headIndent == ChatStyle.listTextInset)
        #expect(style(text, at: "iki")?.headIndent == ChatStyle.listTextInset + ChatStyle.listLevelIndent)
        #expect(text.string.contains("•\tbir"))
        #expect(text.string.contains("◦\tiki"))
        #expect(text.string.contains("1.\tüç"))
        // The number is right-aligned before the text column.
        #expect(style(text, at: "üç")?.tabStops.first?.alignment == .right)
    }

    @Test func inlineCodeLinksQuotesAndMentions() {
        let aliases = [MentionText.Target(id: "alias-1", alias: "image", assetId: "asset-1")]
        let text = render("`kod` [site](https://burakkoc.net) @image\n> alıntı", context: MarkdownContext(mentionTargets: aliases, aliasNames: ["alias-1": "kapak"]))
        let ns = text.string as NSString
        #expect(text.attribute(.studioInlineCode, at: ns.range(of: "kod").location, effectiveRange: nil) as? Bool == true)
        #expect(font(text, at: "kod")?.isFixedPitch == true)
        #expect(text.attribute(.link, at: ns.range(of: "site").location, effectiveRange: nil) as? URL == URL(string: "https://burakkoc.net"))
        // A renamed alias shows its current name in a pill.
        #expect(text.string.contains("@kapak"))
        #expect(text.attribute(.studioMention, at: ns.range(of: "@kapak").location, effectiveRange: nil) as? String == "alias-1")
        #expect(text.attribute(.studioQuoteBar, at: ns.range(of: "alıntı").location, effectiveRange: nil) != nil)
        // Only web links are links.
        #expect(MarkdownAttributedBuilder.linkURL("javascript:alert(1)") == nil)
        #expect(MarkdownAttributedBuilder.linkURL("mailto:a@b.c") != nil)
    }

    @Test func markdownViewReusesSegmentViewsWhileStreaming() throws {
        let view = MarkdownView()
        view.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
        view.update(markdown: "Merhaba", context: MarkdownContext())
        let first = try #require(view.segmentViews.first as? MarkdownTextView)
        view.update(markdown: "Merhaba dünya\n```swift\nlet x = 1", context: MarkdownContext())
        #expect(view.segmentViews.first === first, "the text segment is updated, not replaced")
        #expect(first.attributedText.string == "Merhaba dünya")
        let code = try #require(view.segmentViews.last as? MarkdownCodeBlockView)
        #expect(code.language == "swift")
        #expect(code.code == "let x = 1")
        view.update(markdown: "Merhaba dünya\n```swift\nlet x = 1\nlet y = 2\n```\n| a | b |\n|---|---|\n| 1 | 2 |", context: MarkdownContext())
        #expect(view.segmentViews.last is MarkdownTableView)
        #expect(view.segmentViews[1] === code)
        #expect(code.code == "let x = 1\nlet y = 2")
        #expect((view.segmentViews.last as? MarkdownTableView)?.cellTexts == [["a", "b"], ["1", "2"]])
        // The same text again is a no-op.
        let segments = view.segmentViews
        view.update(markdown: view.markdown ?? "", context: MarkdownContext())
        #expect(zip(segments, view.segmentViews).allSatisfy { $0 === $1 })
    }
}

// MARK: - Live states and step groups

@Suite("Chat live states")
@MainActor
struct ChatLiveStateTests {
    @Test func elapsedTimeLikeClaudeCode() {
        #expect(ChatFormat.elapsed(0) == "0s")
        #expect(ChatFormat.elapsed(12.7) == "12s")
        #expect(ChatFormat.elapsed(69) == "1m 9s")
        #expect(ChatFormat.elapsed(39 * 60 + 24) == "39m 24s")
        #expect(ChatFormat.elapsed(3900) == "1h 5m")
        #expect(ChatFormat.elapsed(-5) == "0s")
    }

    @Test func stepGroupSummaries() {
        // One step: its own label.
        #expect(StepSummary.text(for: [step("1", "get_brand_profile", "Marka profili okundu")]) == "Marka profili okundu")
        #expect(StepSummary.text(for: [step("1", "generate_ai_image", "Görsel üretiliyor…", .error)]) == "Görsel üretiliyor · başarısız")
        // Several: counted phrases in order of first appearance.
        #expect(StepSummary.text(for: [
            step("1", "generate_ai_image", "a"), step("2", "generate_post", "b"), step("3", "generate_ai_image", "c"),
        ]) == "2 görsel üretti, 1 post oluşturdu")
        #expect(StepSummary.text(for: [
            step("1", "get_brand_profile", "a"), step("2", "view_alias", "b"), step("3", "view_alias", "c", .error),
        ]) == "Marka profilini okudu, 2 görsele baktı, 1 başarısız")
        #expect(StepSummary.text(for: [step("1", "mystery", "a"), step("2", "other", "b")]) == "2 adım tamamladı")
    }

    @Test func stepThumbnailsFromAliasesAndPosts() {
        let alias = ConversationAlias(id: "al-1", conversationId: "c", alias: "kapak", previousAliases: ["image"], assetId: "asset-k", mimeType: "image/png", createdAt: .now, updatedAt: .now)
        let steps = [
            step("1", "view_alias", "@image görseline bakıldı", summary: "@image"),
            step("2", "generate_post", "Post üretimi başladı", summary: "Hasat · 1 iş"),
            step("3", "view_alias", "x", .running, summary: "@kapak"),
        ]
        let thumbs = StepSummary.thumbnails(steps, aliases: [alias], postByTitle: { _ in nil })
        #expect(thumbs.map(\.assetId) == ["asset-k"])
        #expect(thumbs.first?.caption == "@kapak")
    }

    @Test func liveReplyPutsTheRunningStepOnTheWorkingLine() {
        let run = AgentRun(id: "run-1", conversationId: "c", triggerMessageId: "u", status: .running, createdAt: .now, updatedAt: .now, startedAt: Date(timeIntervalSince1970: 1000))
        let user = Message(id: "u", conversationId: "c", role: .user, parts: [.text("üret")], createdAt: .now, updatedAt: .now)
        var reply = assistant("a", "c", [
            .progress(ProgressPart(stepId: "thinking", label: "Düşünüyor…", state: .running)),
        ], status: .streaming, run: "run-1")
        var input = TranscriptInput(hasState: true, messages: [user, reply], activeRun: run)

        // Before any text: thinking, timed from the run's start.
        var working = TranscriptBuilder.workingItem(input, liveMessageId: TranscriptBuilder.liveMessageId(input))
        #expect(working?.phase == .thinking)
        #expect(working?.label == "Düşünüyor…")
        #expect(working?.since == Date(timeIntervalSince1970: 1000))
        #expect(TranscriptBuilder.items(input).last.map(\.key) == "working")

        // A finished step and a running one: the group shows the finished one; the working line
        // shows the running step's label, timed from when it was first seen.
        reply.parts = [
            .progress(ProgressPart(stepId: "thinking", label: "Düşündü", state: .done)),
            .toolStep(step("s1", "get_brand_profile", "Marka profili okundu")),
            .toolStep(step("s2", "generate_ai_image", "Görsel üretiliyor…", .running)),
        ]
        input.messages = [user, reply]
        input.stepStarts = ["s2": Date(timeIntervalSince1970: 2000)]
        working = TranscriptBuilder.workingItem(input, liveMessageId: "a")
        #expect(working?.phase == .step("Görsel üretiliyor…"))
        #expect(working?.label == "Görsel üretiliyor")
        #expect(working?.isPrimary == true)
        #expect(working?.since == Date(timeIntervalSince1970: 2000))
        #expect(working?.groupKey == "steps-s1")
        #expect(TranscriptBuilder.runningStepIds(input) == ["s2"])
        guard case .assistant(let item) = TranscriptBuilder.items(input)[1], case .steps(let group) = item.blocks.first else {
            Issue.record("expected the reply's step group")
            return
        }
        #expect(group.summary == "Marka profili okundu")

        // Only running steps: no group line at all (the working line has it).
        reply.parts = [.toolStep(step("s3", "generate_post", "Post yazılıyor…", .running))]
        input.messages = [user, reply]
        guard case .assistant(let only) = TranscriptBuilder.items(input)[1] else { return }
        #expect(only.blocks.isEmpty)

        // Text arrived: writing.
        reply.parts = [.toolStep(step("s3", "generate_post", "Post oluşturuldu")), .text("İşte post")]
        input.messages = [user, reply]
        #expect(TranscriptBuilder.workingItem(input, liveMessageId: "a")?.phase == .writing)
    }

    @Test func queuedRunAndEventLines() {
        let run = AgentRun(id: "run-1", conversationId: "c", triggerMessageId: "u", status: .queued, createdAt: .now, updatedAt: .now)
        let event = Message(id: "e", conversationId: "c", role: .system, parts: [.text("Zamanlanmış post yayınlandı · Instagram")], createdAt: .now, updatedAt: .now)
        let input = TranscriptInput(hasState: true, messages: [event], activeRun: run, runWaitingForMac: true, isOnline: false)
        let items = TranscriptBuilder.items(input)
        #expect(items.first == .event(id: "e", text: "Zamanlanmış post yayınlandı · Instagram"))
        guard case .working(let working) = items.last else {
            Issue.record("expected the working line")
            return
        }
        #expect(working.label == "Mac sırada bekliyor: Mac çevrimdışı.")
        #expect(working.cancellable)
        #expect(!working.isAnimated)
        #expect(working.since == nil)
        #expect(TranscriptBuilder.items(TranscriptInput(hasState: false, connectionTrouble: true)) == [.loading(trouble: true)])
    }

    @Test func workingLineTicksItsOwnClock() async throws {
        let app = await makeApp()
        retainedApps.append(app)
        let env = TranscriptEnvironment(model: app.conversationModel(SampleData.kasimConversation))
        let line = WorkingLineView(env: env)
        let start = Date(timeIntervalSince1970: 5000)
        line.now = { start.addingTimeInterval(69) }
        line.apply(.working(WorkingItem(phase: .step("Görsel üretiliyor"), since: start, cancellable: false, groupKey: "steps-x")))
        #expect(line.label.stringValue == "Görsel üretiliyor")
        #expect(line.timeLabel.stringValue == "1m 9s")
        line.now = { start.addingTimeInterval(70) }
        line.tick()
        #expect(line.timeLabel.stringValue == "1m 10s")
        line.apply(.working(WorkingItem(phase: .queued("Sırada"), since: nil, cancellable: true, groupKey: nil)))
        #expect(line.timeLabel.isHidden)
        #expect(!line.dots.isAnimating)
    }

    @Test func stepGroupExpandsAndCollapses() async throws {
        let (_, model, controller) = try await makeChat(SampleData.kasimConversation)
        let reply = try #require(controller.row(forKey: "m-m-k2") as? AssistantMessageRowView)
        let group = try #require(reply.blockView(forKey: "steps-ts-profile") as? StepGroupView)
        #expect(group.header.label.stringValue == "Marka profilini okudu, plan önerdi")
        #expect(group.stepRowCount == 0)
        group.header.performTap()
        #expect(model.expandedStepGroups == ["steps-ts-profile"])
        controller.syncNow()
        #expect(reply.blockView(forKey: "steps-ts-profile") === group)
        #expect(group.stepRowCount == 2)
        group.header.performTap()
        controller.syncNow()
        #expect(group.stepRowCount == 0)
    }
}

// MARK: - Incremental updates and scrolling

@Suite("Chat incremental updates")
@MainActor
struct ChatIncrementalUpdateTests {
    @Test(arguments: [SampleData.kasimConversation, SampleData.lansmanConversation, SampleData.hasatConversation, "c-bayi"])
    func rowsLayOutWithoutAmbiguity(_ conversation: EntityID) async throws {
        let (_, _, controller) = try await makeChat(conversation) { state in
            // Every block type at once in the last reply.
            state.messages.append(assistant("all", state.conversation.id, [
                .text("# Başlık\n**Plan:**\n- bir `kod`\n  - iki\n1. üç\n> alıntı\n```swift\nlet x = 1\n```\n| a | b |\n|---|---|\n| 1 | 2 |"),
                .toolStep(ToolStepPart(id: "t1", name: "generate_ai_image", label: "Görsel üretildi", state: .done)),
                .toolStep(ToolStepPart(id: "t2", name: "generate_post", label: "Post oluşturuldu", state: .error, summary: "zaman aşımı")),
                .attachment(AttachmentPart(assetId: "asset-tarla", mimeType: "image/png", width: 1080, height: 1350)),
                .progress(ProgressPart(stepId: "p", label: "Postlar hazırlandı", state: .done, current: 2, total: 2)),
                .contentRef(ContentRefPart(contentId: "missing", note: "taslak")),
                .error(ErrorPart(message: "Bir şey ters gitti")),
            ], status: .cancelled))
        }
        controller.view.layoutSubtreeIfNeeded()
        let ambiguous = descendants(NSView.self, in: controller.view).filter(\.hasAmbiguousLayout)
        #expect(ambiguous.isEmpty, "ambiguous: \(ambiguous.map { String(describing: type(of: $0)) })")
        let rows = controller.transcriptRows
        #expect(rows.allSatisfy { $0.frame.height > 0 })
        let columnWidth = try #require(rows.first?.frame.width)
        #expect(rows.allSatisfy { abs($0.frame.width - columnWidth) < 0.5 })
        for text in descendants(MarkdownTextView.self, in: controller.view) {
            #expect(text.frame.height >= 18)
            #expect(abs(text.frame.width - columnWidth) < 0.5)
        }
        let reply = try #require(controller.row(forKey: "m-all") as? AssistantMessageRowView)
        #expect(reply.orderedBlockViews.count == 7, "text, steps, images, progress, post, error, notice")
        let group = try #require(reply.blockView(forKey: "steps-t1") as? StepGroupView)
        #expect(group.header.label.stringValue == "1 görsel üretti, 1 post oluşturdu, 1 başarısız")
    }

    @Test func streamedChangesReuseRowsAndKeepTypedAnswers() async throws {
        let (_, model, controller) = try await makeChat(SampleData.lansmanConversation)
        #expect(controller.renderedKeys == ["m-m-l1", "m-m-l2"])
        let userRow = try #require(controller.row(forKey: "m-m-l1") as? UserMessageRowView)
        let reply = try #require(controller.row(forKey: "m-m-l2") as? AssistantMessageRowView)
        let host = try #require(reply.blockView(forKey: "question-launch-date") as? QuestionHostView)
        let card = try #require(host.card)
        let markdown = try #require(reply.blockView(forKey: "text-1") as? MarkdownView)
        card.answerField.stringValue = "Aralık başı daha iyi"

        // The reply grows, a new reply streams in, the question becomes busy.
        var next = try #require(model.state)
        guard case .text(let text) = next.messages[1].parts[1] else {
            Issue.record("expected text")
            return
        }
        next.messages[1].parts[1] = .text(text + " Ek bilgi.")
        next.messages.append(assistant("m-l3", SampleData.lansmanConversation, [.text("Yeni **yanıt**")], status: .streaming))
        model.replaceState(next)
        model.busyQuestions.insert("m-l2" + "launch-date")
        controller.syncNow()

        #expect(controller.renderedKeys == ["m-m-l1", "m-m-l2", "m-m-l3"])
        #expect(controller.row(forKey: "m-m-l1") === userRow)
        #expect(controller.row(forKey: "m-m-l2") === reply)
        #expect(reply.blockView(forKey: "text-1") === markdown)
        #expect(markdown.renderedText.hasSuffix("Ek bilgi."))
        #expect(reply.blockView(forKey: "question-launch-date") === host)
        #expect(host.card === card, "the question card survives: typed text is kept")
        #expect(card.answerField.stringValue == "Aralık başı daha iyi")
        #expect(card.isBusy)
        #expect(controller.transcriptRows.count == 3)

        // Answered: the card is rebuilt as an answer.
        next.messages[1].parts[2] = {
            guard case .question(var q) = next.messages[1].parts[2] else { return next.messages[1].parts[2] }
            q.answer = QuestionAnswer(optionIds: ["nov-25"], answeredAt: .now)
            return .question(q)
        }()
        model.replaceState(next)
        controller.syncNow()
        #expect(host.card !== card)
    }

    @Test func userImagesAndRepliesUseTheConversationImageGrid() async throws {
        let (_, _, controller) = try await makeChat(SampleData.hasatConversation)
        let user = try #require(controller.row(forKey: "m-m-h1") as? UserMessageRowView)
        #expect(user.imageTiles.map(\.image.assetId) == ["asset-tarla", "asset-depo"])
        #expect(user.imageTiles.map(\.image.caption) == ["@image", "@image-1"])
        // Mentions in the reply resolve to the aliases.
        let reply = try #require(controller.row(forKey: "m-m-h2") as? AssistantMessageRowView)
        let markdown = try #require(reply.blockView(forKey: "text-1") as? MarkdownView)
        #expect(markdown.renderedText.contains("@image-1"))
    }

    @Test func followsTheBottomOnlyWhileTheReaderIsThere() async throws {
        let conversation = SampleData.kasimConversation
        let filler = (0..<24).map { index in
            assistant("fill-\(index)", conversation, [.text("Paragraf \(index): " + String(repeating: "uzun bir cümle ", count: 30))])
        }
        let (_, model, controller) = try await makeChat(conversation) { $0.messages += filler }
        let scroll = try #require(controller.view.subviews.compactMap { $0 as? NSScrollView }.first)
        let clip = scroll.contentView
        let document = try #require(scroll.documentView)
        controller.view.layoutSubtreeIfNeeded()
        #expect(document.frame.height > clip.bounds.height * 2)
        #expect(controller.isPinnedToBottom)
        #expect(abs(clip.bounds.origin.y - (document.frame.height - clip.bounds.height)) < 1)

        // The reader scrolls up: new content does not move the page.
        clip.setBoundsOrigin(NSPoint(x: 0, y: 100))
        scroll.reflectScrolledClipView(clip)
        #expect(!controller.isPinnedToBottom)
        var next = try #require(model.state)
        next.messages.append(assistant("late-1", conversation, [.text(String(repeating: "yeni içerik ", count: 40))]))
        model.replaceState(next)
        controller.syncNow()
        controller.view.layoutSubtreeIfNeeded()
        #expect(clip.bounds.origin.y == 100)
        #expect(controller.showsJumpButton)

        // Back at the bottom: it follows again.
        clip.setBoundsOrigin(NSPoint(x: 0, y: document.frame.height - clip.bounds.height))
        scroll.reflectScrolledClipView(clip)
        #expect(controller.isPinnedToBottom)
        #expect(!controller.showsJumpButton)
        next.messages.append(assistant("late-2", conversation, [.text(String(repeating: "daha da yeni ", count: 40))]))
        model.replaceState(next)
        controller.syncNow()
        controller.view.layoutSubtreeIfNeeded()
        #expect(abs(clip.bounds.origin.y - (document.frame.height - clip.bounds.height)) < 1)
    }

    @Test func messagesWrittenDuringAReplyAreQueuedThenSent() async throws {
        let app = await makeApp()
        retainedApps.append(app)
        let conversation = app.conversationModel(SampleData.hasatConversation)
        await waitUntil { conversation.state != nil }
        conversation.composer.text = "ilk mesaj"
        await conversation.send()
        await waitUntil { conversation.activeRun != nil }
        #expect(conversation.activeRun != nil)

        conversation.composer.text = "ikinci mesaj"
        await conversation.send()
        #expect(conversation.error == nil)
        #expect(conversation.queue.map(\.message.text) == ["ikinci mesaj"])
        #expect(conversation.composer.text.isEmpty)
        let items = TranscriptBuilder.items(TranscriptInput(hasState: true, messages: conversation.messages, activeRun: conversation.activeRun, queue: conversation.queue))
        guard case .queued(let queued) = items.last else {
            Issue.record("expected the queued bubble last")
            return
        }
        #expect(queued.text == "ikinci mesaj")
        #expect(queued.canEdit)

        // Edit puts it back into the composer.
        conversation.editQueued(queued.id)
        #expect(conversation.queue.isEmpty)
        #expect(conversation.composer.text == "ikinci mesaj")
        await conversation.send()
        #expect(conversation.queue.count == 1)

        // "Şimdi gönder": the running reply stops and the message goes out.
        await conversation.sendQueuedNow(try #require(conversation.queue.first).id)
        await waitUntil { conversation.queue.isEmpty && conversation.messages.last?.plainText == "ikinci mesaj" }
        #expect(conversation.queue.isEmpty)
        #expect(conversation.messages.last?.plainText == "ikinci mesaj")
    }
}

// MARK: - Images and the lightbox

@Suite("Chat images and lightbox", .serialized)
@MainActor
struct ChatLightboxTests {
    @Test func imageGridLayout() {
        // One portrait image: as wide as allowed while its height stays reasonable.
        let single = ChatImageGridView.layout(count: 1, width: 700, aspect: 1.25, maxWidth: 480)
        #expect(single.frames.count == 1)
        #expect(abs(single.size.height / single.size.width - 1.25) < 0.01)
        #expect(single.size.width <= 480)
        // A small image is not blown up past the tile minimum.
        #expect(ChatImageGridView.layout(count: 1, width: 700, aspect: 1, maxWidth: 480, naturalWidth: 200).size.width == 200)
        // Several: square cells in 2 or 3 columns with 6 pt gaps.
        let two = ChatImageGridView.layout(count: 2, width: 700, aspect: 1, maxWidth: 480)
        #expect(two.frames.map(\.width) == [237, 237])
        #expect(two.frames[1].minX == 243)
        let five = ChatImageGridView.layout(count: 5, width: 700, aspect: 1, maxWidth: 480)
        #expect(ChatImageGridView.columnCount(for: 5) == 3)
        #expect(five.frames[3].minY == five.frames[0].maxY + 6)
        #expect(ChatImageGridView.columnCount(for: 4) == 2)
        // A narrow column shrinks the grid.
        #expect(ChatImageGridView.layout(count: 3, width: 300, aspect: 1, maxWidth: 480).size.width <= 300)
    }

    @Test func navigatorCountsLikeClaudeCode() {
        var nav = LightboxNavigator(count: 12, start: 8)
        #expect(nav.counterText == "9 / 12")
        var moved = nav.next()
        #expect(moved)
        #expect(nav.counterText == "10 / 12")
        moved = nav.go(to: 11)
        #expect(moved)
        moved = nav.next()
        #expect(!moved, "no wrap-around at the end")
        #expect(!nav.canGoForward)
        moved = nav.previous()
        #expect(moved)
        #expect(nav.index == 10)
        moved = nav.go(to: 40)
        #expect(!moved)
        #expect(LightboxNavigator(count: 3, start: 9).index == 2)
        #expect(LightboxNavigator(count: 1, start: 0).showsCounter == false)
    }

    @Test func geometryFitsZoomsAndPans() {
        let bounds = NSRect(x: 0, y: 0, width: 1000, height: 700)
        let fit = LightboxGeometry.fitRect(imageSize: NSSize(width: 1080, height: 1350), in: bounds)
        #expect(abs(fit.height / fit.width - 1.25) < 0.01)
        #expect(fit.maxY <= bounds.height - LightboxGeometry.insets.top)
        #expect(fit.minY >= LightboxGeometry.insets.bottom)
        #expect(abs(fit.midX - bounds.midX) <= 1)
        #expect(LightboxGeometry.clampZoom(9) == 5)
        #expect(LightboxGeometry.clampZoom(0.2) == 1)
        #expect(LightboxGeometry.clampPan(CGPoint(x: 50, y: 50), fit: fit, zoom: 1, viewport: bounds) == .zero)
        let zoomed = LightboxGeometry.clampPan(CGPoint(x: 5000, y: -5000), fit: fit, zoom: 3, viewport: bounds)
        #expect(zoomed.x > 0 && zoomed.x < 5000)
        #expect(zoomed.y < 0 && zoomed.y > -5000)
        // Zooming around a point keeps that point still.
        let point = CGPoint(x: fit.minX + 10, y: fit.minY + 10)
        let pan = LightboxGeometry.panKeeping(point, fit: fit, from: 1, to: 2, pan: .zero)
        let frame = LightboxGeometry.imageFrame(fit: fit, zoom: 2, pan: pan)
        #expect(abs(frame.minX + 20 - point.x) < 0.01)
    }

    private func window() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: true)
        window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700))
        return window
    }

    private func key(_ code: UInt16, in window: NSWindow) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
    }

    @Test func lightboxPagesWithArrowKeysAndClosesWithEsc() throws {
        let window = window()
        let content = try #require(window.contentView)
        let source = NSView(frame: NSRect(x: 100, y: 100, width: 80, height: 100))
        content.addSubview(source)
        let items = (0..<3).map { index in
            ImageLightbox.Item(image: NSImage(size: NSSize(width: 100, height: 120 + index)), caption: "@image-\(index)")
        }
        let lightbox = try #require(ImageLightbox.present(items: items, startIndex: 1, from: source, in: window, animated: false))
        let overlay = lightbox.overlay
        #expect(overlay.superview === content)
        #expect(ImageLightbox.current === lightbox)
        #expect(window.firstResponder === overlay)
        #expect(overlay.counterLabel.stringValue == "2 / 3")
        #expect(overlay.captionText == "@image-1")
        #expect(source.alphaValue == 0, "the thumbnail lifts into the lightbox")
        #expect(overlay.dimAlpha == 1)

        overlay.keyDown(with: key(124, in: window))
        #expect(lightbox.index == 2)
        #expect(overlay.counterLabel.stringValue == "3 / 3")
        #expect(!overlay.nextButton.isEnabled)
        overlay.keyDown(with: key(124, in: window))
        #expect(lightbox.index == 2)
        #expect(source.alphaValue == 1, "another image is shown: its thumbnail is unknown, the first is back")
        overlay.keyDown(with: key(123, in: window))
        overlay.keyDown(with: key(123, in: window))
        #expect(lightbox.index == 0)
        #expect(!overlay.previousButton.isEnabled)
        #expect(overlay.captionText == "@image-0")

        // Double-click zoom, then Esc closes.
        overlay.setZoom(2.5, around: nil, animated: false)
        #expect(overlay.zoom == 2.5)
        overlay.keyDown(with: key(53, in: window))
        #expect(lightbox.isClosing)
    }

    @Test func closingRestoresTheWindow() throws {
        let window = window()
        let content = try #require(window.contentView)
        let field = FocusableView(frame: NSRect(x: 10, y: 10, width: 200, height: 24))
        content.addSubview(field)
        window.makeFirstResponder(field)
        let previous = window.firstResponder
        #expect(previous === field)
        let source = NSView(frame: NSRect(x: 300, y: 300, width: 60, height: 60))
        content.addSubview(source)
        let lightbox = try #require(ImageLightbox.present(items: [ImageLightbox.Item(image: NSImage(size: NSSize(width: 50, height: 50)))], startIndex: 0, from: source, in: window, animated: false))
        #expect(lightbox.overlay.counterLabel.isHidden, "one image: no counter")
        lightbox.close(animated: false)
        #expect(lightbox.overlay.superview == nil)
        #expect(ImageLightbox.current == nil)
        #expect(source.alphaValue == 1)
        #expect(window.firstResponder === previous)
        #expect(ImageLightbox.present(items: [], startIndex: 0, from: nil, in: window) == nil)
    }

    @Test func chatImageClickOpensTheLightboxOverTheConversationImages() async throws {
        let (_, _, controller) = try await makeChat(SampleData.hasatConversation)
        let window = window()
        window.contentView = controller.view
        controller.view.layoutSubtreeIfNeeded()
        let user = try #require(controller.row(forKey: "m-m-h1") as? UserMessageRowView)
        let tile = try #require(user.imageTiles.last)
        #expect(tile.accessibilityPerformPress())
        let lightbox = try #require(ImageLightbox.current)
        #expect(lightbox.items.map(\.assetId) == ["asset-tarla", "asset-depo"])
        #expect(lightbox.index == 1)
        #expect(lightbox.overlay.captionText == "@image-1")
        lightbox.close(animated: false)
    }
}

private final class FocusableView: NSView {
    override var acceptsFirstResponder: Bool { true }
}
