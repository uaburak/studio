import StudioKit
import UIKit

/// What a message cell needs from the screen.
@MainActor
struct ChatCellContext {
    unowned let model: IOSConversationModel
    var onMention: (EntityID) -> Void
    var onAttachment: (AttachmentPart, UIView) -> Void
    var onOpenPost: (ContentRefPart) -> Void
    var onEditPlan: (Plan) -> Void
    var onAnswerText: (Message, QuestionPart) -> Void
    /// Copy, read aloud and share under a finished reply.
    var onCopy: (Message) -> Void = { _ in }
    var onSpeak: (Message) -> Void = { _ in }
    var onShare: (Message, UIView) -> Void = { _, _ in }
    /// A tapped `@product` / `@post`.
    var onEntityMention: (MessageEntityMention) -> Void = { _ in }
    /// The screen that presents the approval cards' prompts and pictures.
    var host: () -> UIViewController? = { nil }
    var images: IOSImageStore { model.app.images }
}

// MARK: - Text with mentions and light markdown

enum ChatText {
    static let mentionScheme = "studio-mention"
    /// `studio-entity://product/<id>`, `studio-entity://content/<id>`.
    static let entityScheme = "studio-entity"

    /// Reading size of replies (New York, scaled with Dynamic Type).
    static let bodySize: CGFloat = 17

    private static func paragraph(lineSpacing: CGFloat = 5, spacing: CGFloat = 10, indent: CGFloat = 0) -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing
        style.paragraphSpacing = spacing
        if indent > 0 {
            // Hanging indent: the marker sits in the margin, wrapped lines align with the text.
            style.headIndent = indent
            style.firstLineHeadIndent = 2
            style.tabStops = [NSTextTab(textAlignment: .natural, location: indent)]
            style.defaultTabInterval = indent
        }
        return style
    }

    /// Assistant text as Claude-style reading copy: New York with generous line height,
    /// bold serif headings, bullet and numbered lists with hanging indents, inline markdown
    /// (bold, italic, code, links), fenced code blocks, and `@alias` mentions as links.
    static func assistant(_ raw: String, aliases: [ConversationAlias]) -> NSAttributedString {
        let base = IOSTheme.serif(bodySize)
        let out = NSMutableAttributedString()
        let lines = raw.components(separatedBy: "\n")
        var inCode = false
        for (index, rawLine) in lines.enumerated() {
            let isLast = index == lines.count - 1
            if rawLine.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inCode.toggle()
                continue
            }
            if inCode {
                let code = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 14, weight: .regular))
                out.append(NSAttributedString(string: rawLine + (isLast ? "" : "\n"), attributes: [
                    .font: code, .foregroundColor: IOSTheme.textPrimary, .backgroundColor: IOSTheme.fill,
                    .paragraphStyle: paragraph(lineSpacing: 2, spacing: 0),
                ]))
                continue
            }
            var line = rawLine
            var lineFont = base
            var style = paragraph()
            var marker: String?
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let depth = line.prefix { $0 == " " }.count >= 2 ? 1 : 0
            if let heading = ["### ", "## ", "# "].first(where: { line.hasPrefix($0) }) {
                line = String(line.dropFirst(heading.count))
                lineFont = IOSTheme.serif(heading == "### " ? 18 : 20, .bold, style: .title3)
                style = paragraph(lineSpacing: 3, spacing: 8)
                style.paragraphSpacingBefore = index == 0 ? 0 : 10
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                line = String(trimmed.dropFirst(2))
                marker = "•"
                style = paragraph(spacing: 8, indent: 22 + CGFloat(depth) * 20)
                style.firstLineHeadIndent = 4 + CGFloat(depth) * 20
            } else if let match = trimmed.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
                marker = String(trimmed[match].dropLast())
                line = String(trimmed[match.upperBound...])
                style = paragraph(spacing: 8, indent: 26 + CGFloat(depth) * 20)
                style.firstLineHeadIndent = CGFloat(depth) * 20
            } else if trimmed.isEmpty {
                // Blank lines are paragraph breaks; paragraph spacing already separates them.
                continue
            }
            if let marker {
                out.append(NSAttributedString(string: "\(marker)\t", attributes: [.font: base, .foregroundColor: IOSTheme.textPrimary, .paragraphStyle: style]))
            }
            let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
            if let parsed = try? AttributedString(markdown: line, options: options) {
                for run in parsed.runs {
                    let text = String(parsed[run.range].characters)
                    var font = lineFont
                    var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: IOSTheme.textPrimary, .paragraphStyle: style]
                    if let intent = run.inlinePresentationIntent {
                        if intent.contains(.code) {
                            font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .regular))
                            attrs[.backgroundColor] = IOSTheme.fill
                        } else if intent.contains(.stronglyEmphasized) {
                            font = IOSTheme.serif(lineFont == base ? bodySize : lineFont.pointSize, .bold)
                        }
                        if intent.contains(.emphasized), let italic = font.fontDescriptor.withSymbolicTraits(.traitItalic) {
                            font = UIFont(descriptor: italic, size: 0)
                        }
                    }
                    if let link = run.link { attrs[.link] = link }
                    attrs[.font] = font
                    out.append(NSAttributedString(string: text, attributes: attrs))
                }
            } else {
                out.append(NSAttributedString(string: line, attributes: [.font: lineFont, .foregroundColor: IOSTheme.textPrimary, .paragraphStyle: style]))
            }
            if !isLast { out.append(NSAttributedString(string: "\n", attributes: [.font: lineFont, .paragraphStyle: style])) }
        }
        // No trailing newline (it would add an empty line under the reply).
        while out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        markMentions(out, mentions: MentionText.resolve(out.string, aliases: aliases.map(MentionText.Target.init)), aliases: aliases, font: IOSTheme.serif(bodySize, .semibold))
        return out
    }

    /// User text: the server's mentions (UTF-16 ranges), drawn with the alias's current name;
    /// `@product` / `@post` names in the accent colour.
    static func user(_ text: String, mentions: [MessageMention], entityMentions: [MessageEntityMention] = [], aliases: [ConversationAlias]) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let attrs: [NSAttributedString.Key: Any] = [.font: IOSTheme.font(17), .foregroundColor: IOSTheme.textPrimary, .paragraphStyle: paragraph]
        let out = NSMutableAttributedString()
        for segment in MentionText.segments(text, mentions: mentions, entityMentions: entityMentions) {
            switch segment {
            case .text(let chunk):
                out.append(NSAttributedString(string: chunk, attributes: attrs))
            case .mention(let mention):
                let name = aliases.first { $0.id == mention.aliasId }?.alias ?? mention.alias
                var mentionAttrs = attrs
                mentionAttrs[.font] = IOSTheme.font(17, .semibold)
                if let url = URL(string: "\(mentionScheme)://\(mention.aliasId)") { mentionAttrs[.link] = url }
                out.append(NSAttributedString(string: "@\(name)", attributes: mentionAttrs))
            case .entity(let mention):
                var entityAttrs = attrs
                entityAttrs[.font] = IOSTheme.font(17, .semibold)
                entityAttrs[.foregroundColor] = IOSTheme.accent
                if let url = URL(string: "\(entityScheme)://\(mention.kind.rawValue)/\(mention.id)") { entityAttrs[.link] = url }
                out.append(NSAttributedString(string: "@\(mention.name)", attributes: entityAttrs))
            }
        }
        return out
    }

    private static func markMentions(_ text: NSMutableAttributedString, mentions: [MessageMention], aliases: [ConversationAlias], font: UIFont) {
        for mention in mentions.reversed() {
            let range = NSRange(location: mention.start, length: mention.end - mention.start)
            guard range.location + range.length <= text.length else { continue }
            let name = aliases.first { $0.id == mention.aliasId }?.alias ?? mention.alias
            var attrs = text.attributes(at: range.location, effectiveRange: nil)
            attrs[.font] = font
            if let url = URL(string: "\(mentionScheme)://\(mention.aliasId)") { attrs[.link] = url }
            text.replaceCharacters(in: range, with: NSAttributedString(string: "@\(name)", attributes: attrs))
        }
    }
}

