import Foundation
import Observation

/// Binds an `@Observable` read/render closure in AppKit views and view controllers.
///
/// Calls `apply()` immediately on the main actor while tracking every `@Observable`
/// property read inside it. When any tracked property changes, schedules a single
/// coalesced re-run on the main actor's next turn. Cancels automatically on `deinit`.
@MainActor
final class ObservationToken {
    private var cancelled = false
    private var scheduled = false
    private var applyBlock: (@MainActor () -> Void)?

    init(_ apply: @escaping @MainActor () -> Void) {
        self.applyBlock = apply
        run()
    }

    private func run() {
        guard !cancelled, let apply = applyBlock else { return }
        scheduled = false
        withObservationTracking {
            apply()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.cancelled, !self.scheduled else { return }
                self.scheduled = true
                await Task.yield()
                self.run()
            }
        }
    }

    func cancel() {
        cancelled = true
        applyBlock = nil
    }

    deinit {
        // Safe to flip from nonisolated deinit: `applyBlock` only runs on MainActor
        // and checks `weak self` before executing.
    }
}

@MainActor
func observe(_ apply: @escaping @MainActor () -> Void) -> ObservationToken {
    ObservationToken(apply)
}

extension NSObject {
    @MainActor
    func observe(_ apply: @escaping @MainActor () -> Void) -> ObservationToken {
        ObservationToken(apply)
    }
}
