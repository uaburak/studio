import Foundation
import Testing
@testable import StudioKit

/// Wire shape of the chat agent's parts (task A5, `agent.ts` in the contract).
@Suite("Agent parts")
struct AgentPartsTests {
    private func decodeParts(_ json: String) throws -> [MessagePart] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { d in
            let s = try d.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = f.date(from: s) else { throw DecodingError.dataCorrupted(.init(codingPath: d.codingPath, debugDescription: s)) }
            return date
        }
        return try decoder.decode([MessagePart].self, from: Data(json.utf8))
    }

    @Test func decodesToolStepConsentAndHidesFinishedThinking() throws {
        let parts = try decodeParts("""
        [
          {"type":"progress","stepId":"thinking","label":"Düşündü","state":"done","detail":"3 sn","current":null,"total":null},
          {"type":"progress","stepId":"thinking","label":"Düşünüyor…","state":"running","detail":null,"current":null,"total":null},
          {"type":"tool_step","id":"toolu_1","name":"propose_plan","label":"İçerik planı hazırlandı","state":"done","summary":"9 post önerildi"},
          {"type":"consent","consentId":"consent-1","tool":"schedule_content","title":"Postu zamanla","detail":"Instagram · 20 Kasım 10:00","state":"pending","decidedAt":null},
          {"type":"progress","stepId":"usage-limit","label":"Claude kullanım sınırı doldu","state":"done","detail":null,"current":null,"total":null}
        ]
        """)
        #expect(parts.map(\.isHiddenInChat) == [true, false, false, false, false])
        guard case .toolStep(let step) = parts[2], case .consent(let card) = parts[3] else {
            Issue.record("unexpected parts \(parts)")
            return
        }
        #expect(step.name == "propose_plan" && step.state == .done && step.summary == "9 post önerildi")
        #expect(card.state == .pending && card.decidedAt == nil && card.tool == "schedule_content")
    }
}