/// Read-only, selectable text that sizes itself and reports mention taps.
final class ChatTextView: UITextView, UITextViewDelegate {
    var onMention: ((EntityID) -> Void)?
    var onEntityMention: ((MessageEntityMention) -> Void)?

    init() {
        super.init(frame: .zero, textContainer: nil)
        translatesAutoresizingMaskIntoConstraints = false
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        adjustsFontForContentSizeCategory = true
        delegate = self
        linkTextAttributes = [.foregroundColor: IOSTheme.textPrimary, .underlineStyle: 0]
        setContentCompressionResistancePriority(.required, for: .vertical)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
        if case .link(let url) = textItem.content, url.scheme == ChatText.mentionScheme, let id = url.host {
            return UIAction { [weak self] _ in self?.onMention?(id) }
        }
        if case .link(let url) = textItem.content, url.scheme == ChatText.entityScheme, let kind = url.host.flatMap(MentionEntityKind.init(rawValue:)) {
            let id = url.lastPathComponent
            let name = (textView.attributedText.string as NSString).substring(with: textItem.range).trimmingCharacters(in: CharacterSet(charactersIn: "@"))
            return UIAction { [weak self] _ in self?.onEntityMention?(MessageEntityMention(kind: kind, id: id, name: name, start: 0, end: 0)) }
        }
        return defaultAction
    }

    func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
        if case .link(let url) = textItem.content, url.scheme == ChatText.mentionScheme || url.scheme == ChatText.entityScheme { return nil }
        return UITextItem.MenuConfiguration(menu: defaultMenu)
    }
}

