import Foundation
import Testing
@testable import Studio

/// The Swift models are hand-written; these tests compare them with the
/// OpenAPI document the API serves (Fixtures/openapi.json, captured by
/// scripts/capture-fixtures.sh). Re-capture after an API change and these
/// fail where the mirror drifted.
@Suite("Models match /api/openapi.json")
struct OpenAPIDriftTests {
    private static var schemas: [String: [String: Any]] {
        guard let data = try? Fixture.data("openapi"),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let components = root["components"] as? [String: Any],
              let schemas = components["schemas"] as? [String: [String: Any]]
        else { return [:] }
        return schemas
    }

    /// Schema name → a decoded sample of the Swift mirror.
    private static func samples() throws -> [(String, Any)] {
        [
            ("Brand", try Fixture.decode(Brand.self, "brand")),
            ("SocialAccount", try Fixture.decode(SocialAccount.self, "social-account")),
            ("Asset", try Fixture.decode(Asset.self, "asset")),
            ("Content", try Fixture.decode(Content.self, "content-approved")),
            ("ContentVersionRef", try #require(try Fixture.decode(Content.self, "content-approved").currentVersion)),
            ("ContentApproval", try #require(try Fixture.decode(Content.self, "content-approved").approval)),
            ("ContentVersion", try Fixture.decode(ContentVersion.self, "version")),
            ("ContentVersionSummary", try Fixture.decode(ContentVersion.self, "version").summary),
            ("Slide", try Fixture.decode(ContentVersion.self, "version").slides[0]),
            ("Job", try Fixture.decode(Job.self, "job-created")),
            ("WorkerPresence", try Fixture.decode(WorkerPresence.self, "presence")),
            ("ConnectedWorker", ConnectedWorker(workerId: "w", workerVersion: nil, capabilities: [], concurrency: 1,
                                                connectedAt: .now, lastSeenAt: .now, draining: false)),
            ("PresenceJob", PresenceJob(id: "j", type: .demoEcho)),
            ("Schedule", try Fixture.decode(Schedule.self, "schedule")),
            ("HealthResponse", try Fixture.decode(HealthResponse.self, "health")),
        ]
    }

    @Test func documentIsPresent() {
        #expect(Self.schemas.count > 20)
    }

    @Test func entityPropertiesMatch() throws {
        for (name, sample) in try Self.samples() {
            let schema = try #require(Self.schemas[name], "schema \(name) missing from openapi.json")
            let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
            let required = Set(schema["required"] as? [String] ?? [])

            let mirror = Mirror(reflecting: sample)
            var swift: [String: Bool] = [:] // name → isOptional
            for child in mirror.children {
                guard let label = child.label else { continue }
                swift[label] = Mirror(reflecting: child.value).displayStyle == .optional
            }
            #expect(Set(swift.keys) == Set(properties.keys), "\(name): Swift \(swift.keys.sorted()) vs OpenAPI \(properties.keys.sorted())")
            for (property, spec) in properties {
                guard let isOptional = swift[property] else { continue }
                let shouldBeOptional = !required.contains(property) || Self.isNullable(spec)
                #expect(isOptional == shouldBeOptional, "\(name).\(property): optional \(isOptional), expected \(shouldBeOptional)")
            }
        }
    }

    @Test(arguments: [
        ("Platform", Platform.knownCases.map(\.rawValue)),
        ("BrandStatus", BrandStatus.knownCases.map(\.rawValue)),
        ("SocialAccountStatus", SocialAccountStatus.knownCases.map(\.rawValue)),
        ("AssetKind", AssetKind.knownCases.map(\.rawValue)),
        ("AssetSource", AssetSource.knownCases.map(\.rawValue)),
        ("ContentType", ContentType.knownCases.map(\.rawValue)),
        ("ContentStatus", ContentStatus.knownCases.map(\.rawValue)),
        ("ContentVersionOrigin", ContentVersionOrigin.knownCases.map(\.rawValue)),
        ("JobType", JobType.knownCases.map(\.rawValue)),
        ("JobStatus", JobStatus.knownCases.map(\.rawValue)),
        ("ScheduleStatus", ScheduleStatus.knownCases.map(\.rawValue)),
        ("ErrorCode", APIErrorCode.knownCases.map(\.rawValue)),
    ])
    func enumValuesMatch(name: String, swift: [String]) throws {
        let schema = try #require(Self.schemas[name], "enum \(name) missing")
        let values = try #require(schema["enum"] as? [String])
        #expect(Set(values) == Set(swift), "\(name): OpenAPI \(values) vs Swift \(swift)")
    }

    @Test func requestBodiesUseContractFieldNames() throws {
        func keys(_ value: some Encodable) throws -> Set<String> {
            let data = try StudioJSON.encoder().encode(value)
            return Set((try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]).keys)
        }
        func schemaKeys(_ name: String) -> Set<String> {
            Set((Self.schemas[name]?["properties"] as? [String: Any] ?? [:]).keys)
        }
        let full: [(String, Set<String>)] = [
            ("ContentCreate", try keys(ContentCreate(brandId: "b", type: .post, title: "t", brief: "", targetPlatforms: [], caption: ""))),
            ("ContentUpdate", try keys(ContentUpdate(title: "t", brief: "b", caption: "c", targetPlatforms: []))),
            ("ContentApprove", try keys(ContentApprove(hash: "h"))),
            ("ContentTransition", try keys(ContentTransition(to: .draft))),
            ("JobCreate", try keys(JobCreate(type: .contentGenerate, payload: [:], brandId: "b", contentId: "c"))),
            ("ScheduleCreate", try keys(ScheduleCreate(contentId: "c", socialAccountId: "a", platform: .instagram, scheduledAt: .now))),
        ]
        for (name, swiftKeys) in full {
            #expect(swiftKeys.isSubset(of: schemaKeys(name)), "\(name): \(swiftKeys) not in \(schemaKeys(name))")
        }
    }

    @Test func pathsUsedByTheAppExist() throws {
        let data = try Fixture.data("openapi")
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let paths = try #require(root["paths"] as? [String: [String: Any]])
        let used: [(String, String)] = [
            ("get", "/api/health"), ("get", "/api/brands"), ("get", "/api/social-accounts"),
            ("get", "/api/contents"), ("post", "/api/contents"), ("get", "/api/contents/{id}"),
            ("patch", "/api/contents/{id}"), ("post", "/api/contents/{id}/approve"),
            ("post", "/api/contents/{id}/transition"), ("get", "/api/contents/{id}/versions"),
            ("get", "/api/contents/{id}/versions/{version}"), ("get", "/api/assets/{id}"),
            ("get", "/api/assets/{id}/content"), ("post", "/api/assets"), ("get", "/api/jobs"),
            ("post", "/api/jobs"), ("get", "/api/jobs/{id}"), ("post", "/api/jobs/{id}/cancel"),
            ("get", "/api/jobs/stream"), ("get", "/api/workers/presence"), ("get", "/api/schedules"),
            ("post", "/api/schedules"), ("post", "/api/schedules/{id}/cancel"),
        ]
        for (method, path) in used {
            #expect(paths[path]?[method] != nil, "\(method.uppercased()) \(path) missing")
        }
    }

    private static func isNullable(_ spec: [String: Any]) -> Bool {
        if spec["nullable"] as? Bool == true { return true }
        if let types = spec["type"] as? [String], types.contains("null") { return true }
        for key in ["anyOf", "oneOf"] {
            if let options = spec[key] as? [[String: Any]],
               options.contains(where: { ($0["type"] as? String) == "null" }) {
                return true
            }
        }
        return false
    }
}
