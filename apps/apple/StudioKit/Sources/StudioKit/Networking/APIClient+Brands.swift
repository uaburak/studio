import Foundation

// The rest of the desktop's brand page (packages/contract/src/client.ts): skills, templates,
// check settings, special-day settings and bayram corrections. Brands, kits and profiles are in
// APIClient.swift.

extension APIClient {
    // MARK: Skills (`/api/brands/{brandId}/skills`)

    /// Oldest first.
    public func brandSkills(brandId: EntityID) async throws(StudioAPIError) -> [BrandSkill] {
        try await all(BrandSkill.self, "/api/brands/\(Self.enc(brandId))/skills")
    }

    public func createBrandSkill(brandId: EntityID, _ input: BrandSkillCreate) async throws(StudioAPIError) -> BrandSkill {
        try await send(BrandSkill.self, .post, "/api/brands/\(Self.enc(brandId))/skills", body: input)
    }

    public func updateBrandSkill(brandId: EntityID, id: EntityID, _ input: BrandSkillUpdate) async throws(StudioAPIError) -> BrandSkill {
        try await send(BrandSkill.self, .patch, "/api/brands/\(Self.enc(brandId))/skills/\(Self.enc(id))", body: input)
    }

    /// The skill and all of its versions, for good.
    public func deleteBrandSkill(brandId: EntityID, id: EntityID) async throws(StudioAPIError) {
        let request = try await makeRequest(.delete, "/api/brands/\(Self.enc(brandId))/skills/\(Self.enc(id))")
        _ = try await data(for: request)
    }

    /// Newest first.
    public func brandSkillVersions(brandId: EntityID, skillId: EntityID) async throws(StudioAPIError) -> [BrandSkillVersion] {
        try await all(BrandSkillVersion.self, "/api/brands/\(Self.enc(brandId))/skills/\(Self.enc(skillId))/versions")
    }

    /// Stores that version's text as a new current version.
    public func restoreBrandSkillVersion(brandId: EntityID, skillId: EntityID, version: Int) async throws(StudioAPIError) -> BrandSkill {
        try await send(BrandSkill.self, .post, "/api/brands/\(Self.enc(brandId))/skills/\(Self.enc(skillId))/versions/\(version)/restore")
    }

    /// "AI ile çıkar": a `brand.skill_draft` job; the drafted skill arrives switched off.
    public func draftBrandSkill(brandId: EntityID, focus: String) async throws(StudioAPIError) -> Job {
        try await createJob(JobCreate(type: .brandSkillDraft, payload: BrandSkillRules.draftPayload(focus: focus), brandId: brandId))
    }

    // MARK: Templates (N9)

    /// Newest first.
    public func templates(brandId: EntityID) async throws(StudioAPIError) -> [ContentTemplate] {
        try await all(ContentTemplate.self, "/api/brands/\(Self.enc(brandId))/templates")
    }

    public func updateTemplate(_ id: EntityID, _ input: ContentTemplateUpdate) async throws(StudioAPIError) -> ContentTemplate {
        try await send(ContentTemplate.self, .patch, "/api/templates/\(Self.enc(id))", body: input)
    }

    /// Posts made from it keep their design; only the link goes.
    public func deleteTemplate(_ id: EntityID) async throws(StudioAPIError) {
        let request = try await makeRequest(.delete, "/api/templates/\(Self.enc(id))")
        _ = try await data(for: request)
    }

    /// A new draft post from the template; a `content.generate` job fills it.
    public func useTemplate(_ id: EntityID, _ input: TemplateUse) async throws(StudioAPIError) -> TemplateUseResult {
        try await send(TemplateUseResult.self, .post, "/api/templates/\(Self.enc(id))/use", body: input)
    }

    // MARK: Check settings

    public func checkSettings(brandId: EntityID) async throws(StudioAPIError) -> BrandCheckSettings {
        try await get(BrandCheckSettings.self, "/api/brands/\(Self.enc(brandId))/check-settings")
    }

    public func putCheckSettings(brandId: EntityID, _ input: BrandCheckSettingsPut) async throws(StudioAPIError) -> BrandCheckSettings {
        try await send(BrandCheckSettings.self, .put, "/api/brands/\(Self.enc(brandId))/check-settings", body: input)
    }

    // MARK: Special days (N5)

    public func planningSettings(brandId: EntityID) async throws(StudioAPIError) -> BrandPlanningSettings {
        try await get(BrandPlanningSettings.self, "/api/brands/\(Self.enc(brandId))/planning-settings")
    }

    public func putPlanningSettings(brandId: EntityID, _ input: BrandPlanningSettingsPut) async throws(StudioAPIError) -> BrandPlanningSettings {
        try await send(BrandPlanningSettings.self, .put, "/api/brands/\(Self.enc(brandId))/planning-settings", body: input)
    }

    /// Special days between two `YYYY-MM-DD` dates (every brand's view: no sector filter).
    public func specialDays(from: String, to: String, brandId: EntityID? = nil) async throws(StudioAPIError) -> [SpecialDay] {
        try await get(SpecialDayList.self, "/api/special-days", query: ["from": from, "to": to, "brandId": brandId]).days
    }

    public func specialDayOverrides() async throws(StudioAPIError) -> SpecialDayOverrides {
        try await get(SpecialDayOverrides.self, "/api/special-days/overrides")
    }

    public func putSpecialDayOverrides(_ overrides: [ReligiousDayOverride]) async throws(StudioAPIError) -> SpecialDayOverrides {
        try await send(SpecialDayOverrides.self, .put, "/api/special-days/overrides", body: SpecialDayOverridesPut(overrides: overrides))
    }
}

struct SpecialDayOverridesPut: Encodable {
    var overrides: [ReligiousDayOverride]
}