// MARK: - Message cell

final class ChatMessageCell: UITableViewCell {
    static let reuseId = "message"
    /// Side margin of the conversation (wider than the list gutter, like a book page).
    static let gutter: CGFloat = 20
    private let stack = UIStackView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        // Self-sizing fits the row to the stack (the fitting pass minimizes the height). The
        // bottom is a bound, not a pull, and weaker than compression resistance (750): when
        // the row is a hair taller or shorter than its content (row heights are rounded),
        // nothing is stretched or squeezed, so cards built from stacks keep one exact layout.
        let fits = stack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -10)
        fits.priority = .init(740)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: Self.gutter),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -Self.gutter),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            fits,
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(message: Message, context: ChatCellContext) {
        stack.removeAllArranged()
        if message.role == .user {
            stack.addArrangedSubview(ChatViews.userMessage(message, context: context))
        } else {
            ChatViews.assistantParts(message, context: context).forEach { stack.addArrangedSubview($0) }
        }
    }

    func configure(views: [UIView]) {
        stack.removeAllArranged()
        views.forEach { stack.addArrangedSubview($0) }
    }

    /// A soft highlight that fades: "this is the message you came for".
    func flash() {
        contentView.backgroundColor = IOSTheme.accent.withAlphaComponent(0.12)
        UIView.animate(withDuration: 1.2, delay: 0.5, options: [.allowUserInteraction]) {
            self.contentView.backgroundColor = .clear
        }
    }
}

