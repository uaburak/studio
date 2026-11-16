import Foundation

/// Frames of `GET /api/jobs/stream` (contract: `JobStreamMessage` in
/// packages/contract/src/protocol.ts). The OpenAPI document does not describe
/// WebSocket frames, so this mirrors the zod schema directly.
enum JobStreamMessage: Sendable, Equatable {
    /// First frame after every (re)connect; replaces local state.
    case snapshot(jobs: [Job], presence: WorkerPresence)
    case jobUpdated(Job)
    case presence(WorkerPresence)
    case pong(ts: Double)

    private struct Envelope: Decodable { var type: String }
    private struct Snapshot: Decodable { var jobs: [Job]; var presence: WorkerPresence }
    private struct Updated: Decodable { var job: Job }
    private struct Presence: Decodable { var presence: WorkerPresence }
    private struct Pong: Decodable { var ts: Double }

    enum DecodeError: Error, Equatable {
        case unknownType(String)
        case invalid(String)
    }

    /// Decode one text frame. Unknown frame types are reported, not fatal:
    /// the stream ignores them so a newer server cannot break old clients.
    static func decode(_ text: String) throws(DecodeError) -> JobStreamMessage {
        let data = Data(text.utf8)
        let decoder = StudioJSON.decoder()
        do {
            let type = try decoder.decode(Envelope.self, from: data).type
            switch type {
            case "jobs.snapshot":
                let frame = try decoder.decode(Snapshot.self, from: data)
                return .snapshot(jobs: frame.jobs, presence: frame.presence)
            case "job.updated":
                return .jobUpdated(try decoder.decode(Updated.self, from: data).job)
            case "presence":
                return .presence(try decoder.decode(Presence.self, from: data).presence)
            case "pong":
                return .pong(ts: try decoder.decode(Pong.self, from: data).ts)
            default:
                throw DecodeError.unknownType(type)
            }
        } catch let error as DecodeError {
            throw error
        } catch {
            throw DecodeError.invalid(String(describing: error))
        }
    }

    /// Client → server keep-alive; the hub answers with `pong`.
    static func ping(at date: Date = .now) -> String {
        "{\"type\":\"ping\",\"ts\":\(Int64(date.timeIntervalSince1970 * 1000))}"
    }
}
