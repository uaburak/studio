import Foundation

/// Something worth a notification: work the Mac finished, or the agent waiting on the user.
public struct ActivityNotice: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable, CaseIterable {
        /// A post was generated (or revised) and waits for approval.
        case postReady
        case postFailed
        /// A scheduled post went out.
        case published
        case publishFailed
        /// The agent answered in a conversation.
        case replyReady
        /// The agent asks for permission or an answer.
        case waitingOnYou
        /// An AI image is ready.
        case imageReady
        /// The brand profile draft is ready to review.
        case brandProfileReady
        /// Any other job failed.
        case jobFailed

        /// Settings group the notice belongs to.
        public var category: Category {
            switch self {
            case .waitingOnYou: .waiting
            case .published, .publishFailed: .publishing
            case .replyReady: .replies
            case .postReady, .postFailed, .imageReady, .brandProfileReady, .jobFailed: .production
            }
        }
    }

    /// User-facing switches in Settings → Bildirimler.
    public enum Category: String, Sendable, Hashable, CaseIterable {
        case waiting, production, publishing, replies

        public var label: String {
            switch self {
            case .waiting: "Onayın beklenince"
            case .production: "Üretim bitince"
            case .publishing: "Yayın sonuçları"
            case .replies: "Sohbet yanıtları"
            }
        }
    }

    /// Stable key, so one event is announced once (`job:<id>:<status>`, `consent:<msg>:<id>`).
    public var id: String
    public var kind: Kind
    public var title: String
    public var body: String
    public var brandId: EntityID?
    public var contentId: EntityID?
    public var conversationId: EntityID?

    public init(
        id: String, kind: Kind, title: String, body: String,
        brandId: EntityID? = nil, contentId: EntityID? = nil, conversationId: EntityID? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.brandId = brandId
        self.contentId = contentId
        self.conversationId = conversationId
    }
}

/// Turns the job feed and conversation states into notices, each event once.
///
/// The first snapshot is only remembered: jobs that were already finished when the
/// app connected are not announced again. A job is announced when it is seen moving
/// from queued/running (or unseen after the baseline) to a final state.
public struct ActivityNoticeTracker: Sendable {
    private var known: [EntityID: JobStatus] = [:]
    private var delivered: Set<String> = []
    public private(set) var hasBaseline = false

    public init() {}

    /// Remember a snapshot without announcing anything.
    public mutating func baseline(_ jobs: [Job]) {
        for job in jobs { known[job.id] = job.status }
        hasBaseline = true
    }

    /// Notices for a job update. `title` names the post (content.generate payloads carry it).
    public mutating func notices(for job: Job, contentTitle: String? = nil) -> [ActivityNotice] {
        let previous = known[job.id]
        known[job.id] = job.status
        guard hasBaseline, job.status.isTerminal, previous != job.status, previous == nil || previous?.isActive == true else { return [] }
        guard let notice = Self.notice(for: job, contentTitle: contentTitle) else { return [] }
        return deliver([notice])
    }

    /// Pending consents and unanswered questions in a conversation, each once.
    public mutating func waitingNotices(in state: ConversationState, brandId: EntityID? = nil) -> [ActivityNotice] {
        var found: [ActivityNotice] = []
        let title = state.conversation.displayTitle
        for message in state.messages where message.role == .assistant {
            for part in message.parts {
                switch part {
                case .consent(let consent) where consent.state == .pending:
                    found.append(ActivityNotice(
                        id: "consent:\(message.id):\(consent.consentId)", kind: .waitingOnYou,
                        title: "Onayın bekleniyor", body: "\(title): \(consent.title)",
                        brandId: brandId ?? state.conversation.brandId, conversationId: state.conversation.id))
                case .question(let question) where question.answer == nil && message.status == .streaming:
                    found.append(ActivityNotice(
                        id: "question:\(message.id):\(question.questionId)", kind: .waitingOnYou,
                        title: "Bir sorusu var", body: "\(title): \(question.prompt)",
                        brandId: brandId ?? state.conversation.brandId, conversationId: state.conversation.id))
                default:
                    continue
                }
            }
        }
        return deliver(found)
    }

