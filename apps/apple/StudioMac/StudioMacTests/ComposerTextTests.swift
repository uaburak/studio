import AppKit
import StudioKit
import Testing
@testable import StudioMac

/// The pure AppKit composer (`ComposerEditor`): typed `@alias` becomes a pill token,
/// the `@` popup inserts tokens, export keeps `@alias` text, Return sends.
@Suite("Composer text view")
@MainActor
struct ComposerTextTests {
    @MainActor
    private final class Harness {
        let model = ComposerModel()
        let editor: ComposerEditor
        var textView: ComposerNSTextView { editor.textView }
        var submitted = 0

        @MainActor
        init(aliases: [String]) {
            var submit: () -> Void = {}
            editor = ComposerEditor(model: model, onSubmit: { submit() }, onImages: { _, _ in })
            model.updateConversationAliases(aliases.enumerated().map { index, name in
                ConversationAlias(id: "al\(index)", conversationId: "c", alias: name, assetId: "a\(index)", mimeType: "image/png", createdAt: .now, updatedAt: .now)
            })
            submit = { [unowned self] in self.submitted += 1 }
        }

        func type(_ text: String) {
            for character in text { textView.insertText(String(character), replacementRange: textView.selectedRange()) }
        }

        var tokens: [String] {
            var names: [String] = []
            textView.textStorage?.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textView.textStorage?.length ?? 0)) { value, _, _ in
                if let mention = value as? MentionAttachment { names.append(mention.alias) }
            }
            return names
        }
    }

    @Test func typedMentionBecomesATokenOnceComplete() {
        let harness = Harness(aliases: ["image", "image-1"])
        harness.type("Kapak @image")
        // Still typing: `@image` could become `@image-1`.
        #expect(harness.tokens.isEmpty)
        harness.type("-1 ve @bilinmeyen ")
        #expect(harness.tokens == ["image-1"])
        #expect(harness.model.text == "Kapak @image-1 ve @bilinmeyen ")
    }

    @Test func autocompleteInsertsATokenAndExportsText() {
        let harness = Harness(aliases: ["image", "tarla"])
        harness.type("Bunu kullan @ta")
        #expect(harness.model.isSuggesting)
        #expect(harness.model.suggestions.first?.alias == "tarla")
        harness.model.choose()
        #expect(harness.tokens == ["tarla"])
        #expect(harness.model.text == "Bunu kullan @tarla ")
        #expect(!harness.model.isSuggesting)
    }

    @Test func aSecondMentionFromThePopupLandsAfterAnEarlierToken() {
        // The query offset is in the exported text (`@image-1` = 8 characters), the storage
        // holds the earlier token as one character: picking used to raise NSRangeException.
        let harness = Harness(aliases: ["image-1", "tarla"])
        harness.type("@image-1 ve @ta")
        #expect(harness.tokens == ["image-1"])
        #expect(harness.model.isSuggesting)
        harness.model.choose(MentionSuggestion(alias: "tarla", thumbnail: .asset("a1"), isDraft: false))
        #expect(harness.tokens == ["image-1", "tarla"])
        #expect(harness.model.text == "@image-1 ve @tarla ")
        #expect(harness.editor.storageOffset(forExported: 0) == 0)
        #expect(harness.editor.storageOffset(forExported: 8) == 1, "right after the first token")
        #expect(harness.editor.storageOffset(forExported: 3) == 0, "inside a token: its start")
        #expect(harness.editor.storageOffset(forExported: 999) == harness.textView.textStorage?.length)
    }

    @Test func aRetriedSendKeepsItsKeyAndTextTypedMeanwhileStays() {
        let model = ComposerModel()
        model.text = "Kasım postları"
        let first = model.makeMessage()
        #expect(model.makeMessage().clientMessageId == first.clientMessageId, "a retry of the same message keeps its idempotency key")
        model.text = "Kasım postları ve hikâyeler"
        let changed = model.makeMessage()
        #expect(changed.clientMessageId != first.clientMessageId)

        // Typed while the send was in flight: kept after it succeeds.
        model.text = changed.text + " Bir de reels"
        model.didSend(changed)
        #expect(model.text == "Bir de reels")
        // Sent as is: cleared, and the next message gets a new key.
        let next = model.makeMessage()
        model.didSend(next)
        #expect(model.text.isEmpty)
        model.text = "Bir de reels"
        #expect(model.makeMessage().clientMessageId != next.clientMessageId)
    }

    @Test func renamingADraftRenamesWholeTokensOnly() {
        #expect(MentionText.renaming("urun", to: "kapak", in: "@urun ve @urun-2, @urun.") == "@kapak ve @urun-2, @kapak.")
        #expect(MentionText.renaming("image-1", to: "tarla", in: "@image-10 @image-1") == "@image-10 @tarla")
        #expect(MentionText.renaming("x", to: "y", in: "e@x.com") == "e@x.com", "an e-mail is not a mention")
    }

    @Test func returnSendsAndArrowsDriveTheSuggestions() {
        let harness = Harness(aliases: ["image", "image-1"])
        harness.type("@")
        #expect(harness.model.suggestions.map(\.alias) == ["image", "image-1"])
        _ = harness.editor.textView(harness.textView, doCommandBy: #selector(NSResponder.moveDown(_:)))
        #expect(harness.model.suggestionIndex == 1)
        _ = harness.editor.textView(harness.textView, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        #expect(harness.tokens == ["image-1"])
        #expect(harness.submitted == 0)
        _ = harness.editor.textView(harness.textView, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        #expect(harness.submitted == 1)
    }

    @Test func clearAndSetTextKeepTokens() {
        let harness = Harness(aliases: ["image"])
        harness.editor.setText("@image ile başla")
        #expect(harness.tokens == ["image"])
        #expect(harness.model.text == "@image ile başla")
        harness.editor.clear()
        #expect(harness.model.text.isEmpty)
        #expect(harness.tokens.isEmpty)
    }
}
