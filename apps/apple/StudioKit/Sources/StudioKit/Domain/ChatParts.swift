import Foundation

// Display rules for the chat agent's own parts (task A5), shared by the Mac and iOS apps.

public extension MessagePart {
    /// The agent shows a synthetic "Düşünüyor…" step (`progress`, stepId `thinking`) until its
    /// first text or tool call, then marks it done. Done, it is not shown any more.
    var isHiddenInChat: Bool {
        if case .progress(let step) = self, step.stepId == "thinking", step.state != .running {
            return true
        }
        return false
    }
}
