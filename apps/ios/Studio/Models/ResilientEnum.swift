import Foundation

/// A string enum mirrored from the contract that decodes values it does not
/// know (added by a newer server) as `unknown` instead of failing the whole
/// response. `unknown` is never sent back to the server.
protocol ResilientEnum: RawRepresentable, Codable, Hashable, Sendable, CaseIterable where RawValue == String {
    static var unknown: Self { get }
}

extension ResilientEnum {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.unknown
    }

    /// Every case the server defines (for pickers and filters).
    static var knownCases: [Self] { allCases.filter { $0 != unknown } }
}
