import Foundation
import Testing
@testable import StudioKit

@Suite("Reels: version info, limits, editor draft, render payload")
struct ReelsTests {
    /// A narration reel version stored by the real worker (P6 e2e, private API).
    @Test func readsTheWorkersReelVersion() throws {
        let version = try Fixture.decode(ContentVersion.self, "reel-version")
        let info = ReelVersionInfo(version: version)
        #expect(info.hasVideo)
        #expect(info.recipe == .narration)
        #expect(info.coverAssetId == version.slides[0].renderedAssetId)
        let spec = try #require(info.spec)
        #expect(spec.durationMs == info.durationMs)
        #expect(spec.hook == "Çiçeklenmede bor neden önemli?")
        #expect(spec.words.count > 10)
        #expect(spec.narrationScript.hasPrefix("Çiçeklenme döneminde"))
        #expect(ReelVersionInfo(html: "<main data-artboard>").spec == nil)
    }

    @Test func platformLimits() {
        #expect(ReelLimits.issues(durationMs: 12_000, platforms: [.instagram, .facebook]).isEmpty)
        #expect(ReelLimits.issues(durationMs: 2_000, platforms: [.instagram]) == ["Instagram Reels en az 3 sn olmalı; bu video 2 sn."])
        #expect(ReelLimits.issues(durationMs: 120_000, platforms: [.instagram, .facebook]) == ["Facebook Reels en fazla 90 sn olabilir; bu video 2 dk."])
        #expect(ReelLimits.maxMs([.instagram]) == 90_000)
        #expect(TurkishFormat.clock(ms: 12_400) == "0:12")
        #expect(TurkishFormat.clock(ms: 90_000) == "1:30")
        #expect(TurkishFormat.duration(ms: 1_500) == "1,5 sn")
    }

    @Test func draftSendsOnlyWhatChanged() throws {
        let spec = ReelSpec(
            recipe: .motionGraphics, hook: "Kanca", cta: "MTM",
            scenes: [ReelScene(headline: "Bir", durationMs: 2_000), ReelScene(headline: "İki", durationMs: 3_000)],
            durationMs: 6_800)
        var draft = ReelDraft(spec)
        #expect(draft.patch == nil)
        #expect(draft.totalMs == 6_800)
        draft.scenes[1].durationMs = 2_500
        draft.hook = "  Yeni kanca "
        #expect(draft.totalMs == 6_300)
        let patch = try #require(draft.patch)
        #expect(patch["hook"] == .string("Yeni kanca"))
        #expect(patch["cta"] == nil)
        #expect(patch["scenes"]?.arrayValue?.count == 2)
        #expect(patch["durationMs"] == nil)
        draft.scenes[0].headline = " "
        #expect(draft.problems == ["Sahne 1: başlık boş."])

        let request = ContentRenderRequest.reel(version: 3, patch: patch)
        #expect(request.payload["format"] == .string("mp4"))
        #expect(request.payload["version"] == .number(3))
        #expect(request.payload["reel"]?["hook"] == .string("Yeni kanca"))
    }

    @Test func footageDraftEditsOverlaysAndLength() {
        var draft = ReelDraft(ReelSpec(
            recipe: .footageEdit, hook: "Tarla",
            overlays: [ReelOverlay(text: "Bir", startMs: 2_400, endMs: 5_000)], durationMs: 12_000))
        #expect(draft.editsTotalDuration && !draft.editsSceneDurations)
        draft.addOverlay()
        #expect(draft.overlays.count == 2)
        #expect(draft.overlays[1].startMs == 5_000)
        draft.durationMs = 8_000
        draft.overlays[0].endMs = 1_000
        #expect(draft.problems == ["Metin 1: bitiş başlangıçtan sonra olmalı."])
        draft.overlays[0].endMs = 6_000
        #expect(draft.problems.isEmpty)
        #expect(draft.patch?["durationMs"] == .number(8_000))
    }

    @Test func renderOutputCarriesTheVideo() {
        let output = ContentRenderOutput(["version": .number(4), "videoAssetId": .string("v"), "coverAssetId": .string("c"), "renderedAssetIds": .array([.string("c")])])
        #expect(output.version == 4)
        #expect(output.videoAssetId == "v")
        #expect(output.coverAssetId == "c")
    }
}
