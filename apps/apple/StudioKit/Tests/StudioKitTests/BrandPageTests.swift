import Foundation
import Testing
@testable import StudioKit

/// The phone's brand page: skills, templates, check and special-day settings (API shapes, the
/// sample backend, and the rules ported from the desktop's brand-model.ts).
@Suite("Brand page")
struct BrandPageTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8787/")!, session: session), host)
    }

    @Test func skillsDecodeAndUpdatesSendOnlyWhatChanged() async throws {
        let list = #"""
        {"items":[{"id":"s1","brandId":"b1","name":"tek-gorsel","description":"Tek görsel","body":"# Başlık","enabled":false,"version":3,"origin":"ai_draft","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}],"nextCursor":null}
        """#
        let (api, host) = client { request, _ in
            if request.httpMethod == "PATCH" {
                return .init(status: 200, body: Data(##"{"id":"s1","brandId":"b1","name":"tek-gorsel","description":"Tek görsel","body":"# Başlık","enabled":true,"version":3,"origin":"manual","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}"##.utf8))
            }
            return .init(status: 200, body: Data(list.utf8))
        }
        let skills = try await api.brandSkills(brandId: "b1")
        #expect(skills.first?.origin == .aiDraft)
        #expect(skills.first.map(BrandSkillRules.meta) == "v3 · AI taslağı · kapalı")
        let saved = try await api.updateBrandSkill(brandId: "b1", id: "s1", BrandSkillUpdate(enabled: true))
        #expect(saved.enabled)
        let (patch, body) = try #require(StubURLProtocol.recorded(host: host).last)
        #expect(patch.url?.path == "/api/brands/b1/skills/s1")
        #expect(String(decoding: body, as: UTF8.self) == #"{"enabled":true}"#)
    }

    @Test func skillRules() {
        #expect(BrandSkillRules.uniqueName("Carousel Formatı", taken: ["carousel-formati"]) == "carousel-formati-2")
        #expect(BrandSkillRules.problem(name: "Kötü Ad", description: "", body: "x", otherNames: []) != nil)
        #expect(BrandSkillRules.problem(name: "iyi-ad", description: "", body: "x", otherNames: ["iyi-ad"])?.contains("zaten") == true)
        #expect(BrandSkillRules.problem(name: "iyi-ad", description: "", body: "  ", otherNames: []) == "Skill metni boş olamaz.")
        #expect(BrandSkillRules.problem(name: "iyi-ad", description: "", body: "# Metin", otherNames: []) == nil)
        #expect(BrandSkillRules.draftPayload(focus: "  ") == [:])
        #expect(BrandSkillRules.draftBlocker(archived: false, workerOnline: false, count: 1) != nil)
    }

    @Test func templatesDecodeWithoutTheCanvasDocument() throws {
        let json = #"""
        {"id":"t1","brandId":"b1","name":"Ürün","description":"","kind":"canvas","contentType":"carousel","width":1080,"height":1350,"slideCount":4,
         "fields":[{"key":"headline","label":"Başlık","kind":"text","role":"headline","slide":0,"layer":"h","nodeId":"1:2","layerType":"text","example":"Kış","maxChars":20,"minFontSize":null,"multiline":false,"ratio":null,"metrics":null,"autoFit":true,"locked":false},
                   {"key":"slot","label":"Görsel","kind":"image","role":null,"slide":0,"layer":"s","nodeId":null,"layerType":"slot","example":"/media/a.png","maxChars":null,"minFontSize":null,"multiline":false,"ratio":"4:5","metrics":null,"autoFit":false,"locked":true}],
         "previewAssetIds":[null,"a2"],"source":{"contentId":null,"version":2,"title":"Kış"},"editorDocument":{"anything":1},"useCount":0,
         "createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}
        """#
        let template = try StudioJSON.decoder().decode(ContentTemplate.self, from: Data(json.utf8))
        #expect(template.previewAssetId == "a2")
        #expect(template.fillableFields().map(\.key) == ["headline"])
        #expect(TemplateRules.line(template) == "Carousel · 4 kare · 1080×1350 · 1 alan · tuval")
        #expect(TemplateRules.uses(template) == "Henüz kullanılmadı")

        var form = TemplateRules.FillForm(template: template)
        #expect(TemplateRules.problem(form) == "En az bir alanı doldur ya da AI doldursun.")
        form.values = ["headline": "  Yeni  ", "slot": "x"]
        form.images = ["slot": "asset-1"]
        #expect(TemplateRules.problem(form) == nil)
        let input = TemplateRules.useInput(template, form)
        #expect(input.values == ["headline": "Yeni"])
        #expect(input.images == nil)
        #expect(input.brief == nil)
        form.mode = .ai
        #expect(TemplateRules.problem(form) == "AI'ın ne yazacağını (konu) yaz.")
    }

    @Test func settingsPutsAndBayramRows() async throws {
        let settings = BrandCheckSettings(brandId: "b", disabledChecks: ["text.hashtags", "eski.kontrol"], strictness: .unknown)
        #expect(settings.put.disabledChecks == ["text.hashtags"])
        #expect(settings.put.strictness == .standard)
        #expect(CheckCatalog.addBannedWords(["Bedava"], typed: "bedava, garantili,  1 numara ") == ["Bedava", "garantili", "1 numara"])
        #expect(CheckCatalog.toggle(["a"], checks: ["a", "b"], on: false) == ["a", "b"])
        #expect(CheckCatalog.toggle(["a", "b", "c"], checks: ["a", "b"], on: true) == ["c"])
        #expect(CheckCatalog.byCategory.count == 6)

        let put = BrandPlanningSettingsPut(tags: [.gida, .tarim], disabled: [.ticari])
        #expect(put.sectorTags == [.tarim, .gida])
        #expect(put.disabledCategories == [.ticari])

        let days = [
            SpecialDay(id: "r", ruleId: "ramazan-bayrami", date: "2027-03-09", name: "R", category: .dini),
            SpecialDay(id: "k", ruleId: "kurban-bayrami", date: "2027-05-16", name: "K", category: .dini, approximate: true),
        ]
        let row = BayramYear.from(year: 2027, days: days, overrides: [ReligiousDayOverride(year: 2027, kurbanBayrami: "2027-05-17")])
        #expect(row.ramazan == "2027-03-09")
        #expect(row.kurban == "2027-05-17")
        #expect(row.kurbanCorrected && !row.ramazanCorrected)
        let cleared = BayramYear.setting(.kurban, of: 2027, to: nil, in: [ReligiousDayOverride(year: 2027, kurbanBayrami: "2027-05-17")])
        #expect(cleared.isEmpty)
        let encoded = String(decoding: try JSONEncoder().encode(ReligiousDayOverride(year: 2027, ramazanBayrami: "2027-03-10")), as: UTF8.self)
        #expect(encoded.contains(#""kurbanBayrami":null"#))
    }

    @Test func overviewAndTokenRows() {
        let now = Date()
        let brand = Brand(id: "b", name: "MTM Agro", slug: "mtm-agro", createdAt: now, updatedAt: now)
        let profile = BrandProfile(
            id: "p", brandId: "b", version: 3, status: .approved, isCurrent: true,
            tokens: [
                "color": .object(["accent": .object(["value": .string("#ff6a00"), "use": .string("vurgu")]), "ink": .string("#0A0A0A")]),
                "font": .object(["display": .object(["family": .string("Archivo"), "files": .array([.string("a")])])]),
                "space": .object(["margin": .number(72)]),
            ],
            voice: "# Ton\n\n- Sade konuş.", createdAt: now, updatedAt: now)
        let accounts = [
            SocialAccount(id: "a", brandId: "b", platform: .instagram, handle: "mtmagro", status: .connected, createdAt: now, updatedAt: now, tokenHealth: .valid),
            SocialAccount(id: "c", brandId: "b", platform: .facebook, handle: "MTM", status: .needsReauth, createdAt: now, updatedAt: now),
        ]
        let card = BrandOverview(brand: brand, kit: nil, profile: profile, accounts: accounts)
        #expect(card.initials == "MA")
        #expect(card.subtitle == "mtm-agro · Türkçe")
        #expect(card.profileLine == "Onaylı profil · v3")
        #expect(card.swatches.map(\.hex) == ["#0A0A0A", "#FF6A00"])
        #expect(card.fonts == ["Archivo (Başlık)"])
        #expect(card.voice == "Ton Sade konuş.")
        #expect(card.platforms.map(\.value) == ["@mtmagro", "Yeniden bağla", "Bağlı değil"])
        #expect(BrandOverview.platformsSummary(card.platforms).text == "Facebook yeniden bağlanmalı")

        let rows = BrandTokens.rows(profile.tokens)
        #expect(rows.map(\.group) == [.colors, .colors, .fonts, .spacing])
        let accent = rows[1]
        guard case .success(let changed) = BrandTokens.set(profile.tokens, row: accent, value: "#00ff00") else {
            Issue.record("refused")
            return
        }
        #expect(BrandTokens.rows(changed)[1].value == "#00FF00")
        guard case .failure = BrandTokens.set(profile.tokens, row: accent, value: "yeşil") else {
            Issue.record("accepted a bad colour")
            return
        }

        guard case .success(let create) = BrandOverview.newBrandInput(name: "Çiftçi Dostu", slug: "", language: "tr") else {
            Issue.record("refused")
            return
        }
        #expect(create.slug == "ciftci-dostu")
        guard case .failure = BrandOverview.newBrandInput(name: "A", slug: "Kötü Ad", language: "tr") else {
            Issue.record("accepted a bad slug")
            return
        }
        #expect(BrandKitRules.problem(BrandKitPut(palette: [BrandKitColor(name: "a", hex: "#FF6A00"), BrandKitColor(name: "a", hex: "#000000")]))?.contains("iki renkte") == true)
        #expect(BrandKitRules.nextColorName([BrandKitColor(name: "renk-1", hex: "#000000")]) == "renk-2")
    }

    @Test func sampleBackendKeepsTheBrandPage() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let skills = try await backend.brandSkills(brandId: SampleData.mtm)
        #expect(skills.count == 2)
        let edited = try await backend.updateBrandSkill(brandId: SampleData.mtm, id: skills[0].id, BrandSkillUpdate(body: "# Yeni"))
        #expect(edited.version == skills[0].version + 1)
        let restored = try await backend.restoreBrandSkillVersion(brandId: SampleData.mtm, skillId: skills[0].id, version: 1)
        #expect(restored.origin == .restore)
        let job = try await backend.draftBrandSkill(brandId: SampleData.mtm, focus: "Reels kapağı")
        #expect(job.type == .brandSkillDraft)
        #expect(try await backend.brandSkills(brandId: SampleData.mtm).last?.enabled == false)

        let templates = try await backend.templates(brandId: SampleData.mtm)
        let result = try await backend.useTemplate(templates[0].id, TemplateUse(title: "Deneme", values: ["headline": "Merhaba"], fill: .manual))
        #expect(result.content.title == "Deneme")
        #expect(try await backend.templates(brandId: SampleData.mtm)[0].useCount == templates[0].useCount + 1)

        let overrides = try await backend.saveSpecialDayOverrides([ReligiousDayOverride(year: 2027, ramazanBayrami: "2027-03-10")])
        let days = try await backend.specialDays(from: "2027-01-01", to: "2027-12-31")
        let row = BayramYear.from(year: 2027, days: days, overrides: overrides.overrides)
        #expect(row.ramazan == "2027-03-10")
        #expect(row.ramazanCorrected)
    }
}
