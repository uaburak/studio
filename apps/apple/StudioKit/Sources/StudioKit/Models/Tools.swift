import Foundation

// Mirrors packages/contract/src/tools.ts: the programs Studio uses on the Mac (Ayarlar → Araçlar),
// installed from their official sources by the worker (`tool.install` / `tool.uninstall` jobs).

/// `ToolId` (open: newer Macs may report more tools).
public enum ToolID: String, OpenEnum {
    case claude, gemini, chromium, ffmpeg, python, cloudflared, whisper
    case unknown
}

/// `ToolState`.
public enum ToolState: String, OpenEnum {
    case installed, missing, outdated, installing, failed
    case unknown

    public var label: String {
        switch self {
        case .installed: "Kurulu"
        case .missing: "Kurulu değil"
        case .outdated: "Güncelleme var"
        case .installing: "Kuruluyor…"
        case .failed: "Kurulamadı"
        case .unknown: "Bilinmiyor"
        }
    }
}

/// `ToolStatus`: one tool as the Mac's worker last saw it.
public struct ToolStatus: Codable, Sendable, Hashable, Identifiable {
    public enum Location: String, OpenEnum {
        case studio, system
        case unknown
    }

    /// The raw id (kept verbatim, so an unknown tool can still be installed by id).
    public var id: String
    public var label: String
    public var purpose: String
    public var source: String
    public var sourceUrl: String
    public var sizeBytes: Int?
    public var state: ToolState
    public var version: String?
    public var targetVersion: String?
    public var path: String?
    public var location: Location?
    public var installable: Bool
    public var removable: Bool
    public var optional: Bool
    public var note: String?
    public var error: String?
    /// 0...1 while installing.
    public var progress: Double?
    public var jobId: String?

    public init(
        id: String, label: String, purpose: String, source: String, sourceUrl: String, sizeBytes: Int? = nil,
        state: ToolState, version: String? = nil, targetVersion: String? = nil, path: String? = nil,
        location: Location? = nil, installable: Bool = true, removable: Bool = false, optional: Bool = false,
        note: String? = nil, error: String? = nil, progress: Double? = nil, jobId: String? = nil
    ) {
        self.id = id
        self.label = label
        self.purpose = purpose
        self.source = source
        self.sourceUrl = sourceUrl
        self.sizeBytes = sizeBytes
        self.state = state
        self.version = version
        self.targetVersion = targetVersion
        self.path = path
        self.location = location
        self.installable = installable
        self.removable = removable
        self.optional = optional
        self.note = note
        self.error = error
        self.progress = progress
        self.jobId = jobId
    }

    public var toolID: ToolID { ToolID(rawValue: id) ?? .unknown }

    /// "~29 MB" / "~1,2 GB"; nil when the size is decided at install time.
    public var sizeText: String? {
        guard let sizeBytes else { return nil }
        return Self.formatSize(sizeBytes)
    }

    public static func formatSize(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1_000_000
        if mb >= 1000 {
            let gb = (mb / 100).rounded() / 10
            return "~\(String(format: "%.1f", gb).replacingOccurrences(of: ".", with: ",")) GB"
        }
        return "~\(max(1, Int(mb.rounded()))) MB"
    }

    /// "Studio'nun kopyası" / "Mac'te zaten kurulu".
    public var locationText: String? {
        switch location {
        case .studio: "Studio'nun kopyası"
        case .system: "Mac'te zaten kurulu"
        case .unknown, nil: nil
        }
    }

    /// One status line: state, version, where it lives, progress.
    public var statusText: String {
        switch state {
        case .installing:
            if let progress { return "Kuruluyor… %\(Int((progress * 100).rounded()))" }
            return "Kuruluyor…"
        case .failed:
            return error.map { "Kurulamadı: \($0)" } ?? "Kurulamadı"
        case .outdated:
            let versions = [version, targetVersion.map { "→ \($0)" }].compactMap { $0 }.joined(separator: " ")
            return versions.isEmpty ? "Güncelleme var" : "Güncelleme var · \(versions)"
        case .installed:
            return [version.map { "Kurulu · \($0)" } ?? "Kurulu", locationText].compactMap { $0 }.joined(separator: " · ")
        case .missing, .unknown:
            return state.label
        }
    }

    /// "Kaynak: Anthropic (claude.ai) · ~29 MB".
    public var sourceText: String {
        ["Kaynak: \(source)", sizeText].compactMap { $0 }.joined(separator: " · ")
    }

    /// "Kur" can run (missing or failed, installable).
    public var canInstall: Bool { installable && (state == .missing || state == .failed) }
    /// "Güncelle": Studio's own copy is older than the pinned version.
    public var canUpdate: Bool { installable && state == .outdated && location != .system }
    /// "Kaldır": Studio's own copy (a copy already on the Mac is never touched).
    public var canRemove: Bool { removable && location == .studio && state != .installing }
}

/// `ToolsControl`: `GET /api/tools` and the answer of `POST /api/tools/refresh`.
public struct ToolsControl: Codable, Sendable, Hashable {
    public var tools: [ToolStatus]
    /// The Mac worker is connected (installs can run).
    public var online: Bool
    public var reportedAt: Date?
    public var sent: Int

    public init(tools: [ToolStatus], online: Bool, reportedAt: Date? = nil, sent: Int = 0) {
        self.tools = tools
        self.online = online
        self.reportedAt = reportedAt
        self.sent = sent
    }
}

/// `POST /api/tools/{id}/install` body.
public struct ToolInstallRequest: Encodable, Sendable, Hashable {
    public var update: Bool?
    public init(update: Bool? = nil) { self.update = update }
}

extension APIClient {
    /// `GET /api/tools`.
    public func tools() async throws(StudioAPIError) -> ToolsControl {
        try await get(ToolsControl.self, "/api/tools")
    }

    /// `POST /api/tools/refresh` (409 while the worker is offline).
    public func refreshTools() async throws(StudioAPIError) -> ToolsControl {
        try await send(ToolsControl.self, .post, "/api/tools/refresh")
    }

    /// `POST /api/tools/{id}/install` → the `tool.install` job (202).
    public func installTool(_ id: String, update: Bool = false) async throws(StudioAPIError) -> Job {
        try await send(Job.self, .post, "/api/tools/\(Self.enc(id))/install", body: ToolInstallRequest(update: update ? true : nil))
    }

    /// `POST /api/tools/{id}/uninstall` → the `tool.uninstall` job (202).
    public func uninstallTool(_ id: String) async throws(StudioAPIError) -> Job {
        try await send(Job.self, .post, "/api/tools/\(Self.enc(id))/uninstall")
    }
}
