import Foundation
import Testing
@testable import StudioKit

/// Responses captured from the running local API (scripts/capture-fixtures.sh).
@Suite("Decoding captured API responses")
struct DecodingTests {
    @Test func health() throws {
        let health = try Fixture.decode(HealthResponse.self, "health")
        #expect(health.service == "studio-api")
        #expect(health.checks.db == "ok")
    }

    @Test func brandsAndAccounts() throws {
        let brands = try Fixture.decode(Page<Brand>.self, "brand-list").items
        #expect(brands.map(\.name).contains("MTM Agro"))
        #expect(brands.allSatisfy { $0.status == .active })
        let accounts = try Fixture.decode(Page<SocialAccount>.self, "social-account-list").items
        #expect(Set(accounts.map(\.platform)) == [.instagram, .facebook, .linkedin])
        #expect(accounts.first { $0.platform == .linkedin }?.status == .pending)
    }

    @Test func contentsVersionsAndHash() throws {
        let contents = try Fixture.decode(Page<Content>.self, "content-list").items
        #expect(contents.count == 12)
        #expect(contents.contains { $0.status == .scheduled })
        let content = try Fixture.decode(Content.self, "content")
        let version = try Fixture.decode(ContentVersion.self, "content-version")
        #expect(version.contentId == content.id)
        // The hash the app recomputes equals the server's (computeContentHash).
        #expect(ContentHash.compute(version.slides) == version.contentHash)
        #expect(content.currentVersion?.contentHash == version.contentHash)
        // The seeded "Venta Borinc" leaves an empty image slot.
        let slots = SlotScanner.slots(in: version.slides)
        #expect(slots.count == 1)
        #expect(slots.first?.isEmpty == true)
        #expect(slots.first?.ratio == "1:1")
        #expect(CaptionParts(caption: content.caption).hashtags.first == "#mtmagro")
    }

    @Test func plansSchedulesJobsPresence() throws {
        let plans = try Fixture.decode(Page<Plan>.self, "plan-list").items
        #expect(plans.map(\.status) == [.proposed, .accepted])
        let accepted = try #require(plans.first { $0.status == .accepted })
        #expect(accepted.items.count == 12)
        #expect(accepted.userImageItemCount == 6)
        #expect(accepted.items.allSatisfy { $0.contentId != nil })
        #expect(accepted.items.first?.date == CalendarDay(year: 2026, month: 11, day: 4))
        let schedules = try Fixture.decode(Page<Schedule>.self, "schedule-list").items
        #expect(schedules.first?.status == .pending)
        let jobs = try Fixture.decode(Page<Job>.self, "job-list").items
        #expect(!jobs.isEmpty)
        let presence = try Fixture.decode(WorkerPresence.self, "presence")
        #expect(presence.online == false)
        #expect(presence.usage == nil)
    }