/// Builders for the parts of a message.
@MainActor
enum ChatViews {
    /// The user's message: attachments, then a right-aligned rounded grey bubble.
    static func userMessage(_ message: Message, context: ChatCellContext) -> UIView {
        let column = UIStackView.v([], spacing: 6, alignment: .trailing)
        let attachments = message.parts.compactMap { if case .attachment(let a) = $0 { a } else { nil } }
        if !attachments.isEmpty {
            let row = UIStackView.h(attachments.map { attachmentThumb($0, size: 76, context: context) }, spacing: 6, alignment: .bottom)
            let scroller = UIScrollView()
            scroller.translatesAutoresizingMaskIntoConstraints = false
            scroller.showsHorizontalScrollIndicator = false
            scroller.addSubview(row)
            NSLayoutConstraint.activate([
                row.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor),
                row.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor),
                row.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor),
                row.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor),
                scroller.heightAnchor.constraint(equalToConstant: 76),
                scroller.widthAnchor.constraint(equalToConstant: min(CGFloat(attachments.count) * 82, 280)),
            ])
            column.addArrangedSubview(scroller)
        }
        let wrapper = UIStackView.h([UIView.spacer(), column], spacing: 0, alignment: .top)
        let text = message.plainText
        if !text.isEmpty {
            let bubble = UIView()
            bubble.translatesAutoresizingMaskIntoConstraints = false
            bubble.backgroundColor = IOSTheme.fill
            bubble.layer.cornerRadius = 22
            bubble.layer.cornerCurve = .continuous
            let textView = ChatTextView()
            let state = context.model.state
            textView.attributedText = ChatText.user(
                text, mentions: state?.mentions(in: message, text: text) ?? message.mentions ?? [],
                entityMentions: message.entityMentions ?? [], aliases: state?.aliases ?? [])
            textView.onMention = context.onMention
            textView.onEntityMention = context.onEntityMention
            bubble.addSubview(textView)
            textView.pin(to: bubble, insets: UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16))
            column.addArrangedSubview(bubble)
            // At most ~4/5 of the line, like a chat bubble; long messages wrap inside.
            bubble.widthAnchor.constraint(lessThanOrEqualTo: wrapper.widthAnchor, multiplier: 0.82).isActive = true
            bubble.accessibilityLabel = "Sen: \(text)"
        }
        if message.parts.contains(where: \.isUnreadable) {
            column.addArrangedSubview(unreadableLabel())
        }
        return wrapper
    }

    /// A message (or part) this build could not read.
    static func unreadableLabel() -> UILabel {
        UILabel.studio(MessagePart.unreadableText, size: 13, color: IOSTheme.textTertiary, lines: 0, style: .footnote)
    }

    static func assistantParts(_ message: Message, context: ChatCellContext) -> [UIView] {
        var views: [UIView] = []
        var index = 0
        var group = 0
        let parts = message.parts
        while index < parts.count {
            if case .toolStep = parts[index] {
                var steps: [ToolStepPart] = []
                while index < parts.count, case .toolStep(let step) = parts[index] {
                    steps.append(step)
                    index += 1
                }
                views.append(toolSteps(steps, key: "\(message.id):\(group)", context: context))
                group += 1
                continue
            }
            let part = parts[index]
            index += 1
            if part.isHiddenInChat { continue }
            if let view = assistantPart(part, message: message, context: context) { views.append(view) }
        }
        if message.status == .streaming {
            views.append(statusRow(spinner: true, text: "Yazıyor…"))
        } else if message.status == .failed {
            views.append(statusRow(symbol: "exclamationmark.circle", text: "Yanıt yarıda kaldı."))
        } else if message.status == .cancelled {
            views.append(statusRow(symbol: "stop.circle", text: "Yanıt durduruldu."))
        }
        if message.status != .streaming, !message.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            views.append(messageActions(message, context: context))
        }
        return views
    }

    /// Small grey line icons under a finished reply: copy, read aloud, share.
    static func messageActions(_ message: Message, context: ChatCellContext) -> UIView {
        let speaking = MessageSpeaker.shared.speakingId == message.id
        let copy = UIButton.studioIcon("square.on.square", label: "Kopyala", size: 15, tint: IOSTheme.textSecondary) { context.onCopy(message) }
        let speak = UIButton.studioIcon(speaking ? "stop.circle" : "speaker.wave.2", label: speaking ? "Okumayı durdur" : "Sesli oku", size: 15, tint: IOSTheme.textSecondary) {
            context.onSpeak(message)
        }
        let share = UIButton.studioIcon("square.and.arrow.up", label: "Paylaş", size: 15, tint: IOSTheme.textSecondary)
        share.addAction(UIAction { [weak share] _ in
            guard let share else { return }
            context.onShare(message, share)
        }, for: .touchUpInside)
        for button in [copy, speak, share] {
            button.heightAnchor.constraint(equalToConstant: 36).isActive = true
            button.widthAnchor.constraint(equalToConstant: 40).isActive = true
        }
        let row = UIStackView.h([copy, speak, share], spacing: 2)
        // Line the first glyph up with the text edge (the buttons keep 40 pt hit areas).
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: -12),
            row.topAnchor.constraint(equalTo: container.topAnchor, constant: -6),
            row.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
        ])
        return container
    }

    static func assistantPart(_ part: MessagePart, message: Message, context: ChatCellContext) -> UIView? {
        switch part {
        case .text(let text):
            guard !text.isEmpty else { return nil }
            let view = ChatTextView()
            view.attributedText = ChatText.assistant(text, aliases: context.model.state?.aliases ?? [])
            view.onMention = context.onMention
            return view
        case .toolStep(let step):
            return toolStepRow(step)
        case .consent(let consent):
            return consentCard(message: message, consent: consent, context: context)
        case .approvalRequest(let approvalId):
            return ApprovalViews.card(approvalId, app: context.model.app, host: context.host)
        case .question(let question):
            return questionCard(message: message, question: question, context: context)
        case .planProposal(let planId):
            if let plan = context.model.state?.plan(id: planId) { return planCard(plan, context: context) }
            return statusRow(spinner: true, text: "Plan yükleniyor…")
        case .progress(let progress):
            return progressRow(progress)
        case .attachment(let attachment):
            let thumb = attachmentThumb(attachment, size: 180, context: context)
            return UIStackView.h([thumb, UIView.spacer()], spacing: 0)
        case .contentRef(let ref):
            let title = context.model.app.posts.card(ref.contentId)?.title ?? "Postu aç"
            let version = ref.version.map { " · v\($0)" } ?? ""
            let button = UIButton.studioPill(title: "\(title)\(version)", kind: .secondary, image: "square.grid.2x2") { context.onOpenPost(ref) }
            button.accessibilityHint = "Postu açar"
            var views: [UIView] = [button]
            if let note = ref.note, !note.isEmpty { views.append(UILabel.studio(note, size: 13, color: IOSTheme.textSecondary, lines: 2, style: .footnote)) }
            views.append(UIView.spacer())
            return UIStackView.h(views, spacing: 8)
        case .error(let error):
            let card = IOSCardView(padding: 12, spacing: 6, background: IOSTheme.fill)
            card.layer.borderWidth = 0
            card.stack.addArrangedSubview(UIStackView.h([icon("exclamationmark.triangle", IOSTheme.textPrimary), UILabel.studio(error.message, size: 14, lines: 0, style: .subheadline)], spacing: 8, alignment: .top))
            return card
        case .unknown(let type):
            if type == MessagePart.unreadableType { return unreadableLabel() }
            return UILabel.studio("Bu sürümün gösteremediği bir içerik (\(type)).", size: 13, color: IOSTheme.textTertiary, lines: 0, style: .footnote)
        }
    }

    // MARK: Rows

    static func icon(_ name: String, _ color: UIColor, size: CGFloat = 12) -> UIImageView {
        let view = UIImageView(image: UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .semibold)))
        view.tintColor = color
        view.translatesAutoresizingMaskIntoConstraints = false
        view.contentMode = .center
        view.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([view.widthAnchor.constraint(equalToConstant: 18), view.heightAnchor.constraint(equalToConstant: 18)])
        return view
    }

    static func statusRow(spinner: Bool = false, symbol: String? = nil, text: String) -> UIView {
        var views: [UIView] = []
        if spinner {
            let indicator = UIActivityIndicatorView(style: .medium)
            indicator.transform = CGAffineTransform(scaleX: 0.75, y: 0.75)
            indicator.startAnimating()
            views.append(indicator)
        } else if let symbol {
            views.append(icon(symbol, IOSTheme.textSecondary))
        }
        views.append(UILabel.studio(text, size: 13, color: IOSTheme.textSecondary, lines: 2, style: .footnote))
        views.append(UIView.spacer())
        return UIStackView.h(views, spacing: 6)
    }

    /// Consecutive tool steps as one subtle row: the running step (or "N adım") with a
    /// chevron; tapping shows every step. A single step is just its row.
    static func toolSteps(_ steps: [ToolStepPart], key: String, context: ChatCellContext) -> UIView {
        guard steps.count > 1 else { return toolStepRow(steps[0]) }
        let model = context.model
        let expanded = model.expandedSteps.contains(key)
        let running = steps.last { $0.state == .running }
        let failed = steps.contains { $0.state == .error }
        let lead: UIView
        if running != nil {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
            spinner.startAnimating()
            spinner.widthAnchor.constraint(equalToConstant: 18).isActive = true
            lead = spinner
        } else {
            lead = icon(failed ? "exclamationmark.triangle.fill" : "checkmark", failed ? IOSTheme.accent : IOSTheme.textSecondary)
        }
        let title = running?.label ?? (failed ? "\(steps.count) adım · biri hata verdi" : "\(steps.count) adım tamamlandı")
        let label = UILabel.studio(title, size: 13, weight: .medium, color: running == nil ? IOSTheme.textSecondary : IOSTheme.textPrimary, lines: 1, style: .footnote)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let chevron = icon(expanded ? "chevron.down" : "chevron.right", IOSTheme.textTertiary, size: 10)
        let header = UIStackView.h([lead, label, chevron, UIView.spacer()], spacing: 6)
        header.isUserInteractionEnabled = false
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(header)
        header.pin(to: control, insets: UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0))
        control.addAction(UIAction { _ in
            if expanded { model.expandedSteps.remove(key) } else { model.expandedSteps.insert(key) }
            Haptics.selection()
        }, for: .touchUpInside)
        control.isAccessibilityElement = true
        control.accessibilityTraits = .button
        control.accessibilityLabel = title
        control.accessibilityHint = expanded ? "Adımları gizler" : "\(steps.count) adımı gösterir"
        guard expanded else { return control }
        let list = UIStackView.v(steps.map(toolStepRow), spacing: 6)
        list.isLayoutMarginsRelativeArrangement = true
        list.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 0)
        return UIStackView.v([control, list], spacing: 6)
    }

    static func toolStepRow(_ step: ToolStepPart) -> UIView {
        let lead: UIView
        switch step.state {
        case .running:
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
            spinner.startAnimating()
            spinner.widthAnchor.constraint(equalToConstant: 18).isActive = true
            lead = spinner
        case .error:
            lead = icon("exclamationmark.triangle.fill", IOSTheme.accent)
        case .done:
            lead = icon("checkmark", IOSTheme.textSecondary)
        case .unknown:
            lead = icon("circle", IOSTheme.textTertiary, size: 8)
        }
        let label = UILabel.studio(step.label, size: 13, weight: .medium, color: step.state == .done ? IOSTheme.textSecondary : IOSTheme.textPrimary, lines: 2, style: .footnote)
        var views: [UIView] = [lead, label]
        if let summary = step.summary, !summary.isEmpty {
            let summaryLabel = UILabel.studio("· \(summary)", size: 13, color: IOSTheme.textTertiary, lines: 2, style: .footnote)
            summaryLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            views.append(summaryLabel)
        }
        views.append(UIView.spacer())
        let row = UIStackView.h(views, spacing: 6, alignment: .center)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(step.label)\(step.summary.map { ", \($0)" } ?? ""), \(step.state == .running ? "sürüyor" : step.state == .error ? "hata" : "bitti")"
        return row
    }

    static func progressRow(_ progress: ProgressPart) -> UIView {
        let lead: UIView = switch progress.state {
        case .running: {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
            spinner.startAnimating()
            return spinner
        }()
        case .done: icon("checkmark", IOSTheme.textSecondary)
        case .failed: icon("exclamationmark", IOSTheme.accent)
        default: icon("circle", IOSTheme.textTertiary, size: 7)
        }
        var text = progress.label
        if let current = progress.current, let total = progress.total { text += " \(current)/\(total)" }
        var views: [UIView] = [lead, UILabel.studio(text, size: 13, weight: .medium, lines: 2, style: .footnote)]
        if let detail = progress.detail, !detail.isEmpty { views.append(UILabel.studio(detail, size: 13, color: IOSTheme.textSecondary, lines: 2, style: .footnote)) }
        views.append(UIView.spacer())
        return UIStackView.h(views, spacing: 6)
    }

    static func attachmentThumb(_ attachment: AttachmentPart, size: CGFloat, context: ChatCellContext) -> UIView {
        let image = IOSAssetImageView(store: context.images, assetId: attachment.assetId, cornerRadius: 14, displayWidth: size * 1.6)
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(image)
        image.pin(to: control)
        image.isUserInteractionEnabled = false
        let aspect: CGFloat = {
            guard let w = attachment.width, let h = attachment.height, w > 0, h > 0 else { return 1 }
            return min(1.6, max(0.6, CGFloat(w) / CGFloat(h)))
        }()
        NSLayoutConstraint.activate([
            control.heightAnchor.constraint(equalToConstant: size),
            control.widthAnchor.constraint(equalToConstant: size >= 120 ? size * aspect : size),
        ])
        let name = context.model.state?.aliasName(for: attachment) ?? attachment.alias
        if let name {
            let tag = PaddedLabel(text: "@\(name)")
            control.addSubview(tag)
            NSLayoutConstraint.activate([
                tag.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 5),
                tag.bottomAnchor.constraint(equalTo: control.bottomAnchor, constant: -5),
                tag.trailingAnchor.constraint(lessThanOrEqualTo: control.trailingAnchor, constant: -5),
            ])
        }
        control.addAction(UIAction { [weak image] _ in
            if let image { context.onAttachment(attachment, image) }
        }, for: .touchUpInside)
        control.isAccessibilityElement = true
        control.accessibilityTraits = [.image, .button]
        control.accessibilityLabel = "Görsel \(name.map { "@\($0)" } ?? "")"
        return control
    }

    // MARK: Cards

    static func consentCard(message: Message, consent: ConsentPart, context: ChatCellContext) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 8)
        // `install_tool`: the chat agent asks to install a program on the Mac (source and size in the detail).
        let install = consent.tool == "install_tool"
        if consent.state == .pending {
            card.layer.borderColor = IOSTheme.accent.withAlphaComponent(0.6).cgColor
            let eyebrow = UIStackView.h([IOSStatusDotView(color: IOSTheme.accent, size: 7), UILabel.studio(install ? "Mac'e kurulum izni" : "Onayın bekleniyor", size: 12, weight: .semibold, color: IOSTheme.accent, style: .caption1), UIView.spacer()], spacing: 6)
            card.stack.addArrangedSubview(eyebrow)
        }
        card.stack.addArrangedSubview(UILabel.studio(consent.title, size: 16, weight: .semibold, lines: 0, style: .headline))
        if let detail = consent.detail, !detail.isEmpty {
            card.stack.addArrangedSubview(UILabel.studio(detail, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        let busy = context.model.busyConsents.contains(message.id + consent.consentId)
        switch consent.state {
        case .pending:
            let allow = UIButton.studioPill(title: install ? "Kur" : "Bir kez izin ver", kind: .primary) {
                Task { await context.model.decideConsent(message: message, consent: consent, allow: true) }
            }
            allow.configuration?.showsActivityIndicator = busy
            allow.isEnabled = !busy
            let deny = UIButton.studioPill(title: install ? "Kurma" : "Reddet", kind: .secondary) {
                Task { await context.model.decideConsent(message: message, consent: consent, allow: false) }
            }
            deny.isEnabled = !busy
            card.stack.setCustomSpacing(12, after: card.stack.arrangedSubviews.last!)
            card.stack.addArrangedSubview(UIStackView.h([allow, deny, UIView.spacer()], spacing: 8))
        case .allowed:
            card.stack.addArrangedSubview(statusRow(symbol: "checkmark", text: install ? "Kurulum onaylandı" : "İzin verildi"))
        case .denied:
            card.stack.addArrangedSubview(statusRow(symbol: "xmark", text: install ? "Kurulmadı" : "Reddedildi"))
        case .expired, .unknown:
            card.stack.addArrangedSubview(statusRow(symbol: "clock", text: "Yanıtlanmadığı için süresi doldu"))
        }
        return card
    }

    static func questionCard(message: Message, question: QuestionPart, context: ChatCellContext) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio(question.prompt, size: 16, weight: .semibold, lines: 0, style: .headline))
        let key = message.id + question.questionId
        if let answer = question.answer {
            let chosen = question.options.filter { answer.optionIds.contains($0.id) }.map(\.label)
            let text = (chosen + [answer.text].compactMap { $0 }).joined(separator: ", ")
            card.stack.addArrangedSubview(statusRow(symbol: "checkmark", text: text.isEmpty ? "Yanıtlandı" : "Yanıtın: \(text)"))
            return card
        }
        let busy = context.model.busyQuestions.contains(key)
        let picked = context.model.questionSelections[key] ?? []
        let options = UIStackView.v([], spacing: 8, alignment: .leading)
        for option in question.options {
            let selected = picked.contains(option.id)
            let title = question.mode == .multiple ? "\(selected ? "✓ " : "")\(option.label)" : option.label
            let pill = UIButton.studioPill(title: title, kind: selected ? .ink : .secondary) {
                if question.mode == .multiple {
                    context.model.toggleOption(message: message, question: question, optionId: option.id)
                    Haptics.selection()
                } else {
                    Task { await context.model.answer(message: message, question: question, optionIds: [option.id], text: nil) }
                }
            }
            pill.isEnabled = !busy
            pill.configuration?.titleLineBreakMode = .byWordWrapping
            if let description = option.description, !description.isEmpty {
                pill.configuration?.subtitle = description
            }
            options.addArrangedSubview(pill)
        }
        if !question.options.isEmpty { card.stack.addArrangedSubview(options) }
        var actions: [UIView] = []
        if question.allowText || question.mode == .text {
            actions.append(UIButton.studioPill(title: question.mode == .text ? "Yanıt yaz" : "Başka bir şey…", kind: .secondary, image: "text.cursor") {
                context.onAnswerText(message, question)
            })
        }
        if question.mode == .multiple {
            let send = UIButton.studioPill(title: "Gönder", kind: .primary) {
                Task { await context.model.answer(message: message, question: question, optionIds: Array(picked), text: nil) }
            }
            send.isEnabled = !picked.isEmpty && !busy
            actions.append(send)
        }
        if !actions.isEmpty {
            actions.append(UIView.spacer())
            card.stack.addArrangedSubview(UIStackView.h(actions, spacing: 8))
        }
        return card
    }

    static let collapsedPlanItems = 4

    static func planCard(_ plan: Plan, context: ChatCellContext) -> UIView {
        let model = context.model
        let card = IOSCardView(padding: 16, spacing: 10)
        let title = UILabel.studio(plan.title, size: 17, weight: .semibold, lines: 0, style: .headline)
        let period = UILabel.studio("\(TurkishFormat.shortDay(plan.periodStart)) – \(TurkishFormat.shortDay(plan.periodEnd)) · \(plan.items.count) post", size: 13, color: IOSTheme.textSecondary, style: .footnote)
        card.stack.addArrangedSubview(UIStackView.v([title, period], spacing: 2))
        if !plan.summary.isEmpty {
            card.stack.addArrangedSubview(UILabel.studio(plan.summary, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        let expanded = model.expandedPlans.contains(plan.id)
        let items = expanded ? plan.items : Array(plan.items.prefix(collapsedPlanItems))
        let list = UIStackView.v([], spacing: 0)
        for (index, item) in items.enumerated() {
            list.addArrangedSubview(planItemRow(item))
            if index < items.count - 1 {
                let line = UIView()
                line.backgroundColor = IOSTheme.hairline
                line.heightAnchor.constraint(equalToConstant: 1).isActive = true
                list.addArrangedSubview(line)
            }
        }
        card.stack.addArrangedSubview(list)
        if plan.items.count > collapsedPlanItems {
            let toggle = UIButton.studioPill(title: expanded ? "Daha az göster" : "\(plan.items.count - collapsedPlanItems) post daha", kind: .plain) {
                if expanded { model.expandedPlans.remove(plan.id) } else { model.expandedPlans.insert(plan.id) }
            }
            card.stack.addArrangedSubview(UIStackView.h([toggle, UIView.spacer()], spacing: 0))
        }

        let busy = model.busyPlans.contains(plan.id)
        switch plan.status {
        case .draft, .proposed:
            card.stack.addArrangedSubview(UILabel.studio("Planı onaylıyor musun?", size: 15, weight: .medium, style: .subheadline))
            // A plan of hand-made posts is accepted without generation (nothing to make); any
            // other plan offers "Onayla ve üret" first and accepting alone beside it.
            let generates = plan.acceptGeneratesByDefault
            let acceptOnly = UIButton.studioPill(title: "Yalnızca onayla (üretme)", kind: generates ? .secondary : .primary) {
                Task { await model.acceptOnly(plan) }
            }
            acceptOnly.isEnabled = !busy
            acceptOnly.accessibilityHint = "Planı onaylar ve taslak postları açar; post üretimi başlamaz"
            let accept: UIButton
            if generates {
                accept = UIButton.studioPill(title: "Onayla ve üret", kind: .primary) {
                    Task { await model.acceptAndGenerate(plan) }
                }
                accept.accessibilityHint = "Planı bu haliyle onaylar ve postların üretimini başlatır"
            } else {
                accept = acceptOnly
            }
            accept.configuration?.showsActivityIndicator = busy
            accept.isEnabled = !busy
            let edit = UIButton.studioPill(title: "Düzenle", kind: .secondary) { context.onEditPlan(plan) }
            let more = UIButton.studioIcon("ellipsis", label: "Diğer plan işlemleri")
            more.showsMenuAsPrimaryAction = true
            more.menu = UIMenu(children: [
                UIAction(title: "Planı reddet", image: UIImage(systemName: "xmark"), attributes: .destructive) { _ in
                    Task { await model.rejectPlan(plan) }
                },
            ])
            card.stack.addArrangedSubview(UIStackView.h([accept, edit, UIView.spacer(), more], spacing: 8))
            if generates {
                card.stack.addArrangedSubview(UIStackView.h([acceptOnly, UIView.spacer()], spacing: 0))
            }
        case .accepted:
            let accepted = plan.items.filter { $0.status == .accepted }.count
            card.stack.addArrangedSubview(statusRow(symbol: "checkmark", text: "Plan onaylandı · \(accepted) post"))
            if let summary = model.generationSummary(plan) {
                card.stack.addArrangedSubview(UILabel.studio(summary, size: 13, color: IOSTheme.textSecondary, style: .footnote))
            }
            if let note = model.planNotes[plan.id] {
                card.stack.addArrangedSubview(UILabel.studio(note, size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote))
            }
            var actions: [UIView] = []
            if model.canStartGeneration(plan) {
                let generate = UIButton.studioPill(title: "Üretimi başlat", kind: .primary) { Task { await model.generate(plan) } }
                generate.configuration?.showsActivityIndicator = busy
                generate.isEnabled = !busy
                actions.append(generate)
            }
            actions.append(UIButton.studioPill(title: "Postlara git", kind: .secondary) { model.app.open(.posts) })
            actions.append(UIView.spacer())
            card.stack.addArrangedSubview(UIStackView.h(actions, spacing: 8))
        case .rejected:
            card.stack.addArrangedSubview(statusRow(symbol: "xmark", text: "Plan reddedildi\(plan.rejectionReason.map { ": \($0)" } ?? "")"))
        case .superseded:
            card.stack.addArrangedSubview(statusRow(symbol: "arrow.triangle.2.circlepath", text: "Bu planın yerine yenisi önerildi"))
        case .unknown:
            break
        }
        return card
    }

    static func planItemRow(_ item: PlanItem) -> UIView {
        let date = UILabel.studio(item.date.map(TurkishFormat.shortDay) ?? "—", size: 13, color: IOSTheme.textSecondary, style: .footnote)
        date.widthAnchor.constraint(equalToConstant: 52).isActive = true
        let title = UILabel.studio(item.title, size: 15, color: item.status == .skipped ? IOSTheme.textTertiary : IOSTheme.textPrimary, lines: 2, style: .subheadline)
        var views: [UIView] = [date, title, UIView.spacer()]
        if item.status == .skipped {
            views.append(UILabel.studio("atlandı", size: 12, color: IOSTheme.textTertiary, style: .caption1))
        } else if let generation = item.generation {
            let text: String = switch generation.status {
            case .queued: "sırada"
            case .running: "üretiliyor"
            case .succeeded: "hazır"
            case .failed: "üretilemedi"
            case .cancelled: "durduruldu"
            case .unknown: ""
            }
            let tint = generation.status.isActive || generation.status == .failed ? IOSTheme.accent : IOSTheme.textTertiary
            views.append(IOSStatusDotView(color: tint, size: 6))
            views.append(UILabel.studio(text, size: 12, color: IOSTheme.textSecondary, style: .caption1))
        } else if item.isHandMade {
            views.append(UILabel.studio("elle yüklenecek", size: 12, color: IOSTheme.textSecondary, style: .caption1))
        } else if item.imageSlot == .userUpload {
            views.append(IOSStatusDotView(color: IOSTheme.accent, size: 6))
            views.append(UILabel.studio("görsel", size: 12, color: IOSTheme.textSecondary, style: .caption1))
        } else if item.status == .accepted {
            views.append(UILabel.studio("onaylandı", size: 12, color: IOSTheme.textTertiary, style: .caption1))
        }
        let row = UIStackView.h(views, spacing: 8)
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 9, leading: 0, bottom: 9, trailing: 0)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(item.date.map(TurkishFormat.longDay) ?? ""), \(item.title)\(item.imageSlot == .userUpload ? ", görselini sen yükleyeceksin" : "")"
        return row
    }
}

/// Small dark label on images (`@image-1`).
final class PaddedLabel: UILabel {
    init(text: String) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        self.text = text
        font = IOSTheme.font(11, .semibold, style: .caption2)
        textColor = .white
        backgroundColor = UIColor.black.withAlphaComponent(0.55)
        layer.cornerRadius = 7
        layer.masksToBounds = true
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 6, dy: 2)) }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 12, height: size.height + 4)
    }
}
