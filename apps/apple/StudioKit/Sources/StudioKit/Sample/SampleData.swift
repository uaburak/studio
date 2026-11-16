import Foundation

/// Realistic Turkish sample data matching the approved drafts
/// (apps/mac/Design). Used by previews, tests and screenshot renders only;
/// the apps talk to the real API by default.
public struct SampleData: Sendable {
    public var now: Date
    public var brands: [Brand]
    public var accounts: [SocialAccount]
    public var conversations: [Conversation]
    public var messages: [EntityID: [Message]]
    public var plans: [Plan]
    public var contents: [Content]
    public var versions: [EntityID: ContentVersion]
    public var schedules: [Schedule]
    public var jobs: [Job]
    public var presence: WorkerPresence
    public var assets: [EntityID: Asset]
    public var brandProfiles: [EntityID: [BrandProfile]] = [:]
    public var publishLogs: [EntityID: [PublishLog]] = [:]
    /// Agent runs started while the sample is in use (none at start).
    public var runs: [AgentRun] = []
    /// Attachment aliases per conversation, oldest first.
    public var aliases: [EntityID: [ConversationAlias]] = [:]

    public static let mtm = "b-mtm"
    public static let kasimConversation = "c-kasim"
    public static let lansmanConversation = "c-lansman"
    public static let hasatConversation = "c-hasat"
    public static let kasimPlan = "plan-kasim"