    @Test func presenceUsageAndRunChoice() throws {
        let usage = #""usage":{"windows":[{"kind":"five_hour","usedPercent":42.5,"resetsAt":"2026-11-16T18:00:00.000Z","limited":false},{"kind":"weekly","usedPercent":80,"limited":false},{"kind":"monthly","limited":true}],"source":"claude-cli","observedAt":"2026-11-16T14:00:00.000Z"}"#
        let presenceJSON = #"{"online":true,"lastSeenAt":null,"workers":[],"currentJobs":[],"queueLength":0,"# + usage + "}"
        let presence = try StudioJSON.decoder().decode(WorkerPresence.self, from: Data(presenceJSON.utf8))
        let windows = try #require(presence.usage?.windows)
        #expect(windows.map(\.kind) == [.fiveHour, .weekly, .unknown])
        #expect(windows[0].usedPercent == 42.5)
        #expect(windows[0].resetsAt == ISO8601DateFormatter().date(from: "2026-11-16T18:00:00Z"))
        #expect(windows[1].resetsAt == nil)
        #expect(presence.usage?.source == "claude-cli")
        // A limited window counts as full.
        #expect(presence.usage?.mostUsed?.kind == .unknown)
        #expect(presence.usage?.mostUsed?.effectivePercent == 100)

        // The same usage arrives on both streams' presence frames.
        guard case .presence(let jobs) = try JobStreamMessage.decode(#"{"type":"presence","presence":"# + presenceJSON + "}") else {
            Issue.record("expected a presence frame"); return
        }
        #expect(jobs.usage == presence.usage)
        guard case .presence(let chat) = try ConversationStreamMessage.decode(#"{"type":"presence","presence":"# + presenceJSON + "}") else {
            Issue.record("expected a presence frame"); return
        }
        #expect(chat.usage == presence.usage)

        let run = #"{"id":"r1","conversationId":"c1","triggerMessageId":"m1","jobId":null,"status":"queued","attempt":0,"model":"opus","effort":"xhigh","usage":null,"error":null,"createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z","startedAt":null,"finishedAt":null}"#
        let decoded = try StudioJSON.decoder().decode(AgentRun.self, from: Data(run.utf8))
        #expect(decoded.requestedModel == .opus)
        #expect(decoded.effort == .xhigh)
        let reported = run.replacingOccurrences(of: #""model":"opus","effort":"xhigh","#, with: #""model":"claude-opus-5-5","#)
        let finished = try StudioJSON.decoder().decode(AgentRun.self, from: Data(reported.utf8))
        #expect(finished.requestedModel == nil)
        #expect(finished.effort == nil)
    }

    @Test func toolStepsConsentsGeminiModelsAndWorkerControls() throws {
        // AgentModel Gemini cases & helpers
        #expect(AgentModel.geminiCases == [.geminiFlashLite, .geminiFlash, .geminiPro])
        #expect(AgentModel.claudeCases == [.opus, .sonnet, .haiku])
        #expect(AgentModel.geminiFlashLite.isGemini == true)
        #expect(AgentModel.geminiFlashLite.rawValue == "gemini-flash-lite")
        #expect(AgentModel.geminiFlashLite.displayName == "Gemini Flash-Lite")
        #expect(AgentModel.opus.isGemini == false)

        // Message with tool_step and consent parts round-trips cleanly
        let messageJSON = """
        {
          "id": "m-agent",
          "conversationId": "c1",
          "role": "assistant",
          "status": "complete",
          "runId": "r1",
          "parts": [
            {
              "type": "tool_step",
              "id": "step-1",
              "name": "propose_plan",
              "label": "İçerik planı hazırlandı",
              "state": "done",
              "summary": "12 post"
            },
            {
              "type": "consent",
              "consentId": "con-1",
              "tool": "schedule_post",
              "title": "Postu zamanla",
              "detail": "Venta Borinc · 20 Kasım 09:00",
              "state": "pending",
              "decidedAt": null
            }
          ],
          "createdAt": "2026-11-16T10:00:00.000Z",
          "updatedAt": "2026-11-16T10:00:00.000Z"
        }
        """
        let decoded = try StudioJSON.decoder().decode(Message.self, from: Data(messageJSON.utf8))
        #expect(decoded.parts.count == 2)
        #expect(decoded.parts[0].typeName == "tool_step")
        #expect(decoded.parts[1].typeName == "consent")
        guard case .toolStep(let step) = decoded.parts[0],
              case .consent(let consent) = decoded.parts[1] else {
            Issue.record("expected toolStep and consent parts")
            return
        }
        #expect(step.id == "step-1")
        #expect(step.state == .done)
        #expect(step.summary == "12 post")
        #expect(consent.consentId == "con-1")
        #expect(consent.state == .pending)
        #expect(consent.decidedAt == nil)

        let reencoded = try StudioJSON.encoder().encode(decoded)
        let roundTripped = try StudioJSON.decoder().decode(Message.self, from: reencoded)
        #expect(roundTripped == decoded)

        // Conversation with agentSession
        let convJSON = """
        {
          "id": "c1",
          "brandId": "b1",
          "title": "Test",
          "status": "active",
          "activeRunId": null,
          "lastSeq": 5,
          "agentSession": {
            "id": "sess-123",
            "messageCount": 4,
            "runId": "r1",
            "updatedAt": "2026-11-16T10:05:00.000Z"
          },
          "lastActivityAt": "2026-11-16T10:05:00.000Z",
          "createdAt": "2026-11-16T10:00:00.000Z",
          "updatedAt": "2026-11-16T10:05:00.000Z"
        }
        """
        let conv = try StudioJSON.decoder().decode(Conversation.self, from: Data(convJSON.utf8))
        #expect(conv.agentSession?.id == "sess-123")
        #expect(conv.agentSession?.messageCount == 4)

        // ClaudeControl & GeminiControl + WorkerPresence accounts
        let claudeJSON = """
        {
          "account": {
            "status": "signing_in",
            "email": null,
            "plan": null,
            "cliVersion": "1.0.24",
            "loginUrl": "https://claude.ai/oauth/authorize?code=abc",
            "detail": "Tarayıcıda giriş bekleniyor…",
            "checkedAt": "2026-11-16T14:00:00.000Z"
          },
          "online": true,
          "sent": 1
        }
        """
        let claude = try StudioJSON.decoder().decode(ClaudeControl.self, from: Data(claudeJSON.utf8))
        #expect(claude.account?.status == .signingIn)
        #expect(claude.account?.loginUrl == "https://claude.ai/oauth/authorize?code=abc")
        #expect(claude.online == true)
        #expect(claude.sent == 1)

        let geminiJSON = """
        {
          "account": {
            "status": "ready",
            "mode": "both",
            "apiKeyConfigured": true,
            "cliVersion": "0.8.2",
            "defaultModel": "gemini-2.5-flash-lite",
            "detail": "GEMINI_API_KEY + CLI hazır",
            "checkedAt": "2026-11-16T14:00:00.000Z"
          },
          "online": true,
          "sent": 0
        }
        """
        let gemini = try StudioJSON.decoder().decode(GeminiControl.self, from: Data(geminiJSON.utf8))
        #expect(gemini.account?.status == .ready)
        #expect(gemini.account?.mode == .both)
        #expect(gemini.account?.apiKeyConfigured == true)
        #expect(gemini.account?.defaultModel == "gemini-2.5-flash-lite")
    }

    @Test func conversationsMessagesAliases() throws {
        let conversations = try Fixture.decode(Page<Conversation>.self, "conversation-list").items
        #expect(conversations.first?.title == "Kasım planı")
        let messages = try Fixture.decode(Page<Message>.self, "message-list").items
        #expect(messages.contains { message in message.parts.contains { if case .planProposal = $0 { true } else { false } } })

        let withAttachments = try Fixture.decode(Page<Message>.self, "message-list-attachments").items
        let user = try #require(withAttachments.first { $0.role == .user })
        let attachments = user.parts.compactMap { if case .attachment(let a) = $0 { a } else { nil } }
        #expect(attachments.map(\.alias) == ["image", "image-1"])
        #expect(attachments.allSatisfy { $0.aliasId != nil })
        let mentions = try #require(user.mentions)
        #expect(mentions.map(\.alias) == ["image", "image-1", "image"])
        // Server offsets are UTF-16 and match the local resolver exactly.
        let aliases = try Fixture.decode(Page<ConversationAlias>.self, "alias-list").items
        #expect(aliases.map(\.alias) == ["image", "image-1"])
        #expect(MentionText.resolve(user.plainText, aliases: aliases.map(MentionText.Target.init)) == mentions)
        let assistant = try #require(withAttachments.first { $0.role == .assistant })
        #expect(assistant.mentions == [])

        let runs = try Fixture.decode(Page<AgentRun>.self, "run-list").items
        #expect(runs.allSatisfy { $0.status == .completed })
        let asset = try Fixture.decode(Asset.self, "asset")
        #expect(asset.kind == .image)
    }

    @Test func errorShapes() throws {
        let notFound = StudioAPIError.from(status: 404, body: try Fixture.data("error-not-found"))
        #expect(notFound.code == .notFound)
        let mismatch = StudioAPIError.from(status: 409, body: try Fixture.data("error-hash-mismatch"))
        #expect(mismatch.code == .hashMismatch)
        let validation = StudioAPIError.from(status: 400, body: try Fixture.data("error-validation"))
        guard case .server(_, .validationError, _, let issues) = validation else {
            Issue.record("expected a validation error, got \(validation)")
            return
        }
        #expect(issues.first?.path == "name")
    }

    @Test func streamFrames() throws {
        guard case .snapshot(let jobs, _) = try JobStreamMessage.decode(Fixture.text("stream-jobs-snapshot")) else {
            Issue.record("expected jobs.snapshot")
            return
        }
        #expect(!jobs.isEmpty)
        #expect(try JobStreamMessage.decode(Fixture.text("stream-pong")) == .pong(ts: 1_763_290_000_000))

        guard case .snapshot(let snapshot) = try ConversationStreamMessage.decode(Fixture.text("stream-conversation-snapshot")) else {
            Issue.record("expected conversation.snapshot")
            return
        }
        #expect(snapshot.conversation.title == "Kasım planı")
        #expect(snapshot.plans.count == 2)
        #expect(snapshot.messages.first?.role == .user)
    }

    /// Replaying the stored events from an earlier seq reproduces the snapshot.
    @Test func resumeReplaysToTheSnapshot() throws {
        guard case .snapshot(let snapshot) = try ConversationStreamMessage.decode(Fixture.text("stream-conversation-snapshot")) else {
            Issue.record("expected conversation.snapshot")
            return
        }
        let frames = try JSONSerialization.jsonObject(with: Fixture.data("stream-conversation-resume")) as! [Any]
        let decoded = try frames.map { frame in
            try ConversationStreamMessage.decode(String(decoding: JSONSerialization.data(withJSONObject: frame), as: UTF8.self))
        }
        #expect(decoded.last.map { if case .resumed = $0 { true } else { false } } == true)
        // Rewind the snapshot to just before the replayed events and re-apply them:
        // every event is an idempotent upsert, so the result must equal the snapshot.
        let firstSeq = try #require(decoded.first?.seq)
        var state: ConversationState? = ConversationState(snapshot: snapshot)
        state?.seq = firstSeq - 1
        for frame in decoded { state = ConversationState.apply(state, frame) }
        let final = try #require(state)
        #expect(final.stale == false)
        #expect(final.seq == snapshot.seq)
        #expect(final.messages == snapshot.messages)
        #expect(final.plans.map(\.id) == snapshot.plans.map(\.id))
        // lastActivityAt may differ by milliseconds: the server stamps it after building the event.
        var conversation = final.conversation
        conversation.lastActivityAt = snapshot.conversation.lastActivityAt
        #expect(conversation == snapshot.conversation)
    }
}
