import Foundation

/// Remote data plus how fetching it went. Keeps the last value while
/// reloading, so a refresh never blanks the screen.
struct Loadable<Value> {
    var value: Value?
    var error: APIError?
    var isLoading = false

    enum Phase {
        case loading
        case loaded(Value)
        case failed(APIError)
    }

    var phase: Phase {
        if let value { return .loaded(value) }
        if let error, !isLoading { return .failed(error) }
        return .loading
    }

    mutating func begin() {
        isLoading = true
    }

    mutating func succeed(_ value: Value) {
        self.value = value
        error = nil
        isLoading = false
    }

    mutating func fail(_ error: APIError) {
        isLoading = false
        // A cancelled request (view went away, pull-to-refresh restarted) is not an error state.
        if error != .cancelled { self.error = error }
    }
}

extension Loadable: Equatable where Value: Equatable {}
extension Loadable: Sendable where Value: Sendable {}
