import Foundation
import Testing
@testable import StudioKit

/// Ayarlar → Araçlar: the tools API models, presence `tools`, job labels and the sample backend.
@Suite("Tools: models, presence, sample installs")
struct ToolsTests {
    private static let json = """
    {"tools":[
      {"id":"ffmpeg","label":"ffmpeg","purpose":"Reels","source":"ffmpeg.org","sourceUrl":"https://evermeet.cx","sizeBytes":29000000,
       "state":"installing","version":null,"targetVersion":"7.1","path":null,"location":null,"installable":true,"removable":false,
       "optional":false,"note":null,"error":null,"progress":0.42,"jobId":"j1"},
      {"id":"newtool","label":"Yeni","purpose":"","source":"x","sourceUrl":"","sizeBytes":null,"state":"later","version":"1",
       "targetVersion":null,"path":"/x","location":"elsewhere","installable":false,"removable":false,"optional":true,"note":"n",
       "error":null,"progress":null,"jobId":null}
    ],"online":true,"reportedAt":"2026-11-21T10:00:00.000Z","sent":0}
    """

    @Test func decodesTheListAndToleratesNewValues() throws {
        let control = try StudioJSON.decoder().decode(ToolsControl.self, from: Data(Self.json.utf8))
        #expect(control.online)
        let ffmpeg = try #require(control.tools.first)
        #expect(ffmpeg.statusText == "Kuruluyor… %42")
        #expect(ffmpeg.sourceText == "Kaynak: ffmpeg.org · ~29 MB")
        let other = try #require(control.tools.last)
        #expect(other.state == .unknown && other.location == .unknown && other.toolID == .unknown)
        #expect(!other.canInstall && !other.canRemove)
    }

    @Test func presenceCarriesToolsAndJobsHaveTurkishLabels() throws {
        let presence = try StudioJSON.decoder().decode(WorkerPresence.self, from: Data("""
        {"online":true,"lastSeenAt":null,"workers":[],"currentJobs":[],"queueLength":0,"tools":[]}
        """.utf8))
        #expect(presence.tools == [])
        #expect(JobType.toolInstall.label == "Araç kurulumu")
        #expect(JobType.toolUninstall.label == "Araç kaldırma")
        #expect(ToolStatus.formatSize(1_234_000_000) == "~1,2 GB")
    }

    @Test func actionsFollowStateAndLocation() {
        let base = ToolStatus(id: "chromium", label: "Chromium", purpose: "", source: "s", sourceUrl: "", state: .outdated, location: .studio, installable: true, removable: true)
        #expect(base.canUpdate && base.canRemove && !base.canInstall)
        var system = base
        system.location = .system
        system.state = .installed
        #expect(!system.canUpdate && !system.canRemove)
        var missing = base
        missing.state = .missing
        missing.location = nil
        #expect(missing.canInstall && !missing.canRemove)
    }

    @Test func sampleBackendInstallsUpdatesAndRemoves() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let job = try await backend.installTool("ffmpeg", update: false)
        #expect(job.type == .toolInstall)
        var ffmpeg = try #require(try await backend.tools().tools.first { $0.id == "ffmpeg" })
        #expect(ffmpeg.state == .installed && ffmpeg.location == .studio)
        await #expect(throws: StudioAPIError.self) { _ = try await backend.installTool("ffmpeg", update: false) }
        _ = try await backend.installTool("ffmpeg", update: true)
        _ = try await backend.uninstallTool("ffmpeg")
        ffmpeg = try #require(try await backend.tools().tools.first { $0.id == "ffmpeg" })
        #expect(ffmpeg.state == .missing)
        await #expect(throws: StudioAPIError.self) { _ = try await backend.uninstallTool("claude") }
        await #expect(throws: StudioAPIError.self) { _ = try await backend.installTool("whisper", update: false) }
    }
}
