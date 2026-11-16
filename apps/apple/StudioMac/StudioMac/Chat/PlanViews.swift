import StudioKit
import SwiftUI

/// A plan proposal in the chat: dated rows, then the decision card while it is open.
struct PlanBlock: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    let plan: Plan
    static let collapsedCount = 4

    var body: some View {
        let expanded = model.expandedPlans.contains(plan.id)
        let items = plan.items.sorted { $0.position < $1.position }
        let shown = expanded ? items : Array(items.prefix(Self.collapsedCount))
        VStack(alignment: .leading, spacing: 20) {
            VStack(spacing: 0) {
                ForEach(shown) { item in
                    PlanItemRow(item: item, planStatus: plan.status)
                    Hairline()
                }
                if items.count > Self.collapsedCount {
                    Button {
                        withAnimation(.snappy(duration: 0.25)) {
                            if expanded { model.expandedPlans.remove(plan.id) } else { model.expandedPlans.insert(plan.id) }
                        }
                    } label: {
                        Text(expanded ? "Daha az göster" : "\(items.count - Self.collapsedCount) post daha")
                            .font(Theme.captionFont)
                            .foregroundStyle(Theme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            switch plan.status {
            case .proposed, .draft:
                PlanDecisionCard(model: model, plan: plan)
            case .accepted:
                PlanOutcome(text: "Plan onaylandı · \(plan.items.filter { $0.status == .accepted }.count) post", detail: generationSummary(items))
            case .rejected:
                PlanOutcome(text: "Plan reddedildi", detail: plan.rejectionReason)
            case .superseded:
                PlanOutcome(text: "Bu planın yerine yenisi önerildi", detail: nil)
            case .unknown:
                EmptyView()
            }
        }
    }

    private func generationSummary(_ items: [PlanItem]) -> String? {
        let generations = items.compactMap(\.generation)
        guard !generations.isEmpty else { return "Üretim henüz başlatılmadı." }
        let active = generations.filter { $0.status.isActive }.count
        let done = generations.filter { $0.status == .succeeded }.count
        if active > 0 { return app.isOnline ? "\(active) post üretiliyor" : "\(active) post Mac'i bekliyor" }
        return "\(done) post üretildi"
    }
}

/// `4 Kas   Venta Borinc tanıtım                     ● görsel`
private struct PlanItemRow: View {
    let item: PlanItem
    let planStatus: PlanStatus

    var body: some View {
        HStack(spacing: 0) {
            Text(item.date.map(TurkishFormat.shortDay) ?? "—")
                .font(Theme.smallFont)
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 54, alignment: .leading)
            Text(item.title)
                .font(Theme.rowFont)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 12)
            trailing
        }
        .frame(height: 33)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var trailing: some View {
        if let generation = item.generation {
            HStack(spacing: 5) {
                StatusDot(color: generation.status.isActive ? Theme.accent : Theme.textTertiary, size: 5)
                Text(label(generation.status)).font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            }
        } else if item.imageSlot == .userUpload {
            HStack(spacing: 5) {
                StatusDot(color: Theme.accent, size: 5)
                Text("görsel").font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
            }
            .help("Bu postun görselini sen yükleyeceksin")
        } else if item.status == .skipped {
            Text("atlandı").font(Theme.smallFont).foregroundStyle(Theme.textTertiary)
        }
    }

    private func label(_ status: JobStatus) -> String {
        switch status {
        case .queued: "sırada"
        case .running: "üretiliyor"
        case .succeeded: "hazır"
        case .failed: "hata"
        case .cancelled: "iptal"
        case .unknown: ""
        }
    }
}

/// The question card under an open plan: accept and generate, or ask for changes.
private struct PlanDecisionCard: View {
    let model: ConversationModel
    let plan: Plan

    var body: some View {
        let busy = model.busyPlans.contains(plan.id)
        CardContainer {
            VStack(alignment: .leading, spacing: 10) {
                Text(plan.summary.isEmpty ? "\(plan.items.count) postluk plan hazır. Onaylarsan üretime başlarım." : plan.summary)
                    .font(Theme.captionFont)
                    .foregroundStyle(Theme.textSecondary)
                Text("Planı onaylıyor musun?")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                HStack(spacing: 8) {
                    Button {
                        Task { await model.acceptAndGenerate(plan) }
                    } label: {
                        HStack(spacing: 6) {
                            if busy { ProgressView().controlSize(.mini).tint(.white) }
                            Text("Onayla ve üret")
                        }
                    }
                    .buttonStyle(.pillPrimary)
                    .disabled(busy)
                    .help("Planı bu haliyle (sürüm \(plan.revision)) onayla ve postların üretimini başlat")
                    Button("Düzenle") { model.editPlan(plan) }
                        .buttonStyle(.pillSecondary)
                        .disabled(busy)
                        .help("Ne değişsin, aşağıya yaz; ajan planı günceller")
                }
                .padding(.top, 4)
            }
        }
        .contextMenu {
            Button("Planı reddet") { Task { await model.rejectPlan(plan) } }
        }
    }
}

private struct PlanOutcome: View {
    let text: String
    let detail: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.textSecondary)
            Text(text).font(Theme.captionFont).foregroundStyle(Theme.textPrimary)
            if let detail { Text(detail).font(Theme.captionFont).foregroundStyle(Theme.textSecondary) }
        }
    }
}

