import Foundation
import Testing
@testable import StudioKit

/// Audit phase 6 (iPhone): canvas versions (M1), system fonts in the kit (M2), production
/// checks and the approval guard (M3, E7), unreadable conversation frames (M4).
@Suite("Phone audit: canvas, kit fonts, checks, unreadable frames")
@MainActor
struct PhoneAuditTests {
    // MARK: M1 — canvas versions

    static func canvasHTML(sourceVersion: Int?, extra: String = "") -> String {
        """
        <!doctype html>
        <html lang="tr">
        <head>
          <meta charset="utf-8">
          <meta name="studio:contract" content="v1">
          <meta name="studio:format" content="1080x1350">
          <meta name="studio:editor" content="wecra">
          <meta name="studio:render" content="sha256:abc">\(sourceVersion.map { "\n  <meta name=\"studio:source-version\" content=\"\($0)\">" } ?? "")
        </head>
        <body>
          <main data-artboard style="width:1080px;height:1350px">
            <img data-layer="canvas" data-type="image" data-role="background" src="/media/r1.png" alt="Başlık" style="position:absolute;left:0;top:0;width:1080px;height:1350px">
            \(extra)
          </main>
        </body>
        </html>
        """
    }

    @Test func detectsCanvasVersionsLikeTheDesktop() {
        #expect(CanvasOrigin(html: Self.canvasHTML(sourceVersion: 4)) == CanvasOrigin(sourceVersion: 4))
        #expect(CanvasOrigin(html: Self.canvasHTML(sourceVersion: nil)) == CanvasOrigin(sourceVersion: nil))
        // The newer canvas HTML adds a facts meta (JSON) and readable layers; still a canvas render.
        let withFacts = Self.canvasHTML(sourceVersion: 3, extra: #"<h1 data-layer="t1" data-type="text" style="color:transparent">Başlık</h1>"#)
            .replacingOccurrences(of: "</head>", with: #"<meta name="studio:canvas" content="{&quot;texts&quot;:[&quot;a &gt; b&quot;]}"></head>"#)
        #expect(CanvasOrigin(html: withFacts)?.sourceVersion == 3)
        // Attribute order and quotes do not matter.
        #expect(CanvasOrigin(html: "<head><meta content='wecra' name='studio:editor'><meta content=\"7\" name=\"studio:source-version\"></head>")?.sourceVersion == 7)
        // Plain design-kit HTML, or the marker only in the body text, is not a canvas render.
        #expect(CanvasOrigin(html: #"<html><head><meta name="studio:contract" content="v1"></head><body><h1 data-layer="title">A</h1></body></html>"#) == nil)
        #expect(CanvasOrigin(html: #"<html><head></head><body><p>studio:editor wecra</p></body></html>"#) == nil)
    }

    @Test func revisionRequestMirrorsTheDesktopReference() {
        let origin = CanvasOrigin(sourceVersion: 4)
        let request = origin.revisionRequest(version: 7, instruction: "Başlığı küçült")
        #expect(request.baseVersion == 4)
        // chat.ts `postReference`, word for word.
        #expect(request.instructions == "(v7 tuvalde, Wecra ile düzenlendi: kareleri Wecra'nın render'ı; HTML'de render en altta, metinler, görsel yuvaları ve logolar üstünde görünmez katmanlar, tüm katmanlar studio:canvas bilgisinde. Metin ve katman değişikliklerini v4 HTML'si üzerinden yap; yeni sürüm tuvale yeniden aktarılır.)\nBaşlığı küçült")
        let noSource = CanvasOrigin(sourceVersion: nil).revisionRequest(version: 2, instruction: "Daha sade")
        #expect(noSource.baseVersion == nil)
        #expect(noSource.instructions == "(v2 tuvalde, Wecra ile düzenlendi: kareleri Wecra'nın render'ı; HTML'de render en altta, metinler, görsel yuvaları ve logolar üstünde görünmez katmanlar, tüm katmanlar studio:canvas bilgisinde. Değişikliği yeni bir HTML sürümüyle yap; yeni sürüm tuvale yeniden aktarılır.)\nDaha sade")
    }

    private func canvasSession(extra: String = "") async throws -> (PostEditSession, SampleBackend) {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let original = try await backend.version(contentId: "post-02a", version: 1)
        let canvas = try await backend.storeVersion(
            contentId: "post-02a",
            slides: original.slides.map { Slide(html: Self.canvasHTML(sourceVersion: 1, extra: extra), width: $0.width, height: $0.height, renderedAssetId: "r1") })
        let content = try await backend.content("post-02a")
        #expect(content.currentVersion?.version == canvas.version)
        let session = PostEditSession(service: backend, card: PostCard(content: content, version: canvas))
        session.pollInterval = .milliseconds(5)
        await session.load()
        await session.waitUntilIdle()
        return (session, backend)
    }

    @Test func canvasVersionsAreReadOnlyOnThePhone() async throws {
        // Even with readable text and slot layers in the HTML (transparent semantic layers).
        let (session, backend) = try await canvasSession(extra: #"<h1 data-layer="title" data-type="text" style="opacity:0">Başlık</h1><div data-layer="photo" data-type="slot" style="opacity:0"></div>"#)
        #expect(session.isCanvasVersion)
        #expect(session.canvasOrigin?.sourceVersion == 1)
        #expect(session.editBlocker == CanvasOrigin.editNote)
        #expect(!session.canEdit)
        let before = try await backend.versions(contentId: "post-02a").count

        session.setText("title", "Yeni")
        #expect(session.error == CanvasOrigin.editNote)
        session.error = nil
        session.setHidden("canvas", true)
        #expect(session.error == CanvasOrigin.editNote)
        session.error = nil
        session.placeImage(UploadFile(filename: "a.jpg", mimeType: "image/jpeg", data: Data([1])), into: "canvas")
        #expect(session.error == CanvasOrigin.editNote)
        session.error = nil
        session.fillSlot(with: UploadFile(filename: "a.jpg", mimeType: "image/jpeg", data: Data([1])))
        #expect(session.error == CanvasOrigin.editNote)
        session.move("canvas", by: CGSize(width: 10, height: 0))
        await session.waitUntilIdle()
        #expect(try await backend.versions(contentId: "post-02a").count == before)
        #expect(session.activity == .idle)
        // Caption editing stays available.
        session.captionDraft = "Tuvalden sonra yeni açıklama"
        #expect(await session.saveCaption())
    }

    @Test func canvasAIRequestGoesToTheSourceVersionWithTheMacsNote() async throws {
        let (session, backend) = try await canvasSession()
        let canvasVersion = try #require(session.activeVersion?.version)
        session.instruction = "Başlığı büyüt"
        await session.sendInstruction()
        #expect(session.error == nil)
        let job = try #require(try await backend.jobs(brandId: nil).first { $0.type == .contentGenerate && $0.payload["instructions"]?.stringValue?.hasSuffix("Başlığı büyüt") == true })
        #expect(job.payload["baseVersion"] == .number(1))
        let instructions = try #require(job.payload["instructions"]?.stringValue)
        #expect(instructions.hasPrefix("(v\(canvasVersion) tuvalde, Wecra ile düzenlendi:"))
        #expect(instructions.contains("v1 HTML'si üzerinden yap"))
        #expect(instructions.hasSuffix("\nBaşlığı büyüt"))
        // The revision (an HTML version) is adopted and editable again.
        #expect(session.content.currentVersion?.version == canvasVersion + 1)
        #expect(!session.isCanvasVersion)
        #expect(session.undoStack.last == PostEditSession.EditStep(before: canvasVersion, after: canvasVersion + 1, name: "AI düzenlemesi"))
    }

    @Test func plainVersionsStillReviseThemselves() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let content = try await backend.content("post-02a")
        let version = try await backend.version(contentId: "post-02a", version: 1)
        let session = PostEditSession(service: backend, card: PostCard(content: content, version: version))
        session.pollInterval = .milliseconds(5)
        #expect(!session.isCanvasVersion)
        session.instruction = "Daha sade"
        await session.sendInstruction()
        let job = try #require(try await backend.jobs(brandId: nil).first { $0.type == .contentGenerate && $0.payload["instructions"] == .string("Daha sade") })
        #expect(job.payload["baseVersion"] == .number(1))
    }

    @Test func canvasCardsAreFlagged() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let content = try await backend.content("post-02a")
        let plain = try await backend.version(contentId: "post-02a", version: 1)
        #expect(!PostCard(content: content, version: plain).isCanvasVersion)
        var canvas = plain
        canvas.slides = canvas.slides.map { Slide(html: Self.canvasHTML(sourceVersion: nil), width: $0.width, height: $0.height) }
        #expect(PostCard(content: content, version: canvas).isCanvasVersion)
    }

    // MARK: M2 — system fonts

    @Test func kitDecodesSystemFontsAndRoundTripsThem() throws {
        let json = #"""
        {"brandId":"b1","logos":[],"palette":[],"samples":[],"notes":"","updatedAt":"2026-11-16T10:00:00.000Z",
         "fonts":[
           {"assetId":"f1","family":"Archivo","role":"display","licenseNote":"SIL OFL"},
           {"source":"system","family":"Avenir Next","role":"text","styles":[
              {"name":"Regular","weight":400,"italic":false,"postscriptName":"AvenirNext-Regular"},
              {"name":"Demi Bold Italic","weight":600,"italic":true}],"licenseNote":""}
         ]}
        """#
        let kit = try StudioJSON.decoder().decode(BrandKit.self, from: Data(json.utf8))
        #expect(kit.fonts.count == 2)
        #expect(kit.fonts[0].source == .file && kit.fonts[0].assetId == "f1" && kit.fonts[0].styles.isEmpty)
        let system = kit.fonts[1]
        #expect(system.isSystem && system.assetId == nil)
        #expect(system.styles.map(\.name) == ["Regular", "Demi Bold Italic"])
        #expect(system.styles[1].italic && system.styles[1].postscriptName == nil)
        #expect(system.key == "system:avenir next")
        #expect(kit.assetIds == ["f1"])

        // The PUT body keeps source and styles (a save from the Mac app no longer wipes them).
        let body = try JSONSerialization.jsonObject(with: StudioJSON.encoder().encode(kit.put)) as? [String: Any]
        let fonts = try #require(body?["fonts"] as? [[String: Any]])
        #expect(fonts[0]["source"] as? String == "file")
        #expect(fonts[0]["assetId"] as? String == "f1")
        #expect(fonts[1]["source"] as? String == "system")
        #expect(fonts[1]["assetId"] == nil)
        let styles = try #require(fonts[1]["styles"] as? [[String: Any]])
        #expect(styles.count == 2)
        #expect(styles[0]["postscriptName"] as? String == "AvenirNext-Regular")
        #expect(styles[1]["weight"] as? Int == 600)
        let again = try StudioJSON.decoder().decode(BrandKitPut.self, from: StudioJSON.encoder().encode(kit.put))
        #expect(again.fonts == kit.fonts)

        // A source this build does not know survives too.
        let future = try StudioJSON.decoder().decode(BrandKitFont.self, from: Data(#"{"source":"cloud","family":"Inter"}"#.utf8))
        #expect(future.source.rawValue == "cloud")
        let encoded = try JSONSerialization.jsonObject(with: StudioJSON.encoder().encode(future)) as? [String: Any]
        #expect(encoded?["source"] as? String == "cloud")
    }

    // MARK: M3 / E7 — production checks

    static func run(contentId: EntityID = "post-02a", version: Int, _ results: [ContentCheckResult], strictness: CheckStrictness = .standard) -> ContentCheckRun {
        ContentCheckRun(id: "run-\(version)-\(results.count)", contentId: contentId, brandId: SampleData.mtm, version: version, strictness: strictness, results: results, createdAt: .now)
    }

    @Test func decodesCheckRunsFromTheAPI() async throws {
        let page = #"""
        {"items":[{"id":"r1","contentId":"c1","brandId":"b1","version":3,"versionId":"v3","trigger":"generate","jobId":"j1",
          "strictness":"standard","summary":{"pass":1,"warn":1,"fail":1,"fixed":0,"skipped":1},"blocking":1,
          "results":[
            {"checkId":"layout.overflow","category":"layout","status":"fail","message":"Başlık kutusuna sığmıyor.","refs":[{"slide":1,"layer":"headline"}],"evidence":{"px":72},"source":"deterministic","fixable":true},
            {"checkId":"text.language","category":"text","status":"warn","message":"Yazım hatası.","refs":[],"evidence":null,"source":"model","fixable":false},
            {"checkId":"visual.new-check","category":"visual","status":"skipped","message":"","refs":[],"evidence":null,"source":"deterministic","fixable":false},
            {"checkId":"brief.completeness","category":"brief","status":"pass","message":"","refs":[],"evidence":null,"source":"deterministic","fixable":false}],
          "model":"haiku","fromVersion":null,"fixedVersion":null,"note":"","createdAt":"2026-11-16T10:00:00.000Z"}],"nextCursor":null}
        """#
        let host = uniqueHost()
        let api = APIClient(baseURL: URL(string: "http://\(host):8787/")!, auth: NoAuth(), session: StubURLProtocol.session(host: host) { request, _ in
            if request.httpMethod == "POST" {
                return .init(status: 201, body: Data(#"{"id":"j1","type":"content.check","status":"queued","payload":{"version":3},"brandId":"b1","contentId":"c1","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}"#.utf8))
            }
            return .init(status: 200, body: Data(page.utf8))
        })
        let run = try #require(try await api.latestCheckRun(contentId: "c1", version: 3))
        let request = try #require(StubURLProtocol.recorded(host: host).first?.0)
        #expect(request.url?.path == "/api/contents/c1/checks")
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.contains(URLQueryItem(name: "version", value: "3")))
        #expect(query.contains(URLQueryItem(name: "limit", value: "1")))
        #expect(run.blocking == 1 && run.summary.fail == 1)
        #expect(ContentChecks.groups(run).map(\.title) == ["Başarısız", "Uyarı", "Geçti", "Atlandı"])
        #expect(ContentChecks.label("layout.overflow") == "Metin taşması")
        #expect(ContentChecks.label("visual.new-check") == "visual.new-check")
        #expect(ContentChecks.placeLabel(run.results[0]) == "Slayt 2 · headline")
        #expect(ContentChecks.placeLabel(run.results[1]) == "Açıklama")
        #expect(ContentChecks.summaryText(run) == "1 başarısız · 1 uyarı · 1 geçti · 1 atlandı")

        _ = try await api.runChecks(contentId: "c1", brandId: "b1", version: 3)
        let (jobRequest, body) = try #require(StubURLProtocol.recorded(host: host).last)
        #expect(jobRequest.url?.path == "/api/jobs")
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(json?["type"] as? String == "content.check")
        #expect(json?["contentId"] as? String == "c1")
        #expect((json?["payload"] as? [String: Any])?["version"] as? Int == 3)
    }

    @Test func approvalGateAsksBeforeApprovingProblems() {
        let fail = ContentCheckResult(checkId: "layout.overflow", category: .layout, status: .fail, message: "Taşıyor.")
        let warn = ContentCheckResult(checkId: "text.language", category: .text, status: .warn, message: "Yazım.")
        let pass = ContentCheckResult(checkId: "brief.completeness", category: .brief, status: .pass, message: "")

        #expect(ContentChecks.gate(run: Self.run(version: 2, [pass, warn]), version: 2, running: false) == .clear)
        let problems = ContentChecks.gate(run: Self.run(version: 2, [fail, warn, pass]), version: 2, running: false)
        #expect(problems.question?.title == "Kontrollerde 1 sorun var. Yine de onaylansın mı?")
        #expect(problems.question?.message == "Metin taşması: Taşıyor.")
        // Strict: warnings hold approval back too.
        let strict = ContentChecks.gate(run: Self.run(version: 2, [fail, warn], strictness: .strict), version: 2, running: false)
        #expect(strict.question?.title == "Kontrollerde 2 sorun var. Yine de onaylansın mı?")
        #expect(ContentChecks.gate(run: nil, version: 2, running: true) == .running)
        #expect(ContentChecks.gate(run: Self.run(version: 2, [pass]), version: 2, running: true).question != nil)
        // No run (or only a run of another version): say so.
        #expect(ContentChecks.gate(run: nil, version: 3, running: false) == .notChecked(version: 3))
        #expect(ContentChecks.gate(run: Self.run(version: 2, [pass]), version: 3, running: false) == .notChecked(version: 3))
        #expect(ContentChecks.ApprovalGate.notChecked(version: 3).question?.title == "v3 henüz kontrol edilmedi. Yine de onaylansın mı?")
    }

    @Test func approvalRefusedForChecksIsShown() {
        let refused = StudioAPIError.server(status: 409, code: .conflict, message: "version 3 has 2 failing checks", issues: [])
        #expect(ContentChecks.approvalRefusal(refused) == "Mac onaylamadı: kontrollerde sorun var. (version 3 has 2 failing checks)")
        #expect(ContentChecks.approvalRefusal(StudioAPIError.server(status: 409, code: .unknown, message: "Kontroller geçmedi", issues: [])) != nil)
        #expect(ContentChecks.approvalRefusal(StudioAPIError.server(status: 409, code: .hashMismatch, message: "check the hash", issues: [])) == nil)
        #expect(ContentChecks.approvalRefusal(StudioAPIError.server(status: 409, code: .invalidTransition, message: "content is scheduled", issues: [])) == nil)
        #expect(ContentChecks.approvalRefusal(StudioAPIError.offline) == nil)
    }

    @Test func sessionReadsRunsAndRerunsChecks() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let content = try await backend.content("post-02a")
        let version = try await backend.version(contentId: "post-02a", version: 1)
        let session = PostEditSession(service: backend, card: PostCard(content: content, version: version))
        session.pollInterval = .milliseconds(5)
        await session.load()
        await session.waitUntilIdle()
        #expect(session.checkRun == nil && session.checkRunVersion == 1)
        #expect(await session.approvalGate() == .notChecked(version: 1))

        // A check job of this post is running (job feed).
        let running = Job(id: "j-check", type: .contentCheck, status: .running, contentId: "post-02a", createdAt: .now, updatedAt: .now)
        session.noteJob(running)
        #expect(session.checksRunning)
        #expect(await session.approvalGate() == .running)
        var finished = running
        finished.status = .succeeded
        session.noteJob(finished)
        #expect(!session.checksRunning)

        await backend.storeCheckRun(Self.run(version: 1, [ContentCheckResult(checkId: "layout.overflow", category: .layout, status: .fail, message: "Taşıyor.")]))
        guard case .problems(let run) = await session.approvalGate() else {
            Issue.record("problems expected")
            return
        }
        #expect(run.blocking == 1)
        #expect(session.checkRun?.id == run.id)

        // "Yeniden kontrol et": the sample checks pass at once.
        await session.runChecks()
        await session.loadChecks()
        #expect(session.checkRun?.blocking == 0)
        #expect(await session.approvalGate() == .clear)
        #expect(try await backend.jobs(brandId: nil).contains { $0.type == .contentCheck && $0.payload["version"] == .number(1) })
    }

    @Test func jobLabelsCoverChecksAndSkillDrafts() {
        #expect(JobType.contentCheck.label == "Kontroller")
        #expect(JobType.brandSkillDraft.label == "Skill taslağı")
        #expect(JobType(rawValue: "content.check") == .contentCheck)
    }

    // MARK: M4 — unreadable conversation frames

    private func snapshot(seq: Int) throws -> ConversationSnapshot {
        guard case .snapshot(var snapshot) = try ConversationStreamMessage.decode(Fixture.text("stream-conversation-snapshot")) else {
            throw Fixture.FixtureError.missing("snapshot")
        }
        snapshot.seq = seq
        return snapshot
    }

    @Test func anUnreadableMessageFrameIsSteppedPastAndShown() throws {
        let snap = try snapshot(seq: 10)
        let conversationId = snap.conversation.id
        // A known type whose body does not decode (a part with a required field missing / a bad date).
        let bad = #"{"type":"message.created","seq":11,"message":{"id":"m-bad","conversationId":"\#(conversationId)","role":"assistant","status":"complete","parts":[{"type":"text","text":"ok"}],"createdAt":"not a date","updatedAt":"x"}}"#
        let frame = try ConversationStreamMessage.decode(bad)
        guard case .unreadable(let unreadable) = frame else {
            Issue.record("unreadable expected, got \(frame)")
            return
        }
        #expect(unreadable.seq == 11 && unreadable.messageId == "m-bad" && unreadable.type == "message.created")

        var state = try #require(ConversationState.apply(nil, .snapshot(snap)))
        state = try #require(ConversationState.apply(state, frame))
        #expect(!state.stale)
        #expect(state.seq == 11)
        #expect(state.skippedFrames == 1)
        #expect(state.messages.last?.id == "m-bad")
        #expect(state.messages.last?.parts == [.unreadable])
        // The next frame applies normally (no gap, no reconnect).
        let next = try ConversationStreamMessage.decode(#"{"type":"text.delta","seq":12,"messageId":"m-bad","index":1,"text":"devam"}"#)
        state = try #require(ConversationState.apply(state, next))
        #expect(!state.stale && state.seq == 12)
        // Replayed after a resume: a duplicate, ignored.
        let replay = try #require(ConversationState.apply(state, frame))
        #expect(replay == state)
    }

    @Test func unreadablePartsAndUnknownEventsKeepTheSeqMoving() throws {
        let snap = try snapshot(seq: 20)
        var state = try #require(ConversationState.apply(nil, .snapshot(snap)))
        let messageId = try #require(state.messages.last?.id)
        let count = state.messages.last!.parts.count
        // A part of a known type with a missing field: only that part is unreadable.
        let badPart = try ConversationStreamMessage.decode(#"{"type":"part.added","seq":21,"messageId":"\#(messageId)","index":\#(count),"part":{"type":"tool_step"}}"#)
        state = try #require(ConversationState.apply(state, badPart))
        #expect(state.seq == 21 && !state.stale)
        #expect(state.messages.last?.parts.last == .unreadable)
        // An event type from a newer server.
        state = try #require(ConversationState.apply(state, try ConversationStreamMessage.decode(#"{"type":"reaction.added","seq":22,"emoji":"👍"}"#)))
        #expect(state.seq == 22 && !state.stale)
        // A run update that does not decode: skipped, seq kept moving.
        state = try #require(ConversationState.apply(state, try ConversationStreamMessage.decode(#"{"type":"run.updated","seq":23,"run":{"id":1}}"#)))
        #expect(state.seq == 23 && !state.stale && state.skippedFrames == 3)
        // A real gap is still a gap.
        let gap = try #require(ConversationState.apply(state, try ConversationStreamMessage.decode(#"{"type":"run.updated","seq":30,"run":{"id":1}}"#)))
        #expect(gap.stale && gap.seq == 23)
        // Not JSON at all: still an error for the caller.
        #expect(throws: (any Error).self) { try ConversationStreamMessage.decode("not json") }
    }

    @Test func messagesWithAnUnreadablePartStillDecode() throws {
        let json = #"{"id":"m1","conversationId":"c1","role":"assistant","status":"complete","parts":[{"type":"text","text":"Merhaba"},{"type":"question"},{"type":"brand_new"}],"createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}"#
        let message = try StudioJSON.decoder().decode(Message.self, from: Data(json.utf8))
        #expect(message.parts == [.text("Merhaba"), .unreadable, .unknown(type: "brand_new")])
        #expect(message.plainText == "Merhaba")
    }

    @Test func aSnapshotWithAnUnreadableMessageStillLoads() throws {
        var object = try JSONSerialization.jsonObject(with: Fixture.data("stream-conversation-snapshot")) as! [String: Any]
        var messages = object["messages"] as! [[String: Any]]
        let count = messages.count
        messages.insert(["id": "m-broken", "role": "user", "createdAt": 12], at: 0)
        object["messages"] = messages
        let text = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        guard case .snapshot(let snapshot) = try ConversationStreamMessage.decode(text) else {
            Issue.record("snapshot expected")
            return
        }
        #expect(snapshot.messages.count == count + 1)
        #expect(snapshot.messages[0].id == "m-broken")
        #expect(snapshot.messages[0].role == .user)
        #expect(snapshot.messages[0].parts == [.unreadable])
        #expect(snapshot.messages[0].conversationId == snapshot.conversation.id)
    }

    @Test nonisolated func theStreamDoesNotReconnectOverAnUnreadableFrame() async throws {
        var object = try JSONSerialization.jsonObject(with: Fixture.data("stream-conversation-snapshot")) as! [String: Any]
        object["seq"] = 40
        let conversation = object["conversation"] as! [String: Any]
        let snapshotFrame = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        let bad = #"{"type":"message.created","seq":41,"message":{"id":"m-bad","role":"assistant","parts":"oops"}}"#
        var renamed = conversation
        renamed["title"] = "Sonra"
        let good = String(decoding: try JSONSerialization.data(withJSONObject: ["type": "conversation.updated", "seq": 42, "conversation": renamed] as [String: Any]), as: UTF8.self)
        let connector = FakeConnector([.framesThenHang([snapshotFrame, bad, good])])
        let sleeper = SleepRecorder()
        let stream = ConversationStream(deps: StreamDependencies(connector: connector, pingInterval: nil, sleep: sleeper.sleep, random: { 0.5 })) { _ in
            (URL(string: "ws://x.test/s")!, [:])
        }
        let events = await collect(stream.events()) { event, _ in
            if case .conversation(let state) = event { return state.conversation.title == "Sonra" }
            return false
        }
        // One connection: the unreadable frame was stepped past, not treated as a gap.
        #expect(connector.connectCount == 1)
        let last = events.compactMap { if case .conversation(let s) = $0 { s } else { nil } }.last
        #expect(last?.seq == 42)
        #expect(last?.messages.contains { $0.id == "m-bad" && $0.parts == [.unreadable] } == true)
    }
}
