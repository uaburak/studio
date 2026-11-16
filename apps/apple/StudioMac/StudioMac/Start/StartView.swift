import StudioKit
import SwiftUI

/// Empty state (04): "Ne üretelim?", the composer, three suggestions.
struct StartView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let model = app.newChat
        VStack(spacing: 0) {
            Spacer(minLength: 40)
            Text("Ne üretelim?")
                .font(.system(size: 30, weight: .bold))
                .tracking(-0.4)
                .foregroundStyle(Theme.textPrimary)
                .padding(.bottom, 24)
            VStack(alignment: .trailing, spacing: 8) {
                ComposerView(model: model.composer, focusRequest: model.focusRequest, isBusy: model.isCreating) {
                    Task { await model.send() }
                }
                MacStatusView().padding(.trailing, 8)
            }
            .frame(maxWidth: 566)
            .padding(.horizontal, Theme.columnMinMargin)
            if let error = model.error {
                InlineError(message: error) { model.error = nil }
                    .frame(maxWidth: 566)
                    .padding(.top, 12)
            }
            HStack(spacing: 6) {
                ForEach(NewChatModel.suggestions, id: \.self) { suggestion in
                    Button(suggestion) { prefill(suggestion) }
                        .buttonStyle(SuggestionPillStyle())
                }
            }
            .padding(.top, 28)
            Spacer(minLength: 40)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Nothing scrolls here: in dark the toolbar's own background would read as a band.
        .toolbarBackgroundVisibility(colorScheme == .dark ? .hidden : .automatic, for: .windowToolbar)
        .onAppear { model.updatePlaceholder() }
        .onChange(of: app.currentBrandId) { model.updatePlaceholder() }
    }

    private func prefill(_ suggestion: String) {
        let brand = app.brand(app.currentBrandId)?.name.split(separator: " ").first.map(String.init)
        let text = brand.map { "\($0) için \(suggestion.prefix(1).lowercased() + suggestion.dropFirst())" } ?? suggestion
        app.newChat.composer.text = text
        app.newChat.composer.bridge?.setText(text)
        app.newChat.composer.bridge?.focus()
    }
}

/// White pill with a hairline (`Bu ayın postlarını üret`).
struct SuggestionPillStyle: ButtonStyle {
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.buttonFont)
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 14)
            .frame(height: 28)
            .background(Capsule().fill(hovering || configuration.isPressed ? Theme.fill : Theme.canvas))
            .overlay(Capsule().strokeBorder(Theme.border))
            .contentShape(Capsule())
            .onHover { hovering = $0 }
    }
}