    /// Sample "today": 16 Kasım 2026, 10:00 Istanbul.
    public static let referenceDate: Date = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        return calendar.date(from: DateComponents(year: 2026, month: 11, day: 16, hour: 10))!
    }()

    // swiftlint:disable:next function_body_length
    public init(now: Date = SampleData.referenceDate) {
        self.now = now
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        let created = ago(60 * 24 * 20)
        let mtm = Self.mtm

        brands = [
            Brand(id: mtm, name: "MTM Agro", slug: "mtm-agro", createdAt: created, updatedAt: created),
            Brand(id: "b-koc", name: "Koç Chords", slug: "koc-chords", createdAt: created, updatedAt: created),
            Brand(id: "b-finvo", name: "Finvo", slug: "finvo", createdAt: created, updatedAt: created),
            Brand(id: "b-burakkoc", name: "burakkoc.net", slug: "burakkoc-net", createdAt: created, updatedAt: created),
        ]

        accounts = [
            SocialAccount(id: "sa-ig", brandId: mtm, platform: .instagram, handle: "mtmagro", externalId: "1784", status: .connected, createdAt: created, updatedAt: created, hasToken: true, tokenExpiresAt: now.addingTimeInterval(45 * 86_400), tokenScopes: ["instagram_basic", "instagram_content_publish"], tokenHealth: .valid, tokenCheckedAt: ago(15)),
            SocialAccount(id: "sa-fb", brandId: mtm, platform: .facebook, handle: "MTM Agro", externalId: "1022", status: .connected, createdAt: created, updatedAt: created, hasToken: true, tokenExpiresAt: now.addingTimeInterval(45 * 86_400), tokenScopes: ["pages_manage_posts", "pages_read_engagement"], tokenHealth: .valid, tokenCheckedAt: ago(15)),
            SocialAccount(id: "sa-li", brandId: mtm, platform: .linkedin, handle: "MTM Agro", status: .pending, createdAt: created, updatedAt: created, hasToken: false, tokenHealth: .unchecked),
            SocialAccount(id: "sa-koc-ig", brandId: "b-koc", platform: .instagram, handle: "kocchords", status: .connected, createdAt: created, updatedAt: created, hasToken: true, tokenHealth: .valid, tokenCheckedAt: ago(30)),
        ]

        brandProfiles = [
            mtm: [
                BrandProfile(
                    id: "bp-mtm-1",
                    brandId: mtm,
                    version: 1,
                    status: .approved,
                    isCurrent: true,
                    tokens: [
                        "colors": .object([
                            "primary": .string("#FF6A00"),
                            "background": .string("#0A0A0A"),
                            "surface": .string("#F4F4F5"),
                            "text": .string("#FFFFFF"),
                        ]),
                        "typography": .object([
                            "display": .string("Inter Tight"),
                            "body": .string("Inter"),
                        ]),
                    ],
                    designRules: "# Tasarım Kuralları (MTM Agro)\n\n- Koyu zemin (#0A0A0A) ve yüksek kontrastlı başlıklar kullan.\n- Ürün fotoğrafı yuvası en az %60 alan kaplamalı.\n- Vurgu rengi yalnızca tek bir odak öğesinde (#FF6A00) yer alır.",
                    voice: "# Metin Tonu (MTM Agro)\n\n- Çiftçi ve bayiyle doğrudan, güven veren ve sade Türkçe konuş.\n- Abartılı pazarlama sıfatlarından kaçın; somut uygulama zamanı ve faydayı yaz.",
                    approvedAt: ago(60 * 24 * 10),
                    createdAt: created,
                    updatedAt: ago(60 * 24 * 10)
                ),
                BrandProfile(
                    id: "bp-mtm-2",
                    brandId: mtm,
                    version: 2,
                    status: .draft,
                    isCurrent: false,
                    tokens: [
                        "colors": .object([
                            "primary": .string("#FF6A00"),
                            "background": .string("#141414"),
                            "surface": .string("#FFFFFF"),
                            "accent": .string("#2E7D32"),
                        ]),
                    ],
                    designRules: "# Tasarım Kuralları v2 (Taslak)\n\n- Kış serisi için açık/koyu dengeli kart düzeni.\n- Teknik doz tablolarında 4:5 carousel tercih et.",
                    voice: "# Metin Tonu v2 (Taslak)\n\n- Kış hazırlığı döneminde rehber odaklı, madde işaretli kısa açıklamalar.",
                    approvedAt: nil,
                    createdAt: ago(120),
                    updatedAt: ago(60)
                ),
            ],
            "b-koc": [
                BrandProfile(
                    id: "bp-koc-1",
                    brandId: "b-koc",
                    version: 1,
                    status: .approved,
                    isCurrent: true,
                    tokens: [
                        "colors": .object([
                            "primary": .string("#101010"),
                            "accent": .string("#FF6A00"),
                            "surface": .string("#F4F4F5"),
                        ]),
                    ],
                    designRules: "# Tasarım Kuralları (Koç Chords)\n\n- Minimal tipografi ve sahne fotoğrafları.",
                    voice: "# Metin Tonu (Koç Chords)\n\n- Samimi, müzik odaklı ve kısa duyuru dili.",
                    approvedAt: created,
                    createdAt: created,
                    updatedAt: created
                ),
            ],
        ]

        func conversation(_ id: String, _ brand: String?, _ title: String, minutesAgo: Double, activeRun: String? = nil) -> Conversation {
            Conversation(id: id, brandId: brand, title: title, activeRunId: activeRun, lastSeq: 4, lastActivityAt: ago(minutesAgo), createdAt: ago(minutesAgo + 30), updatedAt: ago(minutesAgo))
        }
        conversations = [
            conversation(Self.kasimConversation, mtm, "Kasım planı", minutesAgo: 6),
            conversation(Self.lansmanConversation, mtm, "Venta Borinc lansmanı", minutesAgo: 70),
            conversation(Self.hasatConversation, mtm, "Hasat sezonu serisi", minutesAgo: 60 * 26),
            conversation("c-bayi", mtm, "Bayi duyurusu", minutesAgo: 60 * 50),
            conversation("c-koc-1", "b-koc", "Konser duyurusu", minutesAgo: 60 * 30),
            conversation("c-koc-2", "b-koc", "Yeni single", minutesAgo: 60 * 80),
            conversation("c-finvo-1", "b-finvo", "Ekim raporu", minutesAgo: 60 * 75),
            conversation("c-burak-1", "b-burakkoc", "Portfolyo güncellemesi", minutesAgo: 60 * 120),
        ]

        // MARK: Plans

        func day(_ d: Int) -> CalendarDay { CalendarDay(year: 2026, month: 11, day: d) }
        struct ItemSpec { var day: Int; var title: String; var pillar: String; var slot: ImageSlotExpectation; var brief: String }
        let proposed: [ItemSpec] = [
            .init(day: 4, title: "Venta Borinc tanıtım", pillar: "Yeni ürün", slot: .userUpload, brief: "Venta Borinc'i ilk kez tanıt; bor ve çinkonun birlikte etkisini vurgula."),
            .init(day: 7, title: "Doğru saklama rehberi", pillar: "Rehber", slot: .none, brief: "Gübrenin kışın nasıl saklanacağına dair üç adım."),
            .init(day: 11, title: "Bor ve çinko neden birlikte", pillar: "Bilgi", slot: .none, brief: "İki besin elementinin birlikte alımını sade bir dille anlat."),
            .init(day: 14, title: "Bayi buluşması", pillar: "Kampanya", slot: .userUpload, brief: "Bayi buluşmasının tarih ve yerini duyur."),
            .init(day: 18, title: "Uygulama zamanı", pillar: "Bilgi", slot: .none, brief: "Hangi dönemde, hangi dozda uygulanır."),
            .init(day: 21, title: "Tarladan", pillar: "Ürün", slot: .userUpload, brief: "Çiftçinin tarladan çektiği fotoğrafla gerçek sonuç."),
            .init(day: 25, title: "Soru cevap", pillar: "Bilgi", slot: .none, brief: "En sık gelen üç soru ve kısa yanıtları."),
            .init(day: 28, title: "Ay sonu", pillar: "Özet", slot: .none, brief: "Kasım ayının kısa özeti."),
            .init(day: 29, title: "Kış hazırlığı", pillar: "Rehber", slot: .userUpload, brief: "Toprağı kışa hazırlamak için öneriler."),
            .init(day: 30, title: "Bayi haritası", pillar: "Kampanya", slot: .userUpload, brief: "Bölgedeki bayilerin listesi."),
            .init(day: 30, title: "Müşteri hikâyesi", pillar: "Ürün", slot: .userUpload, brief: "Bir üreticinin Venta Borinc deneyimi."),
            .init(day: 30, title: "Sezon kapanışı", pillar: "Özet", slot: .none, brief: "Sezonun kapanışı ve teşekkür."),
        ]
        let contentIds = ["post-01", "post-02a", "post-03a", "post-04", "post-05a", "post-06", "post-07", "post-08", "post-09", "post-10", "post-11", "post-12a"]
        let platformsIGFB: [Platform] = [.instagram, .facebook]

        func items(planId: String, accepted: Bool) -> [PlanItem] {
            proposed.enumerated().map { index, spec in
                PlanItem(
                    id: "\(planId)-i\(index)", planId: planId, position: index, date: day(spec.day), platforms: platformsIGFB,
                    title: spec.title, brief: spec.brief, pillar: spec.pillar, imageSlot: spec.slot,
                    imageBrief: spec.slot == .userUpload ? "Ürünün tarlada ya da depoda çekilmiş dikey fotoğrafı" : nil,
                    status: accepted ? .accepted : .planned, contentId: accepted ? contentIds[index] : nil,
                    createdAt: ago(60 * 24 * 3), updatedAt: ago(60 * 24 * 3))
            }
        }
        plans = [
            Plan(
                id: Self.kasimPlan, brandId: mtm, conversationId: Self.kasimConversation, runId: "run-kasim", title: "Kasım planı",
                periodStart: day(1), periodEnd: day(30), status: .proposed,
                summary: "12 postluk Kasım planı hazır. Onaylarsan üretime başlarım.", revision: 1,
                items: items(planId: Self.kasimPlan, accepted: false), createdAt: ago(7), updatedAt: ago(7)),
            Plan(
                id: "plan-kasim-taslak", brandId: mtm, conversationId: Self.kasimConversation, title: "Kasım içerikleri",
                periodStart: day(1), periodEnd: day(30), status: .accepted, summary: "", revision: 2, decidedAt: ago(60 * 24 * 3),
                items: items(planId: "plan-kasim-taslak", accepted: true), createdAt: ago(60 * 24 * 4), updatedAt: ago(60 * 24 * 3)),
        ]

        // MARK: Posts

        struct PostSpec { var title: String; var status: ContentStatus; var caption: String }
        let tags = "#mtmagro #venta #borinc #bor #çinko #bitkibesleme"
        let posts: [PostSpec] = [
            .init(title: "Venta Borinc", status: .draft, caption: "Bor ve çinko bir arada. Venta Borinc ile tanışın.\nAyrıntılar için bayinize danışın.\n\n\(tags)"),
            .init(title: "Doğru saklama rehberi", status: .draft, caption: "Gübreyi kuru, serin ve güneş almayan bir yerde saklayın. Açılan torbayı ağzı kapalı tutun.\n\n#mtmagro #saklama #rehber"),
            .init(title: "Bor ve çinko", status: .inReview, caption: "Bor ve çinko birlikte alındığında bitki ikisinden de daha iyi yararlanır.\n\n#mtmagro #bor #çinko"),
            .init(title: "Bayi buluşması", status: .draft, caption: "Bayi buluşmamız 20 Kasım'da Konya'da. Yerinizi ayırtın.\n\n#mtmagro #bayi"),
            .init(title: "Uygulama zamanı", status: .draft, caption: "Venta Borinc'i çiçeklenme öncesinde, sabah serinliğinde uygulayın.\n\n#mtmagro #uygulama"),
            .init(title: "Tarladan", status: .draft, caption: "Üreticimiz Ahmet Bey'in tarlasından bu sezonun sonuçları.\n\n#mtmagro #tarladan"),
            .init(title: "Soru cevap", status: .approved, caption: "En çok sorduğunuz üç soruyu yanıtladık.\n\n#mtmagro #sorucevap"),
            .init(title: "Ay sonu", status: .approved, caption: "Kasım'da birlikte neler yaptık? Kısa bir özet.\n\n#mtmagro #kasım"),
            .init(title: "Kış hazırlığı", status: .draft, caption: "Toprağı kışa hazırlarken unutulmaması gereken üç adım.\n\n#mtmagro #kış"),
            .init(title: "Bayi haritası", status: .draft, caption: "Size en yakın MTM bayisini haritada bulun.\n\n#mtmagro #bayi"),
            .init(title: "Müşteri hikâyesi", status: .draft, caption: "Venta Borinc'i ilk kez kullanan bir üreticinin hikâyesi.\n\n#mtmagro #hikaye"),
            .init(title: "Sezon kapanışı", status: .scheduled, caption: "Bu sezon yanımızda olduğunuz için teşekkürler.\n\n#mtmagro #teşekkürler"),
        ]
        var contents: [Content] = []
        var versions: [EntityID: ContentVersion] = [:]
        for (index, spec) in posts.enumerated() {
            let id = contentIds[index]
            let needsImage = proposed[index].slot == .userUpload
            let slides = [Slide(html: Self.slideHTML(title: spec.title, pillar: proposed[index].pillar, emptySlot: needsImage), width: 1080, height: 1350)]
            let hash = ContentHash.compute(slides)
            let version = ContentVersion(id: "\(id)-v1", contentId: id, version: 1, contentHash: hash, createdAt: ago(60 * 24 * 2), updatedAt: ago(60 * 24 * 2), slides: slides)
            versions[id] = version
            let approval = spec.status.hasApproval ? ContentApproval(versionId: version.id, contentHash: hash, approvedAt: ago(60 * 20)) : nil
            contents.append(Content(
                id: id, brandId: mtm, type: .post, title: spec.title, brief: proposed[index].brief, status: spec.status,
                targetPlatforms: platformsIGFB, caption: spec.caption,
                currentVersion: ContentVersionRef(id: version.id, version: 1, contentHash: hash), approval: approval,
                createdAt: ago(60 * 24 * 3), updatedAt: ago(60 * 24 * 2)))
        }
        self.contents = contents
        self.versions = versions

        var istanbul = Calendar(identifier: .gregorian)
        istanbul.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let scheduledAt = istanbul.date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 9))!
        schedules = [
            Schedule(id: "sch-1", contentId: "post-12a", brandId: mtm, platform: .instagram, socialAccountId: "sa-ig", versionId: "post-12a-v1", contentHash: versions["post-12a"]!.contentHash, scheduledAt: scheduledAt, status: .pending, createdAt: ago(60), updatedAt: ago(60)),
        ]

        // MARK: Jobs and presence

        func job(_ id: String, _ status: JobStatus, title: String, content: String?, startedMinutesAgo: Double?, finishedMinutesAgo: Double? = nil, progress: Double? = nil) -> Job {
            var job = Job(
                id: id, type: .contentGenerate, status: status, payload: ["title": .string(title)], brandId: mtm, contentId: content,
                createdAt: ago((startedMinutesAgo ?? 1) + 1), updatedAt: ago(finishedMinutesAgo ?? 0),
                startedAt: startedMinutesAgo.map(ago), finishedAt: finishedMinutesAgo.map(ago), progress: progress)
            job.progressMessage = status == .running ? "Tasarım denetleniyor" : nil
            return job
        }
        jobs = [
            job("job-bayi", .running, title: "Bayi buluşması", content: "post-04", startedMinutesAgo: 2, progress: 0.4),
            job("job-uygulama", .queued, title: "Uygulama zamanı", content: "post-05a", startedMinutesAgo: nil),
            job("job-done-1", .succeeded, title: "Doğru saklama rehberi", content: "post-02a", startedMinutesAgo: 30, finishedMinutesAgo: 25),
            job("job-done-2", .succeeded, title: "Bor ve çinko", content: "post-03a", startedMinutesAgo: 24, finishedMinutesAgo: 20),
            job("job-done-3", .succeeded, title: "Soru cevap", content: "post-07", startedMinutesAgo: 19, finishedMinutesAgo: 15),
        ]
        presence = WorkerPresence(
            online: true, lastSeenAt: ago(0.2),
            workers: [ConnectedWorker(workerId: "burak-mbp", workerVersion: "0.1.0", capabilities: ["demo.echo", "content.generate"], connectedAt: ago(90), lastSeenAt: ago(0.2))],
            currentJobs: [PresenceJob(id: "job-bayi", type: .contentGenerate, brandId: mtm, workerId: "burak-mbp", progress: 0.4, progressMessage: "Tasarım denetleniyor", startedAt: ago(2))],
            queueLength: 1,
            usage: WorkerUsage(
                windows: [
                    UsageWindow(kind: .fiveHour, usedPercent: 34, resetsAt: now.addingTimeInterval(3 * 3600), limited: false),
                    UsageWindow(kind: .weekly, usedPercent: 62, resetsAt: now.addingTimeInterval(4 * 86_400), limited: false),
                ],
                source: "claude-cli",
                observedAt: ago(1)
            ),
            claude: ClaudeAccount(
                status: .signedIn,
                email: "burak@burakkoc.net",
                plan: "Claude Max",
                cliVersion: "1.0.24",
                detail: "Giriş yapıldı · Claude Max",
                checkedAt: ago(1)
            ),
            gemini: GeminiAccount(
                status: .ready,
                mode: .api,
                apiKeyConfigured: true,
                cliVersion: nil,
                defaultModel: "gemini-2.5-flash-lite",
                detail: "GEMINI_API_KEY hazır · doğrudan API",
                checkedAt: ago(1)
            )
        )

        // MARK: Assets

        func asset(_ id: String, _ name: String) -> Asset {
            Asset(id: id, brandId: mtm, kind: .image, source: .upload, objectKey: "brands/\(mtm)/assets/\(id).png", mimeType: "image/png", bytes: 120_000, sha256: String(repeating: "0", count: 64), width: 1080, height: 1350, originalFilename: name, createdAt: ago(60 * 26))
        }
        assets = ["asset-tarla": asset("asset-tarla", "tarla.jpg"), "asset-depo": asset("asset-depo", "depo.jpg")]

        // MARK: Aliases

        let hasatAliases = [
            ConversationAlias(id: "alias-tarla", conversationId: Self.hasatConversation, alias: "image", assetId: "asset-tarla", mimeType: "image/png", width: 1080, height: 1350, filename: "tarla.jpg", messageId: "m-h1", createdAt: ago(60 * 26 + 10), updatedAt: ago(60 * 26 + 10)),
            ConversationAlias(id: "alias-depo", conversationId: Self.hasatConversation, alias: "image-1", assetId: "asset-depo", mimeType: "image/png", width: 1080, height: 1350, filename: "depo.jpg", messageId: "m-h1", createdAt: ago(60 * 26 + 10), updatedAt: ago(60 * 26 + 10)),
        ]
        aliases = [Self.hasatConversation: hasatAliases]
        let hasatText = "Hasat serisi için dört post hazırla. @image tarladan, @image-1 depodan; ilk postta @image kullan."
        let hasatMentions = MentionText.resolve(hasatText, aliases: hasatAliases.map(MentionText.Target.init))

        // MARK: Messages

        func user(_ id: String, _ conversation: String, _ parts: [MessagePart], minutesAgo: Double) -> Message {
            Message(id: id, conversationId: conversation, role: .user, parts: parts, createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo))
        }
        func assistant(_ id: String, _ conversation: String, _ parts: [MessagePart], minutesAgo: Double, run: String) -> Message {
            Message(id: id, conversationId: conversation, role: .assistant, runId: run, parts: parts, createdAt: ago(minutesAgo), updatedAt: ago(minutesAgo))
        }
        messages = [
            Self.kasimConversation: [
                user("m-k1", Self.kasimConversation, [.text("MTM için bu ayın postlarını üret, resimleri ben yükleyeceğim.")], minutesAgo: 8),
                assistant("m-k2", Self.kasimConversation, [
                    .toolStep(ToolStepPart(id: "ts-profile", name: "get_brand_profile", label: "Marka profili okundu", state: .done, summary: "MTM Agro · bitki besleme")),
                    .toolStep(ToolStepPart(id: "ts-plan", name: "propose_plan", label: "İçerik planı hazırlandı", state: .done, summary: "12 post · Kasım")),
                    .text("Kasım için 12 post hazırladım. 6 tanesinde görsel yerini boş bıraktım."),
                    .planProposal(planId: Self.kasimPlan),
                ], minutesAgo: 6, run: "run-kasim"),
            ],
            Self.lansmanConversation: [
                user("m-l1", Self.lansmanConversation, [.text("Venta Borinc lansmanı için üç post hazırlayalım.")], minutesAgo: 75),
                assistant("m-l2", Self.lansmanConversation, [
                    .toolStep(ToolStepPart(id: "ts-lansman", name: "list_contents", label: "Mevcut içerikler incelendi", state: .done, summary: "Kasım takvimi")),
                    .text("Lansman için üç post öneriyorum: duyuru, ürün detayı ve bayi listesi. Başlamadan önce bir şeyi netleştirelim."),
                    .question(QuestionPart(
                        questionId: "launch-date", prompt: "Lansman hangi gün yayına girsin?", mode: .single,
                        options: [QuestionOption(id: "nov-20", label: "20 Kasım"), QuestionOption(id: "nov-25", label: "25 Kasım"), QuestionOption(id: "dec-1", label: "1 Aralık")],
                        allowText: true)),
                ], minutesAgo: 70, run: "run-lansman"),
            ],
            Self.hasatConversation: [
                {
                    var message = user("m-h1", Self.hasatConversation, [
                        .attachment(AttachmentPart(assetId: "asset-tarla", mimeType: "image/png", width: 1080, height: 1350, filename: "tarla.jpg", alias: "image", aliasId: "alias-tarla")),
                        .attachment(AttachmentPart(assetId: "asset-depo", mimeType: "image/png", width: 1080, height: 1350, filename: "depo.jpg", alias: "image-1", aliasId: "alias-depo")),
                        .text(hasatText),
                    ], minutesAgo: 60 * 26 + 10)
                    message.mentions = hasatMentions
                    return message
                }(),
                assistant("m-h2", Self.hasatConversation, [
                    .toolStep(ToolStepPart(id: "ts-assets", name: "inspect_assets", label: "Görseller incelendi", state: .done, summary: "@image, @image-1")),
                    .text("Tamam. Kapak postunu @image ile, saklama ipucunu @image-1 ile hazırlıyorum."),
                    .progress(ProgressPart(stepId: "posts", label: "Postlar hazırlanıyor", state: .done, current: 4, total: 4)),
                ], minutesAgo: 60 * 26, run: "run-hasat"),
            ],
            "c-bayi": [
                user("m-b1", "c-bayi", [.text("Bayilere kasım kampanyası için kısa bir duyuru yaz ve onaya sun.")], minutesAgo: 60 * 50 + 5),
                assistant("m-b2", "c-bayi", [
                    .toolStep(ToolStepPart(id: "ts-draft", name: "draft_caption", label: "Duyuru metni hazırlandı", state: .done)),
                    .text("Değerli bayimiz, kasım boyunca Venta Borinc siparişlerinde ikinci paletten itibaren yüzde 5 indirim uyguluyoruz. Ayrıntılar için bölge sorumlunuzla görüşebilirsiniz."),
                    .consent(ConsentPart(consentId: "consent-bayi-1", tool: "approve_content", title: "Postu onayla", detail: "Bayi buluşması · Instagram, Facebook", state: .pending)),
                ], minutesAgo: 60 * 50, run: "run-bayi"),
            ],
        ]
    }

    /// A small slide document following the design contract; never rendered by the apps.
    public static func slideHTML(title: String, pillar: String, emptySlot: Bool) -> String {
        let slot = emptySlot
            ? "<div data-layer=\"photo\" data-type=\"slot\" data-slot-ratio=\"1:1\" data-slot-state=\"empty\" data-slot-label=\"Ürün fotoğrafı\" style=\"position:absolute;left:72px;top:400px;width:936px;height:936px\"></div>"
            : ""
        return """
        <!doctype html><html lang="tr"><head><meta charset="utf-8"></head>
        <body data-artboard="1080x1350" style="margin:0;width:1080px;height:1350px">
        <p data-layer="eyebrow" data-type="text">\(TurkishFormat.upper(pillar))</p>
        <h1 data-layer="title" data-type="text">\(TurkishFormat.upper(title))</h1>
        \(slot)
        </body></html>
        """
    }
}