/// Rounded hairline card of the drafts (question card).
struct CardContainer<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, 18)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.canvas))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Theme.border))
    }
}

/// A question from the agent: options as pills, optional free text, final once answered.
struct QuestionCard: View {
    let model: ConversationModel
    let message: Message
    let question: QuestionPart
    @State private var selected: Set<String> = []
    @State private var text = ""

    var body: some View {
        let busy = model.busyQuestions.contains(message.id + question.questionId)
        CardContainer {
            VStack(alignment: .leading, spacing: 12) {
                Text(question.prompt)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                if let answer = question.answer {
                    answered(answer)
                } else {
                    if !question.options.isEmpty {
                        FlowLayout(spacing: 8) {
                            ForEach(question.options) { option in
                                Button(option.label) { tap(option) }
                                    .buttonStyle(PillButtonStyle(kind: selected.contains(option.id) ? .primary : .secondary))
                                    .disabled(busy)
                                    .help(option.description ?? "")
                            }
                        }
                    }
                    if question.mode == .text || question.allowText {
                        HStack(spacing: 8) {
                            TextField(question.mode == .text ? "Yanıtın" : "Başka bir şey…", text: $text)
                                .textFieldStyle(.plain)
                                .font(Theme.rowFont)
                                .padding(.horizontal, 12)
                                .frame(height: 30)
                                .background(Capsule().strokeBorder(Theme.border))
                                .onSubmit(submit)
                        }
                    }
                    if question.mode == .multiple || !text.isEmpty {
                        Button("Gönder", action: submit)
                            .buttonStyle(.pillPrimary)
                            .disabled(busy || question.check(optionIds: Array(selected), text: text) != nil)
                    }
                }
            }
        }
    }

    private func tap(_ option: QuestionOption) {
        if question.mode == .single {
            Task { await model.answer(message: message, question: question, optionIds: [option.id], text: nil) }
        } else if selected.contains(option.id) {
            selected.remove(option.id)
        } else {
            selected.insert(option.id)
        }
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { await model.answer(message: message, question: question, optionIds: question.options.map(\.id).filter(selected.contains), text: trimmed.isEmpty ? nil : trimmed) }
    }

    @ViewBuilder
    private func answered(_ answer: QuestionAnswer) -> some View {
        FlowLayout(spacing: 8) {
            ForEach(question.options.filter { answer.optionIds.contains($0.id) }) { option in
                Text(option.label)
                    .font(Theme.buttonFont)
                    .foregroundStyle(Theme.canvas)
                    .padding(.horizontal, 13)
                    .frame(height: 26)
                    .background(Capsule().fill(Theme.ink))
            }
            if let text = answer.text {
                Text(text).font(Theme.rowFont).foregroundStyle(Theme.textPrimary)
            }
        }
        Text("Yanıtlandı").font(Theme.smallFont).foregroundStyle(Theme.textSecondary)
    }
}

/// Wrapping row layout for pills.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: maxX, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + spacing
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
