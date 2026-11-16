import StudioKit
import SwiftUI

/// Marks the runs of a `Text` that are mentions.
struct MentionRunAttribute: TextAttribute {}

/// Draws a neutral capsule behind mention runs (`@image-1`), then the text.
struct MentionPillRenderer: TextRenderer {
    var fill: Color

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line {
                if run[MentionRunAttribute.self] != nil {
                    let bounds = run.typographicBounds.rect.insetBy(dx: -1, dy: 0)
                    let pill = CGRect(x: bounds.minX, y: bounds.minY - 1, width: bounds.width, height: bounds.height + 2)
                    context.fill(Capsule().path(in: pill), with: .color(fill))
                }
                context.draw(run)
            }
        }
    }
}

/// Message text with mention pills. A mention is a link (`studio-mention://<aliasId>`)
/// so clicking it can show the image.
struct MentionedText: View {
    var text: String
    var mentions: [MessageMention]
    /// Current alias name by alias id (a renamed alias shows its new name).
    var currentName: (MessageMention) -> String
    var font: Font = Theme.chatFont

    var body: some View {
        let segments = MentionText.segments(text, mentions: mentions)
        segments.reduce(Text(verbatim: "")) { result, segment in
            switch segment {
            case .text(let string):
                return Text("\(result)\(Text(verbatim: string))")
            case .mention(let mention):
                var label = AttributedString("\u{2009}@\(currentName(mention))\u{2009}")
                label.link = URL(string: "studio-mention://\(mention.aliasId)")
                label.font = .system(size: 13, weight: .medium)
                return Text("\(result)\(Text(label).customAttribute(MentionRunAttribute()))")
            }
        }
        .font(font)
        .foregroundStyle(Theme.textPrimary)
        .tint(Theme.textPrimary)
        .lineSpacing(3)
        .textRenderer(MentionPillRenderer(fill: Theme.fillStrong))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
}