    /// Mark keys as already shown (e.g. the user is looking at that conversation).
    public mutating func markSeen(_ ids: some Sequence<String>) {
        delivered.formUnion(ids)
    }

    private mutating func deliver(_ notices: [ActivityNotice]) -> [ActivityNotice] {
        notices.filter { delivered.insert($0.id).inserted }
    }

    /// Notices for jobs that finished after `date` (a background check after the app slept).
    public static func notices(for jobs: [Job], finishedAfter date: Date) -> [ActivityNotice] {
        jobs.filter { $0.status.isTerminal && ($0.finishedAt ?? $0.updatedAt) > date }
            .sorted { ($0.finishedAt ?? $0.updatedAt) < ($1.finishedAt ?? $1.updatedAt) }
            .compactMap { notice(for: $0) }
    }

    /// The notice a finished job deserves, if any (renders and echoes stay quiet when they work).
    public static func notice(for job: Job, contentTitle: String? = nil) -> ActivityNotice? {
        let key = "job:\(job.id):\(job.status.rawValue)"
        let title = contentTitle ?? job.payload["title"]?.stringValue ?? job.displayTitle
        let failure = job.error.map { String($0.prefix(140)) } ?? "Ayrıntı Mac'te."
        switch (job.type, job.status) {
        case (.contentGenerate, .succeeded):
            let revised = job.payload["instructions"] != nil || job.output?["revised"]?.boolValue == true
            return ActivityNotice(
                id: key, kind: .postReady, title: revised ? "Düzenleme hazır" : "Post hazır",
                body: "\(title) onayını bekliyor.", brandId: job.brandId, contentId: job.contentId)
        case (.contentGenerate, .failed):
            return ActivityNotice(id: key, kind: .postFailed, title: "Post üretilemedi", body: "\(title): \(failure)", brandId: job.brandId, contentId: job.contentId)
        case (.schedulePublish, .succeeded):
            return ActivityNotice(id: key, kind: .published, title: "Yayınlandı", body: "\(title) paylaşıldı.", brandId: job.brandId, contentId: job.contentId)
        case (.schedulePublish, .failed):
            return ActivityNotice(id: key, kind: .publishFailed, title: "Yayın başarısız", body: "\(title): \(failure)", brandId: job.brandId, contentId: job.contentId)
        case (.chatTurn, .succeeded):
            return ActivityNotice(
                id: key, kind: .replyReady, title: "Yanıt hazır", body: "Sohbette yeni bir yanıt var.",
                brandId: job.brandId, conversationId: job.payload["conversationId"]?.stringValue)
        case (.chatTurn, .failed):
            return ActivityNotice(
                id: key, kind: .jobFailed, title: "Yanıt yarıda kaldı", body: failure,
                brandId: job.brandId, conversationId: job.payload["conversationId"]?.stringValue)
        case (.imageGenerate, .succeeded):
            return ActivityNotice(id: key, kind: .imageReady, title: "AI görsel hazır", body: "Medya kütüphanesine eklendi.", brandId: job.brandId, contentId: job.contentId ?? job.payload["targetContentId"]?.stringValue)
        case (.brandAnalyze, .succeeded):
            return ActivityNotice(id: key, kind: .brandProfileReady, title: "Marka profili hazır", body: "Taslağı inceleyip onaylayabilirsin.", brandId: job.brandId)
        case (.contentRender, .failed), (.imageGenerate, .failed), (.brandAnalyze, .failed):
            return ActivityNotice(id: key, kind: .jobFailed, title: "\(job.type.label) başarısız", body: failure, brandId: job.brandId, contentId: job.contentId)
        default:
            return nil
        }
    }
}
